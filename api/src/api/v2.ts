import express, { type Request, type Response, type NextFunction } from 'express';
import type { Runtime } from '../runtime';
import type { TFile } from '../job';
import { getLatestRuntimeMatchingLanguageVersion, getRuntimes } from '../runtime';
import { logger } from '../logger';
import { config } from '../config';
import {
  Job,
  SessionWorkspaceDirtyError,
  ValidationError,
  hasRunnableSource,
  validateFilePath,
} from '../job';
import { EXECUTION_MANIFEST_HEADER, ExecutionManifestError, type ExecutionManifestClaims } from '../execution-manifest';
import { verifyExecuteRequestManifest } from '../execution-manifest-request';
import { EGRESS_GRANT_HEADER } from '../egress';
import { activeSandboxExecutions, recordSandboxExecution } from '../metrics';
import { classifySandboxSafeError } from '../safe-error';
import { withSpan } from '../telemetry';
import { checkSandboxWorkspaceHealth } from '../workspace-isolation';
import type { SessionWorkspace } from '../session-workspace';
import {
  RUNTIME_SESSION_ID_HEADER,
  bindSessionWorkspace,
  parseSessionBindingFromHeader,
} from '../session-workspace';
import { streamSessionCheckpoint, restoreSessionCheckpoint } from '../session-checkpoint';
import { ensureToolCallSocketProxyReady } from '../tool-call-socket-process';
import {
  SESSION_INPUT_CACHE_MAX_OBJECTS,
  hasCachedInput,
  pruneInputCache,
  storeCachedInputs,
} from '../session-inputs';
import {
  HostedAppError,
  hostedAppSupervisor,
} from '../hosted-app';

const router = express.Router();
const SYNTHETIC_PRINCIPAL_SOURCE = 'synthetic_test';

function existingDestinationConflictMessage(existing: string, destination: string): string {
  return existing === destination
    ? `files contains duplicate destination "${destination}"`
    : `files contains conflicting destinations "${existing}" and "${destination}"`;
}

export function validateExecuteFiles(files: TFile[]): void {
  if (files.length > config.max_input_files) {
    throw { message: `files cannot contain more than ${config.max_input_files} destinations` };
  }
  const destinations = new Set<string>();
  for (const [i, value] of files.entries()) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw { message: `files[${i}] must be an object` };
    }
    const file = value as TFile;
    const inline = typeof file.content === 'string';
    const byRef = typeof file.id === 'string' && file.id.length > 0;
    if (inline === byRef) {
      throw {
        message: `files[${i}] must contain exactly one of non-empty id or string content`,
      };
    }
    if (file.id !== undefined && !byRef) {
      throw { message: `files[${i}].id must be a non-empty string if provided` };
    }
    if (byRef) {
      if (typeof file.storage_session_id !== 'string' || file.storage_session_id.length === 0) {
        throw { message: `files[${i}].storage_session_id is required as a non-empty string for file refs` };
      }
    } else if (file.storage_session_id !== undefined || file.input_cache_key !== undefined) {
      throw {
        message: `files[${i}] inline content cannot include storage_session_id or input_cache_key`,
      };
    }
    if (file.name !== undefined && typeof file.name !== 'string') {
      throw { message: `files[${i}].name must be a string if provided` };
    }
    if (
      file.encoding !== undefined
      && !(['base64', 'hex', 'utf8'] as const).includes(file.encoding)
    ) {
      throw { message: `files[${i}].encoding must be base64, hex, or utf8 if provided` };
    }
    if (file.entity_id !== undefined && typeof file.entity_id !== 'string') {
      throw { message: `files[${i}].entity_id must be a string if provided` };
    }
    if (
      file.input_cache_key !== undefined &&
      (
        typeof file.input_cache_key !== 'string' ||
        !/^[0-9a-f]{64}$/.test(file.input_cache_key)
      )
    ) {
      throw { message: `files[${i}].input_cache_key must be a 64-character lowercase hex digest` };
    }
    const destination = file.name || `file${i}.code`;
    try {
      validateFilePath(destination, '/tmp/codeapi-request-validation');
    } catch (error) {
      throw {
        message: error instanceof Error
          ? `files[${i}].name is invalid: ${error.message}`
          : `files[${i}].name is invalid`,
      };
    }
    const conflict = [...destinations].find(
      existing =>
        existing === destination ||
        existing.startsWith(`${destination}/`) ||
        destination.startsWith(`${existing}/`),
    );
    if (conflict) {
      throw { message: existingDestinationConflictMessage(conflict, destination) };
    }
    destinations.add(destination);
  }
}

