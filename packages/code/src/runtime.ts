import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { BridgeAssignment } from './protocol.js';

export const RUNTIME_SESSION_PLACEHOLDER = '{runtimeSessionId}';

export interface RuntimeLease {
  endpoint?: string;
  sessionId?: string;
  execute?(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResponse>;
  release?(): Promise<void>;
}

export interface RuntimeExecutionRequest {
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface RuntimeExecutionResponse {
  status: number;
  body: string;
}

export interface RuntimeSupervisor {
  acquire(assignment: BridgeAssignment, signal?: AbortSignal): Promise<RuntimeLease>;
  reset(runtimeSessionId: string, signal?: AbortSignal): Promise<void>;
  quarantine(runtimeSessionId: string, reason: string, cause?: unknown): Promise<void>;
}

export interface EndpointRuntimeSupervisorOptions {
  endpoint: string;
  statefulWorkspace: boolean;
}

export interface ContainerRuntimeClient {
  run(args: string[], options?: ContainerRuntimeRunOptions): Promise<string>;
}

export interface ContainerRuntimeRunOptions {
  input?: string;
  signal?: AbortSignal;
}

export interface DockerRuntimeSupervisorOptions {
  image?: string;
  capabilities?: string[];
  securityOptions?: string[];
  environment?: Record<string, string>;
  bindMounts?: DockerRuntimeBindMount[];
  httpClient?: 'curl' | 'bun';
  dockerCommand?: string;
  runnerPort?: number;
  startupTimeoutMs?: number;
  healthPath?: string;
  client?: ContainerRuntimeClient;
}

export interface DockerRuntimeBindMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

const DEFAULT_RUNNER_PORT = 2000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_PATH = '/api/v2/health';
const CONTAINER_PREFIX = 'librechat-code-';
const CAPABILITY_PATTERN = /^[A-Z_]{1,32}$/;
const MAX_DOCKER_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

function normalizedEndpoint(value: string): string {
  return value.replace(/\/+$/, '');
}

function assignmentSessionId(assignment: BridgeAssignment): string | undefined {
  if (assignment.runtimeSessionId != null) return assignment.runtimeSessionId;
  if (assignment.assignmentId.length === 0) return undefined;
  return `assignment-${assignment.assignmentId}`;
}

function containerSuffix(runtimeSessionId: string): string {
  return createHash('sha256').update(runtimeSessionId).digest('hex').slice(0, 24);
}

function containerName(runtimeSessionId: string): string {
  return `${CONTAINER_PREFIX}${containerSuffix(runtimeSessionId)}`;
}

function isMissingContainerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:no such container|no such object)/i.test(error.message);
}

class DockerCliClient implements ContainerRuntimeClient {
  private readonly command: string;

  constructor(command = 'docker') {
    this.command = command;
  }

  async run(args: string[], options: ContainerRuntimeRunOptions = {}): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const process = spawn(this.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const append = (chunks: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_DOCKER_COMMAND_OUTPUT_BYTES) {
          process.kill('SIGKILL');
          reject(new Error('Docker runtime command exceeded its output limit'));
          return;
        }
        chunks.push(chunk);
      };
      process.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      process.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      process.stdin.once('error', reject);
      process.once('error', reject);
      process.once('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        const detail = Buffer.concat(stderr).toString('utf8').slice(0, 4096);
        reject(new Error(`Docker runtime command exited ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`));
      });
      process.stdin.end(options.input);
    });
  }
}

/**
 * Local OCI runtime adapter. The supervisor, not the sandbox container, talks
 * to Docker. Each runtime has no network, and the trusted worker reaches its
 * loopback API through Docker exec; stateful containers survive leases until
 * reset or quarantine.
 */
export class DockerRuntimeSupervisor implements RuntimeSupervisor {
  private readonly client: ContainerRuntimeClient;
  private readonly runnerPort: number;
  private readonly startupTimeoutMs: number;
  private readonly healthPath: string;
  private readonly capabilities: string[];
  private readonly securityOptions: string[];
  private readonly environment: Record<string, string>;
  private readonly bindMounts: DockerRuntimeBindMount[];
  private readonly httpClient: 'curl' | 'bun';

