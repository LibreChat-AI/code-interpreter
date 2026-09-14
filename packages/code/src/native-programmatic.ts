import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES,
  BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
  BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES,
  BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES,
  BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_TOTAL_BYTES,
  bridgeArtifactMediaType,
  isBridgeWorkspaceProgrammaticRequest,
  isSafePortableRelativePath,
  isSupportedBridgeArtifactName,
} from './protocol.js';
import { validateFileRelayUpstream } from './relay.js';
import { WorkspaceToolError } from './workspace.js';

import type {
  BridgeProgrammaticPayloadFile,
  BridgeWorkspaceProgrammaticRequest,
  WorkspaceExecuteCommandResult,
} from './protocol.js';
import type { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';

const EGRESS_GRANT_HEADER = 'X-CodeAPI-Egress-Grant';
const EXECUTION_MAIN_FILE = 'main.sh';
const EXECUTION_HISTORY_FILE = '_ptc_history.json';
const EXECUTION_CONTROL_FILE = '_ptc_pending_result.json';
export const NATIVE_PROGRAMMATIC_COMMAND =
    'exec "$LIBRECHAT_CODE_BASH_PATH" "$LIBRECHAT_CODE_DATA_DIR/main.sh"';
const TRANSFER_TIMEOUT_MS = 30_000;
const TRANSFER_CONCURRENCY = 4;
const MAX_WALK_ENTRIES = 2_000;
const INPUT_CACHE_MAX_ENTRIES = 64;
const INPUT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CONTROL_PAYLOAD_MAX_BYTES = 512 * 1024;

type ProgrammaticFileResult = {
  id: string;
  name: string;
  storage_session_id: string;
  modified_from?: { id: string; storage_session_id: string };
};

type ProgrammaticResult = {
  language: 'bash';
  version: string;
  session_id: string;
  files: ProgrammaticFileResult[];
  deleted_files?: string[];
  artifact_delivery?: {
    code: 'artifact_delivery_failed';
    status: 'partial' | 'failed';
    attempted: number;
    delivered: number;
    failed: number;
  };
    pending_tool_calls_payload?: string;
  run: {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    output: string;
    memory: null;
    message: string | null;
    status: string | null;
    cpu_time: null;
    wall_time: number;
  };
};

type InputBaseline = {
  sha256: string;
  source?: { id: string; storage_session_id: string };
  readOnly?: boolean;
};

type CachedInput = { bytes: Buffer; readOnly: boolean };

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputFileId(): string {
  return randomBytes(18).toString('base64url').slice(0, 21);
}

function localPath(root: string, name: string): string {
  if (!isSafePortableRelativePath(name)) {
        throw new WorkspaceToolError(
            'Invalid programmatic file path',
            'INVALID_PATH',
        );
  }
  const path = join(root, ...name.split('/'));
  const child = relative(root, path);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) {
        throw new WorkspaceToolError(
            'Invalid programmatic file path',
            'INVALID_PATH',
        );
  }
  return path;
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength != null &&
    (!/^\d+$/.test(declaredLength) ||
            Number(declaredLength) >
                BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES)
  ) {
    await response.body?.cancel();
    throw new WorkspaceToolError(
      'Programmatic input exceeds the file limit',
      'READ_LIMIT_EXCEEDED',
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES) {
        throw new WorkspaceToolError(
          'Programmatic input exceeds the file limit',
          'READ_LIMIT_EXCEEDED',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, bytes);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
        Array.from(
            { length: Math.min(concurrency, values.length) },
            async () => {
      for (;;) {
        if (failed) return;
        const index = next++;
        if (index >= values.length) return;
        try {
          results[index] = await action(values[index]!);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
          return;
        }
      }
            },
        ),
  );
  if (failed) throw failure;
  return results;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      if (++entries > MAX_WALK_ENTRIES) {
        throw new WorkspaceToolError(
          'Programmatic output contains too many entries',
          'WRITE_LIMIT_EXCEEDED',
        );
      }
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (!isSafePortableRelativePath(name)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  return files.sort();
}

export interface NativeWorkspaceProgrammaticOptions {
  sandbox: Pick<
    NativeSrtWorkspaceCommandSandbox,
    'createExecutionDirectory' | 'executeProgrammatic'
  > &
    Partial<
      Pick<NativeSrtWorkspaceCommandSandbox, 'createProgrammaticProbeWorkspace'>
    >;
  upstreamUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Executes one replay-mode Bash PTC iteration in an attached workspace.
 * Program code and injected files live in a private SRT scratch directory;
 * the selected repository remains the command cwd and is never used as a
 * transport cache.
 */
export class NativeWorkspaceProgrammaticExecutor {
  private readonly upstream: URL;
  private readonly fetchImpl: typeof fetch;
  /** Parent-process cache: sandboxed children cannot inspect this memory. */
  private readonly inputCache = new Map<
    string,
    CachedInput & { lastUsed: number }
  >();
  private inputCacheBytes = 0;

  constructor(private readonly options: NativeWorkspaceProgrammaticOptions) {
    this.upstream = validateFileRelayUpstream(options.upstreamUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Prove copy-on-write isolation before the worker advertises Bash PTC.
   * The probe uses the exact registered root and private scratch path that a
   * real replay will use, then removes the snapshot before registration.
   */
  async prepare(signal?: AbortSignal): Promise<void> {
    const createProbeWorkspace =
      this.options.sandbox.createProgrammaticProbeWorkspace;
    if (createProbeWorkspace == null) {
      throw new WorkspaceToolError(
        'Selected-workspace PTC probe isolation is unavailable',
        'COMMAND_UNAVAILABLE',
      );
    }
    const executionDirectory =
      await this.options.sandbox.createExecutionDirectory();
    try {
      await createProbeWorkspace.call(
        this.options.sandbox,
        executionDirectory,
        signal,
      );
    } finally {
      await rm(executionDirectory, { recursive: true, force: true });
    }
  }

  private cacheKey(
        executionId: string | undefined,
    file: Extract<BridgeProgrammaticPayloadFile, { id: string }>,
  ): string | undefined {
        return executionId && file.input_cache_key
            ? `${executionId}:${file.input_cache_key}`
            : undefined;
  }

  private cachedInput(key: string): CachedInput | undefined {
    const cached = this.inputCache.get(key);
    if (!cached) return undefined;
    cached.lastUsed = Date.now();
    return { bytes: cached.bytes, readOnly: cached.readOnly };
  }

  private cacheInput(key: string, input: CachedInput): void {
    const { bytes } = input;
    if (bytes.byteLength > INPUT_CACHE_MAX_BYTES) return;
    const existing = this.inputCache.get(key);
    if (existing) this.inputCacheBytes -= existing.bytes.byteLength;
    while (
      this.inputCache.size >= INPUT_CACHE_MAX_ENTRIES ||
      this.inputCacheBytes + bytes.byteLength > INPUT_CACHE_MAX_BYTES
    ) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, value] of this.inputCache) {
        if (value.lastUsed < oldestAt) {
          oldestAt = value.lastUsed;
          oldestKey = candidate;
        }
      }
      if (!oldestKey) break;
            this.inputCacheBytes -=
                this.inputCache.get(oldestKey)!.bytes.byteLength;
      this.inputCache.delete(oldestKey);
    }
    this.inputCache.set(key, { ...input, lastUsed: Date.now() });
    this.inputCacheBytes += bytes.byteLength;
  }

  private async downloadInput(
    file: Extract<BridgeProgrammaticPayloadFile, { id: string }>,
    grant: string,
        executionId: string | undefined,
    signal?: AbortSignal,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  ): Promise<CachedInput> {
        const key = this.cacheKey(executionId, file);
    const cached = key ? this.cachedInput(key) : undefined;
    if (cached) return cached;
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), transferTimeoutMs);
    try {
      const response = await this.fetchImpl(
        new URL(
          `sessions/${encodeURIComponent(file.storage_session_id)}/objects/${encodeURIComponent(file.id)}`,
          `${this.upstream.toString().replace(/\/+$/, '')}/`,
        ),
        {
          headers: { [EGRESS_GRANT_HEADER]: grant },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new WorkspaceToolError(
          `Programmatic input download failed with HTTP ${response.status}`,
          'COMMAND_UNAVAILABLE',
        );
      }
            const bytes = await readBoundedResponse(
                response,
                controller.signal,
            );
      const input = {
        bytes,
        readOnly: response.headers.get('x-read-only')?.toLowerCase() === 'true',
      };
      if (key) this.cacheInput(key, input);
      return input;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async execute(
    request: BridgeWorkspaceProgrammaticRequest,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ProgrammaticResult> {
    if (!isBridgeWorkspaceProgrammaticRequest(request)) {
      throw new WorkspaceToolError(
        'Invalid selected-workspace programmatic request',
        'INVALID_REQUEST',
      );
    }
    if (signal?.aborted) {
            throw new WorkspaceToolError(
                'Programmatic execution aborted',
                'EXECUTION_ABORTED',
            );
    }
    const grant = request.body.egress_grant;
    const refFiles = request.body.files.filter(
            (
                file,
            ): file is Extract<BridgeProgrammaticPayloadFile, { id: string }> =>
        'id' in file,
    );
    if (refFiles.length > 0 && !grant) {
      throw new WorkspaceToolError(
        'Programmatic input grant is unavailable',
        'INVALID_REQUEST',
      );
    }
        const executionDirectory =
            await this.options.sandbox.createExecutionDirectory();
        const inputDirectory = join(executionDirectory, 'inputs');
        let dataDirectory = join(executionDirectory, 'final');
    const baselines = new Map<string, InputBaseline>();
    let totalInputBytes = 0;
    const startedAt = performance.now();
    let commandDispatched = false;
    try {
            await mkdir(inputDirectory, { mode: 0o700 });
      await mapConcurrent(
        request.body.files,
        TRANSFER_CONCURRENCY,
        async (file): Promise<void> => {
          const input =
            'content' in file
              ? { bytes: Buffer.from(file.content), readOnly: false }
                            : await this.downloadInput(
                                  file,
                                  grant!,
                                  request.body.execution_id,
                                  signal,
                                  request.body.transfer_timeout_ms,
                              );
          const { bytes } = input;
          totalInputBytes += bytes.byteLength;
                    if (
                        totalInputBytes >
                        BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_TOTAL_BYTES
                    ) {
            throw new WorkspaceToolError(
              'Programmatic inputs exceed the total byte limit',
              'READ_LIMIT_EXCEEDED',
            );
          }
                    const path = localPath(inputDirectory, file.name);
                    await mkdir(dirname(path), {
                        recursive: true,
                        mode: 0o700,
                    });
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          baselines.set(file.name, {
            sha256: sha256(bytes),
            ...(input.readOnly ? { readOnly: true } : {}),
            ...('id' in file
              ? {
                  source: {
                    id: file.id,
                                      storage_session_id:
                                          file.storage_session_id,
                  },
                }
              : {}),
          });
        },
      );

            const run = async (
                directory: string,
                probe: boolean,
                workspaceRoot?: string,
            ): Promise<WorkspaceExecuteCommandResult> => {
                await cp(inputDirectory, directory, {
                    recursive: true,
                    force: false,
                    errorOnExist: true,
                    mode: constants.COPYFILE_FICLONE,
                });
      if (!probe) commandDispatched = true;
                return await this.options.sandbox.executeProgrammatic(
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          operation: 'execute_command',
          workspaceId,
          command: NATIVE_PROGRAMMATIC_COMMAND,
          timeoutMs: Math.min(
                            request.body.run_timeout ??
                                BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
            BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
          ),
                        maxOutputBytes:
                            BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES,
        },
                    directory,
        signal,
                    { probe, workspaceRoot },
                );
            };

            const readPending = async (
                directory: string,
            ): Promise<string | undefined> => {
                try {
                    const path = join(directory, EXECUTION_CONTROL_FILE);
                    const handle = await open(
                        path,
                        constants.O_RDONLY | constants.O_NOFOLLOW,
                    );
                    try {
                        const metadata = await handle.stat();
                        if (
                            !metadata.isFile() ||
                            metadata.size === 0 ||
                            metadata.size > CONTROL_PAYLOAD_MAX_BYTES
                        ) {
                            throw new WorkspaceToolError(
                                'Native programmatic control frame is invalid',
                                'COMMAND_UNAVAILABLE',
                            );
                        }
                        return await handle.readFile('utf8');
                    } finally {
                        await handle.close();
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return;
                    throw error;
                }
            };

            if ((request.body.replay_tool_count ?? 0) > 0) {
                const probeDirectory = join(executionDirectory, 'probe');
                const createProbeWorkspace =
                    this.options.sandbox.createProgrammaticProbeWorkspace;
                if (createProbeWorkspace == null) {
                    throw new WorkspaceToolError(
                        'Selected-workspace PTC probe isolation is unavailable',
                        'COMMAND_UNAVAILABLE',
                    );
                }
                const probeWorkspace = await createProbeWorkspace.call(
                    this.options.sandbox,
                    executionDirectory,
                    signal,
                );
                const probeResult = await run(
                    probeDirectory,
                    true,
                    probeWorkspace,
                );
                const pending = await readPending(probeDirectory);
                if (pending) {
                    return this.result(
                        request,
                        {
                            ...probeResult,
                            /** Probe output is speculative and the script will
                             * run once under its real policy after tool
                             * resolution. Never duplicate it or expose
                             * expected read-only policy denials to callers. */
                            stdout: '',
                            stderr: '',
                        },
                        [],
                        performance.now() - startedAt,
                        pending,
                    );
                }
                if (probeResult.truncated) {
                    throw new WorkspaceToolError(
                        'Native programmatic probe output exceeded its limit',
                        'WRITE_LIMIT_EXCEEDED',
                    );
                }
                if (
                    probeResult.timedOut ||
                    probeResult.signal
                ) {
                    return this.result(
                        request,
                        probeResult,
                        [],
                        performance.now() - startedAt,
                    );
                }
                /** A read-only probe commonly exits non-zero after it reaches
                 * an intentional workspace write denial. With no pending call,
                 * run the script once under its real policy so ordinary writes
                 * and their resulting exit status are evaluated exactly once. */
            }

            const commandResult = await run(dataDirectory, false);
            if (await readPending(dataDirectory)) {
                throw new WorkspaceToolError(
                    'Native programmatic commit pass requested an unexpected replay tool',
                    'COMMAND_UNAVAILABLE',
                    true,
                    true,
                );
            }
            if (commandResult.truncated) {
                throw new WorkspaceToolError(
                    'Native programmatic output exceeded its limit',
                    'WRITE_LIMIT_EXCEEDED',
                    true,
                    true,
      );
            }

      const outputSessionId = request.body.output_session_id;
      const survivingNames = new Set(await listRegularFiles(dataDirectory));
      const deletedFiles = refFiles
        .filter(
          file =>
            baselines.get(file.name)?.readOnly !== true &&
            !survivingNames.has(file.name),
        )
        .map(file => file.name);
      const outputNames = [...survivingNames].filter(
        name =>
          name !== EXECUTION_MAIN_FILE &&
          name !== EXECUTION_HISTORY_FILE &&
          name !== EXECUTION_CONTROL_FILE &&
          !name.startsWith('skills/'),
      );
      const changed: Array<{
        name: string;
        bytes: Buffer;
        source?: { id: string; storage_session_id: string };
      }> = [];
      let totalOutputBytes = 0;
      for (const name of outputNames) {
        const path = localPath(dataDirectory, name);
        const baseline = baselines.get(name);
        const maxOutputFileBytes = Math.min(
          request.body.max_output_file_bytes ?? BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES,
          BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES,
        );
        let bytes: Buffer;
                const handle = await open(
                    path,
                    constants.O_RDONLY | constants.O_NOFOLLOW,
                );
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) continue;
                    // An unchanged input is not an output. It may legitimately
                    // exceed the negotiated output ceiling, but never the
                    // protocol's bounded input limit.
                    if (metadata.size > (baseline ? BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES : maxOutputFileBytes)) {
            throw new WorkspaceToolError(
              'Programmatic output exceeds the file limit',
              'WRITE_LIMIT_EXCEEDED',
            );
          }
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (baseline?.sha256 === sha256(bytes)) continue;
        if (bytes.byteLength > maxOutputFileBytes) {
          throw new WorkspaceToolError(
            'Programmatic output exceeds the file limit',
            'WRITE_LIMIT_EXCEEDED',
          );
        }
        totalOutputBytes += bytes.byteLength;
                if (
                    totalOutputBytes >
                    BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_TOTAL_BYTES
                ) {
          throw new WorkspaceToolError(
            'Programmatic outputs exceed the total byte limit',
            'WRITE_LIMIT_EXCEEDED',
          );
        }
        changed.push({ name, bytes, source: baseline?.source });
      }
            const maxOutputFiles = Math.min(
                request.body.max_output_files ??
                    BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES,
                BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES,
            );
            if (changed.length > maxOutputFiles) {
        throw new WorkspaceToolError(
          'Programmatic output contains too many files',
          'WRITE_LIMIT_EXCEEDED',
        );
      }
      const uploadable = changed.filter(({ name }) =>
        isSupportedBridgeArtifactName(name),
      );
      if (uploadable.length > 0 && (!grant || !outputSessionId)) {
        throw new WorkspaceToolError(
          'Programmatic output grant is unavailable',
          'COMMAND_UNAVAILABLE',
        );
      }
      const uploadResults = await mapConcurrent(
        uploadable,
        TRANSFER_CONCURRENCY,
        async ({ name, bytes, source }): Promise<ProgrammaticFileResult | undefined> => {
          const id = outputFileId();
          const controller = new AbortController();
          const abort = (): void => controller.abort(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
                    const timer = setTimeout(
                        () => controller.abort(),
                        request.body.transfer_timeout_ms ?? TRANSFER_TIMEOUT_MS,
                    );
          try {
            let response: Response;
            try {
              response = await this.fetchImpl(
                new URL(
                  `sessions/${encodeURIComponent(outputSessionId!)}/objects/${id}`,
                  `${this.upstream.toString().replace(/\/+$/, '')}/`,
                ),
                {
                  method: 'PUT',
                  headers: {
                    [EGRESS_GRANT_HEADER]: grant!,
                    'Content-Type': bridgeArtifactMediaType(name),
                    'Content-Length': String(bytes.byteLength),
                    'X-Original-Filename': encodeURIComponent(name),
                  },
                  body: new Uint8Array(bytes),
                  redirect: 'error',
                  signal: controller.signal,
                },
              );
            } catch (error) {
              if (signal?.aborted) throw error;
              return undefined;
            }
            await response.body?.cancel();
            if (!response.ok) {
              return undefined;
            }
            return {
              id,
              name,
              storage_session_id: outputSessionId!,
              ...(source ? { modified_from: source } : {}),
            };
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          }
        },
      );
      const files = uploadResults.filter(
        (file): file is ProgrammaticFileResult => file != null,
      );
      const artifactDelivery =
        files.length < changed.length
          ? {
              code: 'artifact_delivery_failed' as const,
              status: files.length > 0 ? ('partial' as const) : ('failed' as const),
              attempted: changed.length,
              delivered: files.length,
              failed: changed.length - files.length,
            }
          : undefined;
            return this.result(
                request,
                commandResult,
                files,
                performance.now() - startedAt,
                undefined,
                artifactDelivery,
                deletedFiles,
            );
    } catch (error) {
      if (!commandDispatched) {
        // The low-level command runner classifies any launched process as a
        // possible mutation. A probe can only mutate its disposable snapshot,
        // so translate that classification at this ownership boundary.
        throw new WorkspaceToolError(
          error instanceof Error ? error.message : 'Programmatic preparation failed',
          error instanceof WorkspaceToolError ? error.code : 'COMMAND_UNAVAILABLE',
          false,
          false,
        );
      }
      if (error instanceof WorkspaceToolError) {
                if (
                    error.mutationMayHaveCommitted ||
                    error.requiresQuarantine
                ) {
          throw error;
        }
                throw new WorkspaceToolError(
                    error.message,
                    error.code,
                    true,
                    true,
                );
      }
      throw new WorkspaceToolError(
        'Native programmatic execution failed after dispatch',
        'COMMAND_UNAVAILABLE',
        true,
        true,
      );
    } finally {
      try {
                await rm(executionDirectory, { recursive: true, force: true });
      } catch {
        throw new WorkspaceToolError(
          'Native programmatic execution cleanup failed',
          'COMMAND_UNAVAILABLE',
          commandDispatched,
          commandDispatched,
        );
      }
    }
  }

  private result(
    request: BridgeWorkspaceProgrammaticRequest,
    command: WorkspaceExecuteCommandResult,
    files: ProgrammaticFileResult[],
    elapsedMs: number,
        pendingToolCallsPayload?: string,
    artifactDelivery?: ProgrammaticResult['artifact_delivery'],
    deletedFiles: string[] = [],
  ): ProgrammaticResult {
    return {
      language: 'bash',
      version: request.body.version,
      // Code API masks the execution session separately from the writable
      // output bucket. Sandbox results must identify the output bucket so the
      // gateway can restore it to the caller-owned session after upload.
            session_id:
                request.body.output_session_id ?? request.body.session_id,
      files,
      ...(deletedFiles.length > 0 ? { deleted_files: deletedFiles } : {}),
      ...(artifactDelivery ? { artifact_delivery: artifactDelivery } : {}),
            ...(pendingToolCallsPayload
                ? { pending_tool_calls_payload: pendingToolCallsPayload }
                : {}),
      run: {
        stdout: command.stdout,
        stderr: command.stderr,
        code: command.exitCode,
        signal: command.signal ?? null,
        output: `${command.stdout}${command.stderr}`,
        memory: null,
        message: command.timedOut ? 'Execution timed out' : null,
        status: command.timedOut ? 'timeout' : null,
        cpu_time: null,
        wall_time: elapsedMs / 1000,
      },
    };
  }
}