export function validateExecuteArguments(args: unknown, stdin: unknown): void {
  if (args !== undefined && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) {
    throw { message: 'args must be an array of strings if provided' };
  }
  if (stdin !== undefined && typeof stdin !== 'string') {
    throw { message: 'stdin must be a string if provided' };
  }
}

export interface ExecuteRequestBody {
  /** Top-level execution session id (one sandbox `/exec` invocation).
   *  Intra-monorepo wire — service-api and sandbox ship together, so
   *  the rename is hard with no backward-compat alias. */
  session_id?: string;
  /** Output storage session id/handle used for generated file uploads. */
  output_session_id?: string;
  language: string;
  version: string;
  args?: string[];
  stdin?: string;
  files: TFile[];
  compile_memory_limit?: number;
  run_memory_limit?: number;
  run_timeout?: number;
  compile_timeout?: number;
  run_cpu_time?: number;
  compile_cpu_time?: number;
  env_vars?: Record<string, string>;
  egress_grant?: string;
  execution_manifest?: string;
  tool_call_socket?: boolean;
}

export const ENV_VAR_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;
export const MAX_ENV_VAR_BYTES = 1_000_000;

export function sanitizeEnvVars(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    if (!ENV_VAR_KEY_RE.test(key)) continue;
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (totalBytes + entryBytes > MAX_ENV_VAR_BYTES) {
      throw new Error(`env_vars exceeds maximum total size of ${MAX_ENV_VAR_BYTES} bytes`);
    }
    totalBytes += entryBytes;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Service-worker sends large opaque capabilities in the JSON body because
 * skill-heavy executions can make encrypted grants/manifests exceed HTTP
 * header limits and fail with 431 before this route can validate them.
 * Header fallback keeps rolling upgrades compatible.
 */
export function tokenFromBodyOrHeader(
  body: ExecuteRequestBody,
  field: 'egress_grant' | 'execution_manifest',
  headerValue: string | undefined,
): string | undefined {
  const bodyValue = body[field];
  if (typeof bodyValue === 'string' && bodyValue !== '') return bodyValue;
  return headerValue;
}

export function authorizeToolCallSocket(
  body: Pick<ExecuteRequestBody, 'tool_call_socket'>,
  manifest: ExecutionManifestClaims | undefined,
  options: {
    nowSeconds?: number;
    legacyClaimGraceUntilSeconds?: number;
    allowUnsignedLocalToolCallSocket?: boolean;
  } = {},
): boolean {
  const requested = body.tool_call_socket === true;
  const manifestAllowsSocket = manifest?.tool_call_socket === true;
  const manifestHasBodyHash = typeof manifest?.execute_body_sha256 === 'string' && manifest.execute_body_sha256 !== '';

  if (requested) {
    if (options.allowUnsignedLocalToolCallSocket === true && manifest === undefined) {
      return true;
    }
    if (!manifestAllowsSocket || !manifestHasBodyHash) {
      throw new ExecutionManifestError(
        'scope_mismatch',
        'Tool-call socket access is not authorized by the execution manifest',
      );
    }
    return true;
  }

  if (manifestAllowsSocket) {
    if (!manifestHasBodyHash) {
      throw new ExecutionManifestError(
        'scope_mismatch',
        'Tool-call socket access requires a body-bound execution manifest',
      );
    }
    return true;
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    manifest?.tool_call_socket === undefined &&
    manifestHasBodyHash &&
    options.legacyClaimGraceUntilSeconds !== undefined &&
    nowSeconds < options.legacyClaimGraceUntilSeconds
  ) {
    return true;
  }

  return false;
}

function getJob(
  body: ExecuteRequestBody,
  egressGrantToken?: string,
  toolCallSocketEnabled = false,
  isSynthetic = false,
  runtimeSessionHeader?: string | string[],
): Job {
  const {
    session_id, language, version, args, stdin, files,
    compile_memory_limit, run_memory_limit,
    run_timeout, compile_timeout,
    run_cpu_time, compile_cpu_time,
    env_vars,
  } = body;

  if (!language || typeof language !== 'string') {
    throw { message: 'language is required as a string' };
  }
  if (!version || typeof version !== 'string') {
    throw { message: 'version is required as a string' };
  }
  if (!files || !Array.isArray(files)) {
    throw { message: 'files is required as an array' };
  }
  if (body.tool_call_socket !== undefined && typeof body.tool_call_socket !== 'boolean') {
    throw { message: 'tool_call_socket must be a boolean if specified' };
  }
  validateExecuteArguments(args, stdin);
  validateExecuteFiles(files);

  const rt = getLatestRuntimeMatchingLanguageVersion(language, version);
  if (!rt) {
    throw { message: `${language}-${version} runtime is unknown` };
  }

  /* Reject a request with nothing runnable BEFORE anything is primed. This
   * gate used to count a lone `.dirkeep` as a utf8 source, so such a request
   * reached prime(), had its files written into the session workspace and its
   * priming metadata recorded, and only then failed the stricter check in
   * Job.execute — leaving the rejected request's writes visible to the next
   * execution. Both sides now ask `hasRunnableSource`. */
  if (!hasRunnableSource(files, rt.language)) {
    throw { message: 'files must include at least one runnable source file' };
  }

  validateConstraints(body, rt);

  /* Session mode is per-request opt-in: only run in the persistent workspace
   * when THIS request carried a valid X-Runtime-Session-Id. A headerless or
   * malformed-header request must NOT inherit a previously bound session, or it
   * would reuse that session's files/UID (defense-in-depth — the backend always
   * sends the header for a session VM, so this only guards stray requests). */
  const binding = parseSessionBindingFromHeader(runtimeSessionHeader);
  let session: SessionWorkspace | null = null;
  if (binding) {
    session = bindSessionWorkspace(binding) ?? null;
    /* The runner is already pinned to a DIFFERENT session. Falling through
     * with `session = null` would silently run the request as a stateless
     * one-shot under another session's workspace/UID; conflict loudly instead
     * so the control plane recycles this VM. */
    if (!session) {
      throw {
        status: 409,
        /* `session_workspace_dirty` is the established control-plane recycle
         * signal. Reuse it so a new runner remains safe behind an older
         * service during a rolling deployment. */
        code: 'session_workspace_dirty',
        message: 'Runner is bound to a different runtime session',
      };
    }
    if (session.dirtyReason) {
      throw {
        status: 409,
        code: 'session_workspace_dirty',
        message: 'Session workspace must be restored before another execute',
      };
    }
  }

  return new Job({
    session_id: session_id ?? null,
    runtime: rt,
    args: args ?? [],
    stdin: stdin ?? '',
    files,
    timeouts: {
      run: run_timeout ?? rt.timeouts.run,
      compile: compile_timeout ?? rt.timeouts.compile,
    },
    cpu_times: {
      run: run_cpu_time ?? rt.cpu_times.run,
      compile: compile_cpu_time ?? rt.cpu_times.compile,
    },
    memory_limits: {
      run: run_memory_limit ?? rt.memory_limits.run,
      compile: compile_memory_limit ?? rt.memory_limits.compile,
    },
    extra_env_vars: sanitizeEnvVars(env_vars),
    output_session_id: body.output_session_id,
    egress_grant: egressGrantToken,
    tool_call_socket_enabled: toolCallSocketEnabled,
    is_synthetic: isSynthetic,
    session,
  });
}

function validateConstraints(body: ExecuteRequestBody, rt: Runtime): void {
  const constraints = ['memory_limit', 'timeout', 'cpu_time'] as const;
  const types = ['compile', 'run'] as const;

  for (const constraint of constraints) {
    for (const type of types) {
      const key = `${type}_${constraint}` as keyof ExecuteRequestBody;
      const value = body[key];
      if (value === undefined || value === null) continue;

      if (typeof value !== 'number') {
        throw { message: `If specified, ${key} must be a number` };
      }

      const limitMap: Record<string, Record<string, number>> = {
        memory_limit: rt.memory_limits,
        timeout: rt.timeouts,
        cpu_time: rt.cpu_times,
      };

      const configured = limitMap[constraint]?.[type] ?? 0;
      if (configured <= 0) continue;
      if (value > configured) {
        throw { message: `${key} cannot exceed the configured limit of ${configured}` };
      }
      if (value < 0) {
        throw { message: `${key} must be non-negative` };
      }
    }
  }
}

function manifestErrorStatus(error: ExecutionManifestError): number {
  if (error.reason === 'missing_secret') return 500;
  if (error.reason === 'missing_header') return 401;
  if (error.reason === 'malformed') return 400;
  return 403;
}

router.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  /* Checkpoint restore and additive file delivery stream tar.gz bodies, not JSON. */
  if (req.path === '/session/restore' || req.path === '/session/inputs') return next();
  if (!req.headers['content-type']?.startsWith('application/json')) {
    return res.status(415).json({ message: 'requests must be of type application/json' });
  }
  next();
});