  constructor(private readonly options: DockerRuntimeSupervisorOptions) {
    if (options.image != null && options.image.trim().length === 0) {
      throw new Error('Docker runtime image cannot be empty');
    }
    if (options.capabilities?.some((capability) => !CAPABILITY_PATTERN.test(capability))) {
      throw new Error('Docker runtime capabilities must be uppercase capability names');
    }
    this.client = options.client ?? new DockerCliClient(options.dockerCommand);
    this.runnerPort = options.runnerPort ?? DEFAULT_RUNNER_PORT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
    this.capabilities = [...(options.capabilities ?? [])];
    this.securityOptions = [...(options.securityOptions ?? [])];
    this.environment = { ...options.environment };
    this.bindMounts = (options.bindMounts ?? []).map((mount) => ({ ...mount }));
    this.httpClient = options.httpClient ?? 'curl';
    if (
      this.bindMounts.some(
        ({ source, target }) =>
          !source.startsWith('/') ||
          !target.startsWith('/') ||
          source.includes(',') ||
          target.includes(','),
      )
    ) {
      throw new Error('Docker runtime bind mounts require absolute comma-free sources and targets');
    }
  }

  async acquire(assignment: BridgeAssignment, signal?: AbortSignal): Promise<RuntimeLease> {
    const sessionId = assignmentSessionId(assignment);
    if (sessionId == null) throw new Error('Runtime assignment ID is required');
    const name = containerName(sessionId);
    let created = false;
    try {
      created = await this.ensureContainer(name, sessionId, signal);
      await this.waitForHealth(name, signal);
      return {
        sessionId,
        execute: async (request) => this.execute(name, request),
        release: assignment.runtimeSessionId == null ? async () => this.remove(name) : undefined,
      };
    } catch (error) {
      if (created || assignment.runtimeSessionId == null) await this.remove(name);
      throw error;
    }
  }

  async reset(runtimeSessionId: string, signal?: AbortSignal): Promise<void> {
    await this.remove(containerName(runtimeSessionId), signal);
  }

  async quarantine(
    runtimeSessionId: string,
    _reason: string,
    _cause?: unknown,
  ): Promise<void> {
    await this.remove(containerName(runtimeSessionId));
  }

  private async ensureContainer(
    name: string,
    runtimeSessionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const image = this.options.image?.trim();
    if (!image) throw new Error('Docker runtime image is required for acquisition');
    const running = await this.containerRunning(name, signal);
    if (running) return false;
    if (running === false) {
      await this.client.run(['start', name], { signal });
      return false;
    }
    await this.client.run(
      [
        'run',
        '--detach',
        '--name',
        name,
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        ...this.capabilities.flatMap((capability) => ['--cap-add', capability]),
        '--security-opt',
        'no-new-privileges:true',
        ...this.securityOptions.flatMap((option) => ['--security-opt', option]),
        ...this.bindMounts.flatMap(({ source, target, readOnly }) => [
          '--mount',
          `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`,
        ]),
        '--label',
        'com.librechat.code.runtime=true',
        '--label',
        `com.librechat.code.runtime-hash=${containerSuffix(runtimeSessionId)}`,
        ...Object.entries(this.environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        '--env',
        'SANDBOX_SESSION_WORKSPACE_ENABLED=true',
        image,
      ],
      { signal },
    );
    return true;
  }

  private async containerRunning(name: string, signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      const value = await this.client.run(
        ['container', 'inspect', '--format', '{{.State.Running}}', name],
        { signal },
      );
      return value.trim() === 'true';
    } catch (error) {
      if (isMissingContainerError(error)) return undefined;
      throw error;
    }
  }

