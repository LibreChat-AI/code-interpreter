import { createHash } from 'node:crypto';

import { DockerCliClient } from './runtime.js';

import type { ContainerRuntimeClient } from './runtime.js';

export interface DockerFileRelaySupervisorOptions {
  workerId: string;
  image: string;
  upstreamUrl: string;
  token: string;
  dockerCommand?: string;
  startupTimeoutMs?: number;
  client?: ContainerRuntimeClient;
}

export interface DockerFileRelayProfile {
  network: string;
  url: string;
  token: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

function suffix(workerId: string): string {
  return createHash('sha256').update(workerId).digest('hex').slice(0, 20);
}

function missingNetwork(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:network(?: .*?)? not found|no such network)/i.test(error.message)
  );
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
  private readonly container: string;

  constructor(private readonly options: DockerFileRelaySupervisorOptions) {
    if (!options.image.trim()) {
      throw new Error('Docker file relay image is required');
    }
    if (!options.token.trim()) {
      throw new Error('Docker file relay token is required');
    }
    const upstream = new URL(options.upstreamUrl);
    if (
      (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash
    ) {
      throw new Error(
        'Docker file relay upstream must be an HTTP URL without credentials, query, or fragment',
      );
    }
    const id = suffix(options.workerId);
    this.network = `librechat-code-relay-${id}`;
    this.container = `librechat-code-relay-${id}`;
    this.client = options.client ?? new DockerCliClient(options.dockerCommand);
  }

  async prepare(signal?: AbortSignal): Promise<DockerFileRelayProfile> {
    await this.ensureNetwork(signal);
    await this.removeRelay(signal);
    await this.client.run(
      [
        'run',
        '--detach',
        '--name',
        this.container,
        '--network',
        'bridge',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '--label',
        'com.librechat.code.file-relay=true',
        '--env',
        `LIBRECHAT_CODE_FILE_RELAY_UPSTREAM=${this.options.upstreamUrl}`,
        '--env',
        `LIBRECHAT_CODE_FILE_RELAY_TOKEN=${this.options.token}`,
        this.options.image,
        'relay',
      ],
      { signal },
    );
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
      await this.waitForHealth(signal);
    } catch (error) {
      await this.removeRelay(signal);
      throw error;
    }
    return {
      network: this.network,
      url: 'http://relay:3000',
      token: this.options.token,
    };
  }

  private async ensureNetwork(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.run(['network', 'inspect', this.network], {
        signal,
      });
    } catch (error) {
      if (!missingNetwork(error)) throw error;
      await this.client.run(
        [
          'network',
          'create',
          '--internal',
          '--label',
          'com.librechat.code.file-relay=true',
          this.network,
        ],
        { signal },
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
  }

  private async waitForHealth(signal?: AbortSignal): Promise<void> {
    const deadline =
      Date.now() +
      (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const status = await this.client.run(
          [
            'exec',
            this.container,
            'node',
            '-e',
            "fetch('http://127.0.0.1:3000/health',{headers:{'X-LibreChat-Code-Relay-Token':process.env.LIBRECHAT_CODE_FILE_RELAY_TOKEN}}).then(r=>process.stdout.write(String(r.status)))",
          ],
          { signal },
        );
        if (status.trim() === '200') return;
        lastError = new Error(
          `File relay health check returned HTTP ${status.trim()}`,
        );
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Docker file relay did not become healthy', {
      cause: lastError,
    });
  }
}