/* A hosted-app image is a dedicated process host, not an execution runner.
 * Keeping `/execute` structurally unavailable prevents a resident app and an
 * NsJail job from sharing the pinned session UID/workspace concurrently. */
router.use('/execute', (_req: Request, res: Response, next: NextFunction) => {
  if (config.hosted_apps_enabled) {
    return res.status(404).json({ message: 'Not Found' });
  }
  next();
});

/** Replay PTC payloads (user code + tool definitions + inlined
 * `_ptc_history.json` + pyplot assets) can far exceed Express's default
 * ~100kb body limit. The parser is installed *here* rather than globally
 * in `index.ts` because a global parser would run before this route and
 * its limit would be the effective cap (see the long comment in
 * `index.ts` for the routing-order rationale). Keep the limit configurable:
 * analyst workflows may send large scripts or replay payloads, while file
 * bytes should still move through the gateway/file path. */
router.post('/execute', express.json({ limit: config.execute_body_limit }), async (req: Request, res: Response) => {
  const started = performance.now();
  let job: Job | undefined;
  let cleanedUp = false;
  let activeExecution = false;
  let metricsLanguage = 'unknown';
  let metricsOutcome: Parameters<typeof recordSandboxExecution>[0]['outcome'] = 'execution_error';
  let primeCompleted = false;

  const cleanupHandler = async (): Promise<void> => {
    if (!job || cleanedUp) return;
    cleanedUp = true;
    await job.cleanup();
  };

  const markActiveExecution = (): void => {
    if (activeExecution) return;
    activeExecution = true;
    activeSandboxExecutions.inc();
  };

  /* Keep cleanup owned by the route `finally`. Request/response close events
   * can fire while NsJail is still running; releasing a per-job UID before
   * the child exits would let another job reuse that UID concurrently. */

  try {
    let verifiedManifest: ExecutionManifestClaims | undefined;
    let toolCallSocketEnabled = false;

    if (config.require_execution_manifest) {
      try {
        verifiedManifest = verifyExecuteRequestManifest({
          headerValue: tokenFromBodyOrHeader(req.body, 'execution_manifest', req.header(EXECUTION_MANIFEST_HEADER)),
          publicKey: config.execution_manifest_public_key,
          secret: config.execution_manifest_secret,
          body: req.body,
          bodyHashRequiredAfterSeconds: config.execution_manifest_body_hash_required_after_seconds,
        });
      } catch (error) {
        metricsOutcome = 'manifest_error';
        if (error instanceof ExecutionManifestError) {
          const status = manifestErrorStatus(error);
          logger.warn({ reason: error.reason, status }, 'Rejected sandbox request by execution manifest');
          return res.status(status).json({ message: error.message });
        }
        logger.error({ err: error }, 'Execution manifest validation failed unexpectedly');
        return res.status(500).json({ message: 'Execution manifest validation failed' });
      }
    }

    try {
      toolCallSocketEnabled = authorizeToolCallSocket(req.body, verifiedManifest, {
        legacyClaimGraceUntilSeconds: config.tool_call_socket_legacy_claim_grace_until_seconds,
        allowUnsignedLocalToolCallSocket: !config.hardened_sandbox_mode && !config.require_execution_manifest,
      });
    } catch (error) {
      metricsOutcome = 'manifest_error';
      if (error instanceof ExecutionManifestError) {
        const status = manifestErrorStatus(error);
        logger.warn({ reason: error.reason, status }, 'Rejected sandbox request by tool-call socket manifest scope');
        return res.status(status).json({ message: error.message });
      }
      throw error;
    }

    try {
      job = getJob(
        req.body,
        tokenFromBodyOrHeader(req.body, 'egress_grant', req.header(EGRESS_GRANT_HEADER) ?? undefined),
        toolCallSocketEnabled,
        verifiedManifest?.principal_source === SYNTHETIC_PRINCIPAL_SOURCE,
        req.headers[RUNTIME_SESSION_ID_HEADER],
      );
      metricsLanguage = job.runtime.language;
      markActiveExecution();
    } catch (error) {
      metricsOutcome = 'bad_request';
      /** Validation paths in `getJob`/`sanitizeEnvVars` may throw either
       * plain `{ message }` objects (the historical shape used by the
       * inline validators above) or proper `Error` instances (used by
       * `sanitizeEnvVars` so callers get a real stack trace and can do
       * `instanceof Error` checks). `res.json(err)` for an `Error` would
       * serialize to `{}` because `message` is a non-enumerable property,
       * dropping the reason on the floor. Normalize both shapes to
       * `{ message }` so the client always sees why the request was
       * rejected. */
      const message = error instanceof Error
        ? error.message
        : (error as { message?: unknown })?.message;
      /* Most validation paths are 400; a session-binding conflict carries its
       * own status so the control plane can tell "bad request" from "this VM
       * belongs to another session, recycle me". */
      const status = (error as { status?: unknown })?.status;
      const code = (error as { code?: unknown })?.code;
      return res
        .status(typeof status === 'number' ? status : 400)
        .json({
          ...(typeof code === 'string' ? { error: code } : {}),
          message: message || 'Bad request',
        });
    }

    try {
      if (toolCallSocketEnabled) {
        await ensureToolCallSocketProxyReady();
      }
      await withSpan('codeapi.sandbox.prime', {
        'codeapi.language': job.runtime.language,
      }, () => job!.prime());
      primeCompleted = true;
      const result = await withSpan('codeapi.sandbox.run', {
        'codeapi.language': job.runtime.language,
      }, () => job!.execute());

      if (result.run === undefined) {
        result.run = result.compile;
      }

      if (result.files && result.files.length > 0) {
        /* Upload returns the set of file IDs that were actually transferred to
         * the file server. Files we minted IDs for but failed to ship (e.g. the
         * EFAULT-from-Bun-fetch incident) are pruned from the response so they
         * never become phantom IDs that the next prime() will hammer with 404
         * retries before giving up. Inherited refs that were inlined from
         * autoLoadDirkeep / unchanged inputs have no `path` and are passed
         * through unchanged — they were never local to upload. */
        const uploaded = await withSpan('codeapi.sandbox.upload_generated_files', {
          'codeapi.language': job.runtime.language,
        }, () => job!.uploadGeneratedFiles())
          .catch((err) => {
            logger.error({ job: job!.uuid, err }, 'File upload failed');
            return new Set<string>();
          });

        const generatedIds = new Set(job.getGeneratedFileIds());
        const before = result.files.length;
        result.files = result.files.filter(
          f => !generatedIds.has(f.id) || uploaded.has(f.id),
        );
        const dropped = before - result.files.length;
        if (dropped > 0) {
          logger.warn(
            { job: job.uuid, dropped, kept: result.files.length },
            'Pruned files from response because upload did not reach file_server',
          );
        }
      }

      metricsOutcome = 'success';
      return res.status(200).json(result);
    } catch (error) {
      /* Deliberately BEFORE the ValidationError branch below: once priming has
       * completed, the workspace has been written to, so any later failure —
       * including a validation one — leaves state the next execute must not
       * inherit silently. Requests with nothing runnable are rejected up front
       * (see `hasRunnableSource`), so reaching here with a ValidationError
       * means files really were primed and dirty is the honest answer. */
      if (primeCompleted && job?.markSessionDirty('execution failed after input priming')) {
        metricsOutcome = 'execution_error';
        logger.error({ job: job.uuid, err: error }, 'Session execution left workspace state unknown');
        return res.status(409).json({
          error: 'session_workspace_dirty',
          message: 'Session workspace must be restored before another execute',
        });
      }
      if (error instanceof SessionWorkspaceDirtyError) {
        metricsOutcome = 'execution_error';
        logger.error({ job: job?.uuid, err: error }, 'Session input priming left a partial workspace');
        return res.status(409).json({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof ValidationError) {
        metricsOutcome = 'validation_error';
        return res.status(400).json({ message: error.message });
      }
      const safeError = classifySandboxSafeError(error);
      if (safeError) {
        metricsOutcome = 'execution_error';
        logger.error({ job: job?.uuid, err: error, safeError: safeError.body.error }, 'Sandbox setup failed');
        return res.status(safeError.status).json(safeError.body);
      }
      metricsOutcome = 'execution_error';
      logger.error({ job: job?.uuid, err: error }, 'Error executing job');
      return res.status(500).json({
        error: 'sandbox_execution_failed',
        message: 'Sandbox execution failed',
      });
    } finally {
      await cleanupHandler();
    }
  } finally {
    if (activeExecution) {
      activeSandboxExecutions.dec();
    }
    recordSandboxExecution({
      language: metricsLanguage,
      outcome: metricsOutcome,
      durationSeconds: (performance.now() - started) / 1000,
    });
  }
});

router.get('/health', async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await checkSandboxWorkspaceHealth());
  } catch (error) {
    logger.error({ err: error }, 'Sandbox workspace health check failed');
    return res.status(503).json({
      status: 'unhealthy',
      error: 'workspace_unavailable',
      message: 'Sandbox workspace root is unavailable',
    });
  }
});

