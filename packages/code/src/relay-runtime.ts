import { createHash } from 'node:crypto';

import { validateFileRelayUpstream } from './relay.js';
import { DockerCliClient } from './runtime.js';

import type { ContainerRuntimeClient } from './runtime.js';

export interface DockerFileRelaySupervisorOptions {
  workerId: string;
  incarnationId: string;
  image: string;
  upstreamUrl: string;
  token: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
  dockerCommand?: string;
  startupTimeoutMs?: number;
  stagingGraceMs?: number;
  now?: () => number;
  client?: ContainerRuntimeClient;
}

export interface DockerFileRelayProfile {
  network: string;
  url: string;
  token: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STAGING_GRACE_MS = 5 * 60_000;
const TERMINAL_CONTAINER_STATES = new Set(['dead', 'exited']);

function suffix(workerId: string): string {
  return createHash('sha256').update(workerId).digest('hex').slice(0, 20);
}

function missingNetwork(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:network(?: .*?)? not found|no such network)/i.test(error.message)
  );
}

function existingNetwork(error: unknown): boolean {
  return error instanceof Error && /network .* already exists/i.test(error.message);
}

function missingContainer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:no such container|no such object)/i.test(error.message)
  );
}

export class DockerFileRelaySupervisor {
  private readonly client: ContainerRuntimeClient;
  private readonly network: string;
  private readonly egressNetwork: string;
  private readonly containerPrefix: string;
  private readonly incarnationHash: string;
  private readonly workerHash: string;
  private container: string;
  private prepared = false;
  private activeGeneration?: number;

