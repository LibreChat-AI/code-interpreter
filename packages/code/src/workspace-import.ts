import { statfs } from 'node:fs/promises';

import {
  BRIDGE_WORKSPACE_IMPORT_FILE_DEFAULT_MAX_BYTES,
  BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS,
} from './protocol.js';
import {
  FILE_RELAY_GRANT_HEADER,
  fileRelayObjectUrl,
  validateFileRelayUpstream,
} from './relay.js';
import { WorkspaceToolError } from './workspace.js';

import type { WorkspaceImportFileRequest } from './protocol.js';
import type { WorkspaceFileImporter } from './workspace.js';

export interface HttpWorkspaceFileImporterOptions {
  /** The egress gateway this worker already uses for programmatic inputs. */
  upstreamUrl: string;
  maxBytes?: number;
  /** Longest wait for response headers or for the next body chunk. */
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  availableBytes?: (directory: string) => Promise<number>;
}

/**
 * The importer a worker runs with, if any. `import_file` is on by default
 * whenever the worker can perform it: writes enabled and a relay upstream to
 * reach stored objects. `--no-workspace-imports` or
 * `LIBRECHAT_CODE_ALLOW_WORKSPACE_IMPORTS=false` opts out; any other value of
 * that variable fails startup rather than silently choosing either way.
 */
export function createWorkspaceFileImporter(input: {
  optOut: boolean;
  enabled?: string;
  writable: boolean;
  upstreamUrl?: string;
  maxBytes?: number;
}): HttpWorkspaceFileImporter | undefined {
  const enabled = input.enabled?.trim().toLowerCase() ?? '';
  if (enabled !== '' && enabled !== 'true' && enabled !== 'false') {
    throw new Error('LIBRECHAT_CODE_ALLOW_WORKSPACE_IMPORTS must be true or false');
  }
  const upstreamUrl = input.upstreamUrl?.trim() ?? '';
  if (input.optOut || enabled === 'false' || !input.writable || upstreamUrl === '') {
    return undefined;
  }
  return new HttpWorkspaceFileImporter({ upstreamUrl, maxBytes: input.maxBytes });
}

async function filesystemAvailableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function importAborted(): WorkspaceToolError {
  return new WorkspaceToolError('Workspace import aborted', 'EXECUTION_ABORTED');
}

function importUnavailable(message: string): WorkspaceToolError {
  return new WorkspaceToolError(message, 'WRITE_UNAVAILABLE');
}

/**
 * Streams one granted object from the file relay upstream. The worker holds no
 * storage credential: Code API's grant authorizes exactly this object, briefly.
 */
export class HttpWorkspaceFileImporter implements WorkspaceFileImporter {
  readonly maxBytes: number;
  private readonly upstream: URL;
  private readonly stallTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly freeBytes: (directory: string) => Promise<number>;

  constructor(options: HttpWorkspaceFileImporterOptions) {
    this.upstream = validateFileRelayUpstream(options.upstreamUrl);
    this.maxBytes = options.maxBytes ?? BRIDGE_WORKSPACE_IMPORT_FILE_DEFAULT_MAX_BYTES;
    this.stallTimeoutMs = options.stallTimeoutMs ?? BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError('Workspace import file limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.stallTimeoutMs) || this.stallTimeoutMs < 1) {
      throw new RangeError('Workspace import stall timeout must be a positive safe integer');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.freeBytes = options.availableBytes ?? filesystemAvailableBytes;
  }

  availableBytes(directory: string): Promise<number> {
    return this.freeBytes(directory);
  }

  async open(
    request: WorkspaceImportFileRequest & { egressGrant: string },
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (signal?.aborted) throw importAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.stallTimeoutMs);
    };
    const release = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const failure = (): WorkspaceToolError =>
      signal?.aborted
        ? importAborted()
        : importUnavailable(stalled ? 'Import source transfer stalled' : 'Import source download failed');

    arm();
    let response: Response;
    try {
      response = await this.fetchImpl(
        fileRelayObjectUrl(this.upstream, request.source.storage_session_id, request.source.id),
        {
          headers: {
            [FILE_RELAY_GRANT_HEADER]: request.egressGrant,
            'Accept-Encoding': 'identity',
          },
          redirect: 'error',
          signal: controller.signal,
        },
      );
    } catch {
      release();
      throw failure();
    }
    // A compressed transfer declares its encoded length; only the decoded bytes are checked then.
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const declaredLength = encoding == null || encoding === 'identity'
      ? response.headers.get('content-length')
      : null;
    let rejection: WorkspaceToolError | undefined;
    if (!response.ok) {
      rejection = importUnavailable(`Import source download failed with HTTP ${response.status}`);
    } else if (declaredLength != null && declaredLength !== String(request.bytes)) {
      rejection = new WorkspaceToolError(
        'Import source size does not match the declared size',
        'INVALID_REQUEST',
      );
    } else if (response.body == null && request.bytes > 0) {
      rejection = importUnavailable('Import source returned no content');
    }
    if (rejection != null) {
      release();
      await response.body?.cancel().catch(() => undefined);
      throw rejection;
    }
    const body = response.body;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (body == null) {
        release();
        return;
      }
      const reader = body.getReader();
      try {
        for (;;) {
          let next: Awaited<ReturnType<typeof reader.read>>;
          // The stall timer covers only waiting on the source, never the consumer's writes.
          arm();
          try {
            next = await reader.read();
          } catch {
            throw failure();
          } finally {
            clearTimeout(timer);
          }
          if (next.done) return;
          yield next.value;
        }
      } finally {
        release();
        await reader.cancel().catch(() => undefined);
      }
    }
    return chunks();
  }
}