router.get('/runtimes', (_req: Request, res: Response) => {
  const runtimes = getRuntimes().map(rt => ({
    language: rt.language,
    version: rt.version.raw,
    aliases: rt.aliases,
    runtime: rt.runtime,
  }));
  return res.status(200).json(runtimes);
});

/* Session workspace checkpoint / restore — control-plane driven, session-mode
 * only. GET streams a tar.gz of the whole workspace (captures state the
 * file-ref path drops: installed packages, chDB dirs, unsupported-extension
 * files); POST replaces the workspace from one. No body parser on restore:
 * the handler consumes the raw request stream. */
/* Bind the session from the header before checkpoint/restore. These run BEFORE
 * the first /execute on a relaunched VM, so in the hookless design nothing else
 * has bound the workspace yet; without this the handlers 409 and a real restore
 * silently continues with an empty workspace (checkpoint state lost on expiry).
 * Returns false (→ fail closed) when this request carries no valid header, so a
 * headerless/malformed request never operates on a stale prior session. */
type SessionBindFailure = { status: number; body: Record<string, string> };

/* Distinguishes the two ways a bind can fail, because the control plane acts on
 * them differently: a missing/malformed header is a caller error, while a
 * REJECTED bind means this runner is pinned to a DIFFERENT session and must be
 * recycled. Collapsing both into one generic 409 (as this did) hid the conflict
 * and left the VM in service. `session_workspace_dirty` is the established
 * recycle signal — the same code /execute returns for this condition. */