  constructor(private readonly options: DockerFileRelaySupervisorOptions) {
    if (!options.image.trim()) {
      throw new Error('Docker file relay image is required');
    }
    if (!options.token.trim()) {
      throw new Error('Docker file relay token is required');
    }
    validateFileRelayUpstream(options.upstreamUrl);
    for (const [name, value] of [
      ['maxBytes', options.maxBytes],
      ['timeoutMs', options.timeoutMs],
      ['maxConcurrentRequests', options.maxConcurrentRequests],
      ['stagingGraceMs', options.stagingGraceMs],
    ] as const) {
      if (value != null && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Docker file relay ${name} must be a positive integer`);
      }
    }
    this.workerHash = suffix(options.workerId);
    this.incarnationHash = suffix(options.incarnationId).slice(0, 12);
    this.network = `librechat-code-relay-${this.workerHash}`;
    this.egressNetwork = `librechat-code-egress-${this.workerHash}`;
    this.containerPrefix = `librechat-code-relay-${this.workerHash}`;
    this.container = this.stagingContainer();
    this.client = options.client ?? new DockerCliClient(options.dockerCommand);
  }

  async prepare(signal?: AbortSignal): Promise<DockerFileRelayProfile> {
    await this.ensureNetwork(this.network, true, 'runtime', signal);
    await this.ensureNetwork(this.egressNetwork, false, 'egress', signal);
    await this.launchRelay(signal);
    return {
      network: this.network,
      url: 'http://relay:3000',
      token: this.options.token,
    };
  }

  async stop(signal?: AbortSignal): Promise<void> {
    await this.removeRelay(signal);
  }

  async activate(
    registrationGeneration: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(registrationGeneration) ||
      registrationGeneration < 1
    ) {
      throw new Error('Docker file relay registration generation is invalid');
    }
    let activeAndHealthy = false;
    if (this.activeGeneration === registrationGeneration) {
      try {
        await this.checkHealth(signal);
        activeAndHealthy = true;
      } catch {
        await this.removeRelay();
      }
    }
    if (!this.prepared) await this.launchRelay(signal);
    const activeContainer = `${this.containerPrefix}-g${registrationGeneration}-${this.incarnationHash}`;
    if (this.container !== activeContainer) {
      try {
        await this.renameRelay(activeContainer, signal);
      } catch (error) {
        if (!missingContainer(error)) throw error;
        this.resetPreparedState();
        await this.launchRelay(signal);
        try {
          await this.renameRelay(activeContainer, signal);
        } catch (retryError) {
          if (missingContainer(retryError)) this.resetPreparedState();
          throw retryError;
        }
      }
      this.container = activeContainer;
    }
    const containers = await this.client.run(
      [
        'container',
        'ls',
        '--all',
        '--filter',
        'label=com.librechat.code.file-relay=true',
        '--filter',
        `label=com.librechat.code.worker-hash=${this.workerHash}`,
        '--format',
        '{{.Names}}|{{.State}}|{{.Label "com.librechat.code.file-relay-staged-at"}}',
      ],
      { signal },
    );
    const olderContainers: string[] = [];
    for (const record of containers.split('\n').map((value) => value.trim())) {
      const [name, state = '', stagedAtValue = ''] = record.split('|');
      if (!name || name === this.container) continue;
      if (name.startsWith(`${this.containerPrefix}-staging-`)) {
        const stagedAt = Number(stagedAtValue);
        const staleStage =
          Number.isSafeInteger(stagedAt) &&
          stagedAt > 0 &&
          (this.options.now?.() ?? Date.now()) - stagedAt >=
            (this.options.stagingGraceMs ?? DEFAULT_STAGING_GRACE_MS);
        if (
          TERMINAL_CONTAINER_STATES.has(state.toLowerCase()) ||
          staleStage
        ) {
          olderContainers.push(name);
        }
        continue;
      }
      const candidateGeneration = this.registrationGeneration(name);
      if (candidateGeneration == null) {
        throw new Error('Docker returned an invalid stale file relay name');
      }
      if (candidateGeneration > registrationGeneration) {
        await this.removeRelay();
        throw new Error(
          'Docker file relay registration was superseded before activation',
        );
      }
      if (candidateGeneration === registrationGeneration) {
        throw new Error('Docker returned conflicting file relay registrations');
      }
      olderContainers.push(name);
    }
    for (const name of olderContainers) {
      try {
        await this.client.run(['container', 'rm', '--force', name], { signal });
      } catch (error) {
        if (!missingContainer(error)) throw error;
      }
    }
    if (activeAndHealthy) return;
    try {
      await this.client.run(
        [
          'network',
          'connect',
          '--alias',
          'relay',
          this.network,
          this.container,
        ],
        { signal },
      );
    } catch (error) {
      if (missingContainer(error)) this.resetPreparedState();
      throw error;
    }
    this.activeGeneration = registrationGeneration;
  }

  private registrationGeneration(name: string): number | undefined {
    const match = new RegExp(
      `^${this.containerPrefix}-g([1-9][0-9]*)-[a-f0-9]{12}$`,
    ).exec(name);
    if (match == null) return undefined;
    const generation = Number(match[1]);
    return Number.isSafeInteger(generation) ? generation : undefined;
  }

  private stagingContainer(): string {
    return `${this.containerPrefix}-staging-${this.incarnationHash}`;
  }

  private async renameRelay(
    activeContainer: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.run(
      ['container', 'rename', this.container, activeContainer],
      { signal },
    );
  }

  private async launchRelay(signal?: AbortSignal): Promise<void> {
    this.container = this.stagingContainer();
    await this.removeRelay(signal);
    this.container = this.stagingContainer();
    try {
      await this.client.run(
        [
          'run',
          '--detach',
          '--name',
          this.container,
          '--network',
          this.egressNetwork,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=16m',
          '--label',
          'com.librechat.code.file-relay=true',
          '--label',
          `com.librechat.code.worker-hash=${this.workerHash}`,
          '--label',
          `com.librechat.code.file-relay-staged-at=${this.options.now?.() ?? Date.now()}`,
          '--env',
          `LIBRECHAT_CODE_FILE_RELAY_UPSTREAM=${this.options.upstreamUrl}`,
          '--env',
          `LIBRECHAT_CODE_FILE_RELAY_TOKEN=${this.options.token}`,
          ...(this.options.maxBytes != null
            ? [
                '--env',
                `LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES=${this.options.maxBytes}`,
              ]
            : []),
          ...(this.options.timeoutMs != null
            ? [
                '--env',
                `LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS=${this.options.timeoutMs}`,
              ]
            : []),
          ...(this.options.maxConcurrentRequests != null
            ? [
                '--env',
                `LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS=${this.options.maxConcurrentRequests}`,
              ]
            : []),
          this.options.image,
          'relay',
        ],
        { signal },
      );
      await this.waitForHealth(signal);
      this.prepared = true;
    } catch (error) {
      await this.removeRelay();
      throw error;
    }
  }

  private async ensureNetwork(
    name: string,
    internal: boolean,
    role: 'runtime' | 'egress',
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.validateNetwork(name, internal, role, signal);
    } catch (error) {
      if (!missingNetwork(error)) throw error;
      try {
        await this.client.run(
          [
            'network',
            'create',
            ...(internal ? ['--internal'] : []),
            '--label',
            'com.librechat.code.file-relay=true',
            '--label',
            `com.librechat.code.network-role=${role}`,
            name,
          ],
          { signal },
        );
      } catch (createError) {
        if (!existingNetwork(createError)) throw createError;
        await this.validateNetwork(name, internal, role, signal);
      }
    }
  }

  private async validateNetwork(
    name: string,
    internal: boolean,
    role: 'runtime' | 'egress',
    signal?: AbortSignal,
  ): Promise<void> {
    const profile = await this.client.run(
      [
        'network',
        'inspect',
        '--format',
        '{{.Internal}}|{{index .Labels "com.librechat.code.file-relay"}}|{{index .Labels "com.librechat.code.network-role"}}',
        name,
      ],
      { signal },
    );
    const expected = `${String(internal)}|true|${role}`;
    if (profile.trim() !== expected) {
      throw new Error(
        `Docker file relay network ${name} does not match its required profile`,
      );
    }
  }

  private async removeRelay(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.run(['container', 'rm', '--force', this.container], {
        signal,
      });
    } catch (error) {
      if (!missingContainer(error)) throw error;
    }
    this.resetPreparedState();
  }

  private resetPreparedState(): void {
    this.container = this.stagingContainer();
    this.prepared = false;
    this.activeGeneration = undefined;
  }

  private async waitForHealth(signal?: AbortSignal): Promise<void> {
    const deadline =
      Date.now() +
      (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        await this.checkHealth(signal, remainingMs);
        return;
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('aborted', 'AbortError');
        }
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Docker file relay did not become healthy', {
      cause: lastError,
    });
  }

  private async checkHealth(
    signal?: AbortSignal,
    timeoutMs = Math.max(
      1,
      this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    ),
  ): Promise<void> {
    const status = await this.client.run(
      [
        'exec',
        this.container,
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/health',{headers:{'X-LibreChat-Code-Relay-Token':process.env.LIBRECHAT_CODE_FILE_RELAY_TOKEN},signal:AbortSignal.timeout(Number(process.argv.at(-1)))}).then(r=>process.stdout.write(String(r.status)))",
        String(timeoutMs),
      ],
      { signal },
    );
    if (status.trim() !== '200') {
      throw new Error(`File relay health check returned HTTP ${status.trim()}`);
    }
  }
}