  private async waitForHealth(name: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const healthUrl = `http://127.0.0.1:${this.runnerPort}${this.healthPath}`;
        const status = await this.client.run(
          this.httpClient === 'bun'
            ? [
                'exec',
                name,
                'bun',
                '-e',
                'const r=await fetch(process.argv.at(-2),{signal:AbortSignal.timeout(Number(process.argv.at(-1)))});process.stdout.write(String(r.status));',
                healthUrl,
                String(remainingMs),
              ]
            : [
                'exec',
                name,
                'curl',
                '--silent',
                '--show-error',
                '--max-time',
                (remainingMs / 1000).toFixed(3),
                '--output',
                '/dev/null',
                '--write-out',
                '%{http_code}',
                healthUrl,
              ],
          { signal },
        );
        if (status.trim() === '200') return;
        lastError = new Error(`Runtime health check returned HTTP ${status.trim() || 'unknown'}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Docker runtime did not become healthy within ${this.startupTimeoutMs}ms${
        lastError instanceof Error ? `: ${lastError.message}` : ''
      }`,
    );
  }

  private async execute(
    name: string,
    request: RuntimeExecutionRequest,
  ): Promise<RuntimeExecutionResponse> {
    if (Object.entries(request.headers).some(([name, value]) => name.includes('\r') || name.includes('\n') || value.includes('\r') || value.includes('\n'))) {
      throw new Error('Runtime request headers cannot contain line breaks');
    }
    const marker = randomBytes(32).toString('hex');
    const executeUrl = `http://127.0.0.1:${this.runnerPort}/api/v2/execute`;
    const output = await this.client.run(
      this.httpClient === 'bun'
        ? [
            'exec',
            '--interactive',
            name,
            'bun',
            '-e',
            `const b=await Bun.stdin.text();const r=await fetch(process.argv.at(-2),{method:'POST',headers:JSON.parse(process.argv.at(-1)),body:b});process.stdout.write(await r.text());process.stdout.write('\\n${marker}'+r.status);`,
            executeUrl,
            JSON.stringify(request.headers),
          ]
        : [
            'exec',
            '--interactive',
            name,
            'curl',
            '--silent',
            '--show-error',
            '--request',
            'POST',
            ...Object.entries(request.headers).flatMap(([name, value]) => ['--header', `${name}: ${value}`]),
            '--data-binary',
            '@-',
            '--write-out',
            `\n${marker}%{http_code}`,
            executeUrl,
          ],
      { input: request.body, signal: request.signal },
    );
    const suffix = new RegExp(`\\n${marker}(\\d{3})$`);
    const match = output.match(suffix);
    if (match?.[1] == null) throw new Error('Docker runtime returned an invalid HTTP response');
    return {
      status: Number(match[1]),
      body: output.slice(0, -match[0].length),
    };
  }

  private async remove(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.run(['container', 'rm', '--force', name], { signal });
    } catch (error) {
      if (!isMissingContainerError(error)) throw error;
    }
  }
}

/**
 * Compatibility adapter for an already-running loopback sandbox supervisor.
 * New runtime adapters own provisioning and return the same lease shape.
 */
export class EndpointRuntimeSupervisor implements RuntimeSupervisor {
  private readonly endpoint: string;

  constructor(private readonly options: EndpointRuntimeSupervisorOptions) {
    this.endpoint = normalizedEndpoint(options.endpoint);
    if (this.endpoint.length === 0) {
      throw new Error('Runtime supervisor endpoint is required');
    }
  }

  async acquire(assignment: BridgeAssignment): Promise<RuntimeLease> {
    const sessionId = assignmentSessionId(assignment);
    if (assignment.runtimeSessionId != null) {
      if (!this.options.statefulWorkspace) {
        throw new Error('Stateful assignments require a stateful runtime supervisor');
      }
      if (!this.endpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
        throw new Error(
          'Stateful assignments require a runtime supervisor endpoint containing {runtimeSessionId}',
        );
      }
    }
    if (sessionId == null || !this.endpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
      return { endpoint: this.endpoint };
    }
    return {
      endpoint: this.endpoint.replace(
        RUNTIME_SESSION_PLACEHOLDER,
        encodeURIComponent(sessionId),
      ),
      sessionId,
    };
  }

  async reset(_runtimeSessionId: string): Promise<void> {}

  async quarantine(runtimeSessionId: string, _reason: string, _cause?: unknown): Promise<void> {
    await this.reset(runtimeSessionId);
  }
}