function bindSessionFromHeader(req: Request): SessionBindFailure | null {
  let binding;
  try {
    binding = parseSessionBindingFromHeader(req.headers[RUNTIME_SESSION_ID_HEADER]);
  } catch (error) {
    /* A duplicated or malformed header throws SessionWorkspaceBindingError; it
     * is a bad request, not a session conflict. */
    return {
      status: 400,
      body: { message: error instanceof Error ? error.message : 'Invalid runtime session header' },
    };
  }
  if (!binding) {
    return { status: 409, body: { message: 'Missing runtime session header' } };
  }
  if (bindSessionWorkspace(binding) == null) {
    return {
      status: 409,
      body: {
        error: 'session_workspace_dirty',
        message: 'Runner is bound to a different runtime session',
      },
    };
  }
  return null;
}

/* `.catch(next)` hands rejections (e.g. session.ownership()) to the error
 * middleware so they surface as a 5xx. Express 5 auto-forwards rejected
 * route-handler promises too, so this is now belt-and-braces; it was strictly
 * required under the previously pinned Express 4, where a rejection instead
 * hung the request and surfaced as an unhandled rejection. */
router.get('/session/checkpoint', (req: Request, res: Response, next: NextFunction) => {
  const failure = bindSessionFromHeader(req);
  if (failure) {
    return res.status(failure.status).json(failure.body);
  }
  const checkpoint = (): Promise<void> => streamSessionCheckpoint(res);
  return (config.hosted_apps_enabled
    ? hostedAppSupervisor.withQuiescedWorkspace(checkpoint)
    : checkpoint()
  ).catch(error => hostedAppFailure(error, res, next));
});
router.post('/session/restore', (req: Request, res: Response, next: NextFunction) => {
  const failure = bindSessionFromHeader(req);
  if (failure) {
    return res.status(failure.status).json(failure.body);
  }
  const restore = (): Promise<void> => restoreSessionCheckpoint(req, res);
  return (config.hosted_apps_enabled
    ? hostedAppSupervisor.withQuiescedWorkspace(restore)
    : restore()
  ).catch(error => hostedAppFailure(error, res, next));
});

function requireHostedAppTarget(
  _req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (!config.hosted_apps_enabled) {
    return res.status(404).json({ message: 'Not Found' });
  }
  next();
}

function hostedAppFailure(
  error: unknown,
  res: Response,
  next: NextFunction,
): Response | void {
  if (error instanceof HostedAppError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  next(error);
}

/* Dedicated Lambda MicroVM resident-server adapter. The control plane first
 * restores an immutable session checkpoint into this VM, then starts exactly
 * one foreground process. Preview traffic uses a separate AWS token restricted
 * to `hosted_app_port`; these control routes stay on the runner port. */
router.post(
  '/hosted-app/start',
  requireHostedAppTarget,
  express.json({ limit: '64kb' }),
  (req: Request, res: Response, next: NextFunction) => {
    const failure = bindSessionFromHeader(req);
    if (failure) return res.status(failure.status).json(failure.body);
    return hostedAppSupervisor.start(req.body)
      .then(status => res.status(200).json(status))
      .catch(error => hostedAppFailure(error, res, next));
  },
);

router.get(
  '/hosted-app/status',
  requireHostedAppTarget,
  (req: Request, res: Response) => {
    const failure = bindSessionFromHeader(req);
    if (failure) return res.status(failure.status).json(failure.body);
    const status = hostedAppSupervisor.status();
    if (!status) {
      return res.status(404).json({
        error: 'hosted_app_not_running',
        message: 'No hosted app has been started',
      });
    }
    return res.status(200).json(status);
  },
);

router.post(
  '/hosted-app/stop',
  requireHostedAppTarget,
  express.json({ limit: '1kb' }),
  (req: Request, res: Response, next: NextFunction) => {
    const failure = bindSessionFromHeader(req);
    if (failure) return res.status(failure.status).json(failure.body);
    return hostedAppSupervisor.stop()
      .then(status => status ? res.status(200).json(status) : res.status(204).send())
      .catch(error => hostedAppFailure(error, res, next));
  },
);
/**
 * Input delivery for backends whose sandbox cannot reach the file server.
 *
 * These are deliberately NOT session-scoped: the cache they fill is keyed by
 * (storage session, object id) and lives outside any workspace, so the same
 * mechanism serves stateful sessions and stateless one-shots alike. The
 * workspace is still only ever written by the normal priming path. The routes
 * are nevertheless Lambda-runner-only: Lambda's Runtime API supplies the
 * external bearer boundary, while ordinary shared runners must not expose an
 * unauthenticated cache-write surface.
 */
function requireSessionInputDeliveryTarget(
  _req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (!config.session_workspace_enabled) {
    return res.status(404).json({ message: 'Not Found' });
  }
  next();
}

/* No global body parser exists (see index.ts), so the probe installs its own.
 * A ref list is tiny — a few hundred bytes per entry — but bound it anyway. */
router.post(
  '/session/inputs/probe',
  requireSessionInputDeliveryTarget,
  express.json({ limit: '1mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refs = (req.body as { refs?: Array<{ cache_key?: unknown }> })?.refs;
      if (!Array.isArray(refs)) {
        return res.status(400).json({ message: 'refs must be an array' });
      }
      if (refs.length > SESSION_INPUT_CACHE_MAX_OBJECTS) {
        return res.status(400).json({
          message: `refs exceeds the ${SESSION_INPUT_CACHE_MAX_OBJECTS}-object limit`,
        });
      }
      const missing: Array<{ cache_key: string }> = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        if (typeof ref?.cache_key !== 'string' || !/^[0-9a-f]{64}$/.test(ref.cache_key)) {
          return res.status(400).json({ message: 'each ref requires a valid cache_key' });
        }
        if (seen.has(ref.cache_key)) {
          return res.status(400).json({ message: 'refs contains a duplicate cache_key' });
        }
        seen.add(ref.cache_key);
        if (!(await hasCachedInput('', '', ref.cache_key))) {
          missing.push({ cache_key: ref.cache_key });
        }
      }
      return res.status(200).json({ missing });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/session/inputs',
  requireSessionInputDeliveryTarget,
  async (req: Request, res: Response) => {
    try {
      const expandedHeader = req.get('x-codeapi-input-expanded-bytes');
      let expectedBytes: number | undefined;
      if (expandedHeader !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(expandedHeader)) {
          return res.status(400).json({ message: 'invalid expanded input byte count' });
        }
        expectedBytes = Number(expandedHeader);
        if (
          !Number.isSafeInteger(expectedBytes)
          || expectedBytes > config.input_cache_max_bytes
        ) {
          return res.status(400).json({ message: 'invalid expanded input byte count' });
        }
      }
      const stored = await storeCachedInputs(
        req,
        config.input_cache_max_bytes,
        expectedBytes,
      );
      await pruneInputCache(config.input_cache_max_bytes).catch((err) => {
        logger.warn({ err }, 'Failed to prune session input cache');
      });
      return res.status(200).json({ stored });
    } catch (error) {
      logger.error({ err: error }, 'Failed to store session inputs');
      return res.status(500).json({ message: 'session input delivery failed' });
    }
  },
);

export default router;
