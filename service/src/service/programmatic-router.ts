import axios from 'axios';
import { nanoid } from 'nanoid';
import { Router } from 'express';
import type { Response } from 'express';
import type { Queue, QueueEvents } from 'bullmq';
import type * as t from '../types';
import { checkServiceStartUp, checkServiceShutDown } from '../lifecycle';
import { executionLimiter } from '../middleware/limits';
import { pyQueue, pyQueueEvents, otherQueue, otherQueueEvents, connection } from '../queue';
import { createProgrammaticPayload, extractPendingFromStdout } from '../preamble';
import { findBashToolNameCollision } from '../preamble-bash';
import type { LCTool } from '../preamble';
import { isReservedPtcFilename } from '../ptc-constants';
import { internalServiceHeaders } from '../internal-service-auth';
import { resolveOutputBucketSessionKey, SessionKeyResolutionError } from '../session-key';
import { getCredentialId, getPrincipalOrReject } from '../auth/principal';
import { getExecutionIdentity } from '../execution-identity';
import { PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION } from '../runtime-session/job-policy';
import {
  jobsSubmitted,
  ptcReplayContinuations,
  ptcReplayContinuationDuration,
  ptcReplayLockContention,
  ptcReplayStateOversize,
} from '../metrics';
import { Jobs } from '../enum';
import { env, jobCompletionWaitTimeoutMs } from '../config';
import { resolveQueuedSandboxBackend } from '../execution-profile';
import {
  normalizeEgressGatewayUrl,
  normalizeProgrammaticTimeoutMs,
  prepareSandboxJobSecurity,
  sealPtcCallbackTokenForGateway,
  timeoutMsToGrantSeconds,
} from '../sandbox-egress';
import { findUnregisteredToolCall } from '../tool-scope';
import { summarizeRequestedFiles } from '../execution-log';
import { FileRefAuthorizationError, authorizeRequestedFiles } from './file-authorization';
import {
  buildReplayExecutionState,
  resolveReplayStateSandboxBackend,
} from './programmatic-state';
import {
  BridgeWorkerSelectionError,
  CODEAPI_BRIDGE_WORKER_HEADER,
  resolveBridgeWorkerSelection,
} from '../bridge/selection';
import logger from '../logger';
import {
  type ExecutionState,
  type HistoryEntry,
  EXECUTION_STATE_TTL,
  ExecutionStateTooLargeError,
  acquireExecutionLock,
  releaseExecutionLock,
  checkContinuationPreconditions,
  cleanupExecution,
  cleanupStaleExecutions,
  commitToolHistoryAndState,
  computeToolHistoryDelta,
  getBlockingResult,
  getExecutionState,
  loadToolHistory,
  refreshExecutionTtl,
  setExecutionError,
  setExecutionResult,
  setExecutionState,
  validateContinuationBatch,
} from './replay-state';

const { INSTANCE_ID } = env;
const POLL_INTERVAL = 100; // ms (blocking mode only)
const MAX_POLL_TIME = 300000; // 5 minutes (blocking mode only)
const TOOL_CALL_SERVER_RETRY_ATTEMPTS = 3;
const TOOL_CALL_SERVER_RETRY_DELAY = 1000; // ms
const MAX_TOOLS_PER_REQUEST = 100;
const STALE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEBUG_MODE = env.PTC_DEBUG;
const JOB_COMPLETION_WAIT_TIMEOUT_MS = jobCompletionWaitTimeoutMs(
  env.JOB_TIMEOUT,
  env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
  env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
);

const router = Router();

function sendFileRefAuthorizationError(
  error: unknown,
  res: Response,
  req?: t.AuthenticatedRequest,
): boolean {
  if (error instanceof FileRefAuthorizationError) {
    logger.warn('File reference authorization rejected', {
      status: error.status,
      reason: error.reason,
      message: error.message,
      requestUserId: req?.codeApiAuthContext?.userId,
      requestApiKeyId: req ? getCredentialId(req) : undefined,
      tenantId: req?.codeApiAuthContext?.tenantId,
      ...error.context,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

/**
 * Mirrors the helper in `router.ts`. Returns true when the error was
 * a SessionKeyResolutionError and the response was sent (with a logged
 * trail); false otherwise so the caller can rethrow.
 */
function sendSessionKeyResolutionError(
  error: unknown,
  res: Response,
  req: t.AuthenticatedRequest,
  context: string,
): boolean {
  if (error instanceof SessionKeyResolutionError) {
    logger.error(`sessionKey resolution failed (${context})`, {
      status: error.status,
      message: error.message,
      method: req.method,
      path: req.path,
      requestUserId: req.codeApiAuthContext?.userId,
      authContextUserId: req.codeApiAuthContext?.userId,
      tenantId: req.codeApiAuthContext?.tenantId,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

async function retryToolCallServerRequest<T>(
  requestFn: () => Promise<T>,
  context: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= TOOL_CALL_SERVER_RETRY_ATTEMPTS; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;
      if (axios.isAxiosError(error)) {
        if (error.response && error.response.status >= 400 && error.response.status < 500) {
          throw error;
        }
      }
      if (attempt < TOOL_CALL_SERVER_RETRY_ATTEMPTS) {
        logger.warn(`${context} failed (attempt ${attempt}/${TOOL_CALL_SERVER_RETRY_ATTEMPTS}), retrying...`, {
          error: lastError.message,
        });
        await new Promise(resolve => setTimeout(resolve, TOOL_CALL_SERVER_RETRY_DELAY * attempt));
      }
    }
  }

  logger.error(`${context} failed after ${TOOL_CALL_SERVER_RETRY_ATTEMPTS} attempts`);
  throw lastError;
}

/** Periodic janitor for replay/blocking executions whose `lastActivity`
 * has gone stale. Lives here (not in `replay-state.ts`) so a test that
 * imports `replay-state` directly doesn't accidentally start a background
 * timer the test process would have to clean up. */
setInterval(() => {
  cleanupStaleExecutions().catch(err => {
    logger.error('Cleanup interval error:', err);
  });
}, STALE_CLEANUP_INTERVAL_MS);

function generateContinuationToken(execution_id: string): string {
  return Buffer.from(JSON.stringify({ execution_id, ts: Date.now() })).toString('base64');
}

/** Map a replay-continuation HTTP status to its operational outcome
 *  category for the `ptcReplayContinuations` metric. The categories
 *  mirror the alert rules: lock_contention (409), oversize (413),
 *  retryable_error (503), client_error (any other 4xx), and a residual
 *  `success_or_pending` for 2xx — `runAndRespond` sets the body's
 *  `status` field but the HTTP layer here only sees the status code. */
function classifyContinuationOutcome(statusCode: number): string {
  if (statusCode === 409) return 'lock_contention';
  if (statusCode === 413) return 'oversize';
  if (statusCode === 503) return 'retryable_error';
  if (statusCode >= 400) return 'client_error';
  return 'success_or_pending';
}

/** Decode + validate a continuation token. Rejects tokens whose issue
 * timestamp is older than the execution-state TTL — without this, the
 * `ts` field was dead data and a client could replay an ancient token
 * against a freshly-reused-execution-id window. */
function decodeContinuationToken(token: string): { execution_id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const candidate = parsed as { execution_id?: unknown; ts?: unknown };
    if (typeof candidate.execution_id !== 'string' || candidate.execution_id.length === 0) {
      return null;
    }
    if (typeof candidate.ts === 'number' && Number.isFinite(candidate.ts)) {
      const ageMs = Date.now() - candidate.ts;
      if (ageMs > EXECUTION_STATE_TTL * 1000) {
        return null;
      }
    }
    return { execution_id: candidate.execution_id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blocking mode (legacy path)
// ---------------------------------------------------------------------------

async function waitForExecutionState(
  execution_id: string,
  timeout: number,
): Promise<{
  status: 'waiting' | 'completed' | 'error' | 'running';
  pending_calls?: t.ProgrammaticToolCall[];
  stdout?: string;
  stderr?: string;
  files?: t.FileRefs;
}> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const execution = await getExecutionState(execution_id);

    /** Result lives in the `exec_result:` key (see setBlockingResult). The
     * inline `execution.jobResult` branch is kept as a fallback so any
     * in-flight executions whose state was written by an older binary
     * mid-deploy still complete correctly without rolling back. */
    if (execution?.jobCompleted === true) {
      const result = (await getBlockingResult(execution_id)) ?? execution.jobResult;
      if (result) {
        return {
          status: 'completed',
          stdout: result.stdout,
          stderr: result.stderr,
          files: result.files,
        };
      }
    }

    if (execution?.jobError != null) {
      return { status: 'error' };
    }

    try {
      const pendingResponse = await retryToolCallServerRequest(
        () => axios.get<{
          status: string;
          pending_calls?: Array<{
            call_id: string;
            tool_name: string;
            tool_input: Record<string, unknown>;
            timestamp: number;
          }>;
        }>(`${env.TOOL_CALL_SERVER_URL}/sessions/${execution_id}/pending`, {
          headers: internalServiceHeaders(),
        }),
        'Get pending tool calls',
      );

      const { status, pending_calls } = pendingResponse.data;

      if (status === 'waiting' && pending_calls && pending_calls.length > 0) {
        return {
          status: 'waiting',
          pending_calls: pending_calls.map(call => ({
            id: call.call_id,
            name: call.tool_name,
            input: call.tool_input,
          })),
        };
      }

      if (status === 'completed') {
        const statusResponse = await retryToolCallServerRequest(
          () => axios.get<{
            status: string;
            stdout?: string;
            stderr?: string;
            files?: t.FileRefs;
          }>(`${env.TOOL_CALL_SERVER_URL}/sessions/${execution_id}/status`, {
            headers: internalServiceHeaders(),
          }),
          'Get execution status',
        );

        return {
          status: 'completed',
          stdout: statusResponse.data.stdout,
          stderr: statusResponse.data.stderr,
          files: statusResponse.data.files,
        };
      }

      if (status === 'error') {
        return { status: 'error' };
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const exec = await getExecutionState(execution_id);
        if (exec?.jobCompleted === true) {
          const result = (await getBlockingResult(execution_id)) ?? exec.jobResult;
          if (result) {
            return {
              status: 'completed',
              stdout: result.stdout,
              stderr: result.stderr,
              files: result.files,
            };
          }
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }
      throw error;
    }
  }

  return { status: 'error' };
}

// ---------------------------------------------------------------------------
// Replay mode helpers
// ---------------------------------------------------------------------------

interface QueueBinding {
  queue: Queue<t.JobData, t.JobResult, Jobs.execute>;
  events: QueueEvents;
  language: 'python' | 'bash';
}

function pickQueue(language: 'python' | 'bash'): QueueBinding {
  if (language === 'bash') {
    return { queue: otherQueue, events: otherQueueEvents, language: 'bash' };
  }
  return { queue: pyQueue, events: pyQueueEvents, language: 'python' };
}

function buildReplayPayload(
  req: t.AuthenticatedRequest,
  state: ExecutionState,
  history: Record<string, HistoryEntry>,
): t.PayloadBody {
  return createProgrammaticPayload({
    req,
    session_id: state.session_id,
    execution_id: state.execution_id,
    tools: (state.tools ?? []) as LCTool[],
    timeout: state.timeout,
    mode: 'replay',
    history,
    codeOverride: state.userCode,
    filesOverride: state.files,
    language: state.language ?? 'python',
  });
}

async function runReplayIteration(
  req: t.AuthenticatedRequest,
  state: ExecutionState,
  apiKeyId: string,
  userId: string,
): Promise<t.ExecuteResult> {
  const history = await loadToolHistory(state.execution_id);
  const rawPayload = buildReplayPayload(req, state, history);
  const sessionKey = state.sessionKey ?? state.userId;
  const sandboxSecurity = prepareSandboxJobSecurity({
    req,
    executionId: state.execution_id,
    userId,
    sessionKey,
    outputSessionId: state.session_id,
    payload: rawPayload,
    tenantId: state.tenantId,
    canonicalUserId: state.canonicalUserId,
    orgId: state.orgId,
    serviceId: state.serviceId,
    externalUserId: state.externalUserId,
    principalSource: state.principalSource,
    authContextHash: state.authContextHash,
  });

  if (DEBUG_MODE) {
    const firstFile = rawPayload.files[0] as { content?: string } | undefined;
    logger.debug('Replay enqueue details', {
      execution_id: state.execution_id,
      historySize: Object.keys(history).length,
      callCount: state.callCount ?? 0,
      toolCount: (state.tools ?? []).length,
      generatedCodeLength: firstFile?.content?.length ?? 0,
    });
  }

  const { queue, events, language } = pickQueue(state.language ?? 'python');
  const job = await queue.add(Jobs.execute, {
    code: state.userCode ?? '',
    userId,
    payload: sandboxSecurity.payload,
    apiKeyId,
    isPyPlot: state.isPyPlot ?? false,
    principalSource: state.principalSource,
    executionId: state.execution_id,
    tenantId: state.tenantId,
    canonicalUserId: state.canonicalUserId,
    executionProfile: env.EXECUTION_PROFILE,
    sandboxBackend:
      state.sandboxBackend ??
      (state.bridgeWorkerId != null
        ? 'remote-bridge'
        : resolveQueuedSandboxBackend(
            env.EXECUTION_PROFILE,
            env.SANDBOX_BACKEND,
            env.EXECUTION_PROFILE_SOURCE,
          )),
    ...(state.bridgeWorkerId != null ? { bridgeWorkerId: state.bridgeWorkerId } : {}),
    runtimeSessionMode: 'stateless',
    runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
    executionManifestClaims: sandboxSecurity.executionManifestClaims,
    egressGrantClaims: sandboxSecurity.egressGrantClaims,
    egressGrantToken: sandboxSecurity.egressGrantToken,
  }, {
    removeOnComplete: { age: 60, count: 1 },
    removeOnFail: { age: 180, count: 1 },
    attempts: 1,
  });
  jobsSubmitted.inc({ language });

  return job.waitUntilFinished(events, JOB_COMPLETION_WAIT_TIMEOUT_MS);
}

function isSandboxRunSuccess(result: t.ExecuteResult): boolean {
  if (result.code != null && result.code !== 0) return false;
  if (result.signal != null && result.signal !== '') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Replay-mode request handlers
// ---------------------------------------------------------------------------

async function handleReplayInitial(
  req: t.AuthenticatedRequest,
  res: Response,
  params: {
    apiKeyId: string;
    userId: string;
    bridgeWorkerId?: string;
  },
): Promise<void> {
  const { apiKeyId, userId, bridgeWorkerId } = params;
  const {
    code,
    tools,
    user_id,
    files,
  } = req.body as t.ProgrammaticRequestBody;
  let timeout: number;
  try {
    timeout = normalizeProgrammaticTimeoutMs((req.body as t.ProgrammaticRequestBody).timeout);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  /** Accept both `language` (canonical) and `lang` (legacy alias used
   * by `danny-avila/agents` bash PTC client). If both are present,
   * `language` wins. The body is read as `unknown` for these fields
   * because clients can send arbitrary values; the runtime guard below
   * is the safety net the static body type can't provide. */
  const rawBody = req.body as Record<string, unknown>;
  const requestedLanguage: unknown = rawBody.language ?? rawBody.lang;

  if (
    requestedLanguage !== undefined &&
    requestedLanguage !== 'python' &&
    requestedLanguage !== 'bash'
  ) {
    res.status(400).json({
      error: `Unsupported language "${String(requestedLanguage)}"; supported values are "python" and "bash"`,
    });
    return;
  }
  const language: 'python' | 'bash' = requestedLanguage === 'bash' ? 'bash' : 'python';

  if (!code) {
    res.status(400).json({ error: 'Missing required field: code' });
    return;
  }
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    res.status(400).json({ error: 'Missing required field: tools (must be a non-empty array)' });
    return;
  }
  if (tools.length > MAX_TOOLS_PER_REQUEST) {
    res.status(400).json({
      error: `Too many tools provided (${tools.length}). Maximum is ${MAX_TOOLS_PER_REQUEST}.`,
    });
    return;
  }
  if (Array.isArray(files)) {
    const collision = files.find(f => isReservedPtcFilename(f.name));
    if (collision) {
      res.status(400).json({
        error: `files[].name "${collision.name}" is reserved for PTC runtime and cannot be supplied by callers`,
      });
      return;
    }
  }
  if (language === 'bash') {
    const nameCollision = findBashToolNameCollision(tools as LCTool[]);
    if (nameCollision) {
      res.status(400).json({
        error: `Bash tool names "${nameCollision.firstName}" and "${nameCollision.secondName}" normalize to the same function identifier "${nameCollision.normalized}"; rename one to avoid collision`,
      });
      return;
    }
  }

  let authorizedFiles: t.RequestFile[];
  try {
    authorizedFiles = await authorizeRequestedFiles({
      req,
      files,
      store: connection,
    });
    (req.body as t.ProgrammaticRequestBody).files = authorizedFiles.length > 0 ? authorizedFiles : undefined;
  } catch (error) {
    if (sendFileRefAuthorizationError(error, res, req)) return;
    logger.error('Error authorizing replay file refs:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  /* Output bucket: hardcoded user-private. See router.ts /exec for the
   * full rationale; same gate, same shape. */
  let sessionKey: string;
  try {
    sessionKey = resolveOutputBucketSessionKey(req);
  } catch (error) {
    if (sendSessionKeyResolutionError(error, res, req, 'programmatic /exec: resolveOutputBucketSessionKey')) {
      return;
    }
    throw error;
  }

  const session_id = nanoid();
  const execution_id = nanoid();
  const authContext = req.codeApiAuthContext;
  const identity = getExecutionIdentity(req, userId);
  const isPyPlot = language === 'python' && (
    code.includes('import matplotlib') || code.includes('import seaborn')
  );

  await connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);

  const state = buildReplayExecutionState({
    executionId: execution_id,
    sessionId: session_id,
    sessionKey,
    userId,
    apiKeyId,
    authContext,
    identity,
    code,
    tools: tools as LCTool[],
    files: authorizedFiles.length > 0 ? authorizedFiles : undefined,
    isPyPlot,
    timeout,
    language,
    bridgeWorkerId,
    sandboxBackend: resolveReplayStateSandboxBackend({
      executionProfile: env.EXECUTION_PROFILE,
      executionProfileSource: env.EXECUTION_PROFILE_SOURCE,
      apiSandboxBackend: env.SANDBOX_BACKEND,
      bridgeWorkerId,
    }),
  });
  /** Replay mode persists the full request (`userCode` + `tools` + `files`)
   * inside `ExecutionState` so continuations can re-enqueue without the
   * client re-sending. A pathologically large but otherwise valid request
   * can serialize past `MAX_EXECUTION_STATE_BYTES`; surface that as a
   * deterministic 413 instead of letting the throw fall through to the
   * top-level handler and become an opaque 500. */
  try {
    await setExecutionState(state);
  } catch (err) {
    if (err instanceof ExecutionStateTooLargeError) {
      logger.warn('Rejecting replay request: ExecutionState exceeds Redis cap', {
        execution_id,
        userId,
        apiKeyId,
        bytes: err.bytes,
        cap: err.cap,
      });
      await connection.del(`session:${session_id}`).catch(() => {});
      ptcReplayStateOversize.inc();
      res.status(413).json({
        error: `Request too large: serialized execution state is ${err.bytes} bytes (max ${err.cap}). Reduce the size of "code", "tools", or "files".`,
      });
      return;
    }
    throw err;
  }

  logger.info('Programmatic execution request received (replay)', {
    userId,
    apiKeyId,
    user: user_id,
    session_id,
    execution_id,
    language,
    toolCount: tools.length,
    codeLength: code.length,
    files: summarizeRequestedFiles(authorizedFiles),
    sessionKey,
    timeout,
  });

  await runAndRespond(req, res, state, apiKeyId, userId);
}

async function handleReplayContinuation(
  req: t.AuthenticatedRequest,
  res: Response,
  params: {
    apiKeyId: string;
    userId: string;
    decoded: { execution_id: string };
    tool_results: NonNullable<t.ProgrammaticRequestBody['tool_results']>;
  },
): Promise<void> {
  const { apiKeyId, userId, decoded, tool_results } = params;

  /** Record the outcome of every replay continuation in one place via
   * `res.on('finish')` so each early-return branch (lock contention,
   * 4xx validation, 413 oversize, 200 success) is covered without
   * threading a label through every code path. The status-code -> outcome
   * mapping mirrors the operational categories used by alert rules:
   *   - 409 -> lock_contention      (concurrent continuation)
   *   - 413 -> oversize             (state cap exceeded)
   *   - 503 -> retryable_error      (transient Redis/transport failure)
   *   - 4xx -> client_error
   *   - 200 -> the response body's `status` field; `runAndRespond` sets
   *            the same `status: 'tool_call_required' | 'success' | 'error'`
   *            field, but we only observe the HTTP layer here, so 200 is
   *            simply `success_or_pending` until a follow-up commit
   *            adds outcome plumbing through `runAndRespond`. */
  const startMs = performance.now();
  res.once('finish', () => {
    const labels = { mode: 'replay' as const, outcome: classifyContinuationOutcome(res.statusCode) };
    ptcReplayContinuations.inc(labels);
    ptcReplayContinuationDuration.observe(labels, (performance.now() - startMs) / 1000);
  });

  /** Reject oversized batches before we spend any CPU on per-entry
   * validation or Redis round-trips. The pure-validation pipeline
   * (length cap, per-entry shape, dup detection) lives in
   * `validateContinuationBatch` so the branch coverage is unit-testable
   * without a router/queue harness. */
  const batch = validateContinuationBatch(tool_results);
  if (!batch.ok) {
    res.status(batch.status).json({ error: batch.error });
    return;
  }
  const validatedResults = batch.results;

  const lockToken = await acquireExecutionLock(decoded.execution_id);
  if (lockToken == null) {
    ptcReplayLockContention.inc();
    res.status(409).json({
      error: 'Another continuation is already in flight for this execution; retry shortly',
    });
    return;
  }

  try {
    const state = await getExecutionState(decoded.execution_id);

    if (!state) {
      res.status(404).json({ error: 'Execution not found or expired' });
      return;
    }
    /** Compute the delta against already-persisted history first so the
     * cap checks see the real impact of this batch (new call_ids only
     * advance `callCount`; overwrites may shrink or grow `historyBytes`
     * by a signed delta). Without this, an at-least-once client retry
     * could either trip `MAX_REPLAY_CALLS` and reap a still-valid
     * execution, or slip a larger mutated result past the aggregate
     * history cap. */
    const emittedById = new Map(
      (state.emittedToolCalls ?? []).map(call => [call.id, call]),
    );
    const enrichedResults = validatedResults.map(result => {
      const emitted = emittedById.get(result.call_id);
      if (emitted == null) return result;
      return {
        ...result,
        tool_name: emitted.name,
        input_hash: emitted.input_hash,
        call_site: emitted.call_site,
      };
    });
    const deltaOrError = await computeToolHistoryDelta(state.execution_id, enrichedResults);
    if ('error' in deltaOrError) {
      res.status(deltaOrError.status ?? 400).json({ error: deltaOrError.error });
      return;
    }
    const delta = deltaOrError;
    /** Mode/auth/issued-call-id/cap checks are pure functions of state
     * + input; the helper centralizes the branch logic so it's
     * exhaustively unit-testable in `test-replay-state.ts`. */
    const identity = getExecutionIdentity(req, userId);
    const pre = checkContinuationPreconditions({
      state,
      results: enrichedResults,
      userId,
      apiKeyId,
      tenantId: identity.storageNamespace,
      authContextHash: req.codeApiAuthContext?.authContextHash,
      delta,
    });
    if (!pre.ok) {
      if (pre.status === 403) {
        logger.warn('Unauthorized replay continuation request rejected', {
          execution_id: state.execution_id,
          requestUserId: userId,
          requestApiKeyId: apiKeyId,
          requestTenantId: identity.storageNamespace,
          executionUserId: state.userId,
          executionApiKeyId: state.apiKeyId,
          executionTenantId: state.tenantId,
        });
      }
      if (pre.cleanupOnReject === true) {
        await cleanupExecution(state.execution_id, 'replay');
      }
      res.status(pre.status).json({ error: pre.error });
      return;
    }

    logger.info('Replay continuation received', {
      execution_id: state.execution_id,
      resultCount: validatedResults.length,
      newCallCount: delta.newCallIds.length,
      prevCallCount: state.callCount ?? 0,
      prevHistoryBytes: state.historyBytes ?? 0,
      bytesDelta: delta.bytesDelta,
    });

    /** Build the projected state then commit history + state in one
     * Redis MULTI/EXEC so counters and the hash can't drift out of sync
     * on a partial failure. */
    state.callCount = (state.callCount ?? 0) + delta.newCallIds.length;
    state.historyBytes = Math.max(0, (state.historyBytes ?? 0) + delta.bytesDelta);
    state.lastActivity = Date.now();
    try {
      await commitToolHistoryAndState(state, delta);
    } catch (err) {
      if (err instanceof ExecutionStateTooLargeError) {
        /** Same shape as the other replay-path 413 (see
         * `handleReplayContinuation` post-iteration block): the
         * persisted state in Redis is still the pre-commit version
         * because the cap check fires before MULTI/EXEC, but the
         * client can't shrink an already-issued batch of tool_results
         * to retry the same continuation token, so the only path
         * forward is a fresh execution with smaller inputs. Reap the
         * old execution to free the lock and Redis keys, then return
         * an actionable 413 instead of a generic 500. */
        logger.warn('Replay continuation rejected: ExecutionState exceeds Redis cap', {
          execution_id: state.execution_id,
          bytes: err.bytes,
          cap: err.cap,
          callCount: state.callCount,
          historyBytes: state.historyBytes,
        });
        await cleanupExecution(state.execution_id, 'replay').catch(() => {});
        ptcReplayStateOversize.inc();
        res.status(413).json({
          status: 'error',
          error: `Replay state grew too large (${err.bytes} bytes, max ${err.cap}). The execution accumulated more state than can be safely persisted; restart with a smaller request or break work into multiple executions.`,
          session_id: state.session_id,
        });
        return;
      }
      /** Non-cap failures here are transient Redis problems: a
       * MULTI/EXEC abort, a connection blip, a missing key during the
       * transaction, etc. The transaction is atomic, so on failure
       * neither `tool_history` nor `exec_state` was mutated — the
       * persisted state is still the pre-commit version, the
       * continuation token is still valid, and `computeToolHistoryDelta`
       * is idempotent via `call_id` dedup, so the same client can
       * retry the same request and have it succeed once Redis recovers.
       * Surface that explicitly as a retryable 503 instead of letting
       * the throw bubble to the top-level catch and become an opaque
       * 500 — clients (and load balancers) treat 5xx classes very
       * differently for retry policy. */
      logger.error('Failed to commit replay continuation; returning retryable 503', {
        execution_id: state.execution_id,
        err: (err as Error).message,
      });
      res.status(503).json({
        status: 'error',
        error: 'Failed to persist replay continuation; please retry the same request',
        session_id: state.session_id,
      });
      return;
    }
    if (delta.newCallIds.length !== validatedResults.length) {
      logger.info('Idempotent continuation retry detected', {
        execution_id: state.execution_id,
        total: validatedResults.length,
        new: delta.newCallIds.length,
        bytesDelta: delta.bytesDelta,
      });
    }

    await runAndRespond(req, res, state, apiKeyId, userId);
  } finally {
    await releaseExecutionLock(decoded.execution_id, lockToken);
  }
}

async function runAndRespond(
  req: t.AuthenticatedRequest,
  res: Response,
  state: ExecutionState,
  apiKeyId: string,
  userId: string,
): Promise<void> {
  /** Read disconnect state through `isDisconnected()` rather than a
   * direct boolean. The `req.on('close', ...)` handler flips the flag
   * during awaits, but `@typescript-eslint/no-unnecessary-condition`
   * (correctly per TS semantics) narrows a directly-mutated `let`/object
   * member to its literal value after an early-return `if (...) return`,
   * even across awaits. A function call is opaque to that narrowing. */
  let disconnected = false;
  const isDisconnected = (): boolean => disconnected;
  req.on('close', () => {
    if (!res.writableEnded) disconnected = true;
  });

  let result: t.ExecuteResult;
  try {
    result = await runReplayIteration(req, state, apiKeyId, userId);
  } catch (err) {
    logger.error('Replay iteration failed', { execution_id: state.execution_id, err });
    await cleanupExecution(state.execution_id, 'replay');
    if (!isDisconnected()) {
      const message = (err as Error).message;
      res.status(200).json({
        status: 'error',
        error: message !== '' ? message : 'Sandbox execution failed',
        session_id: state.session_id,
      });
    }
    return;
  }

  if (isDisconnected()) {
    logger.info('Client disconnected during replay; cleaning up', {
      execution_id: state.execution_id,
    });
    await cleanupExecution(state.execution_id, 'replay');
    return;
  }

  const { stdout: cleanStdout, pending } = extractPendingFromStdout(
    result.stdout,
    state.execution_id,
  );

  if (pending != null) {
    if (pending.length === 0) {
      logger.error('Sentinel emitted with empty pending array', {
        execution_id: state.execution_id,
      });
      await cleanupExecution(state.execution_id, 'replay');
      res.status(200).json({
        status: 'error',
        error: 'sandbox emitted an empty pending tool call block; aborting to avoid a tight retry loop',
        stdout: cleanStdout,
        stderr: result.stderr,
        session_id: state.session_id,
      });
      return;
    }
    const unregisteredToolCall = findUnregisteredToolCall(pending, state.tools);
    if (unregisteredToolCall != null) {
      logger.warn('Sandbox requested unregistered replay tool call', {
        execution_id: state.execution_id,
        call_id: unregisteredToolCall.call_id,
        tool_name: unregisteredToolCall.tool_name,
      });
      await cleanupExecution(state.execution_id, 'replay');
      res.status(200).json({
        status: 'error',
        error: `Sandbox requested an unregistered tool: ${unregisteredToolCall.tool_name}`,
        stdout: cleanStdout,
        stderr: result.stderr,
        session_id: state.session_id,
      });
      return;
    }
    /** Record the call_ids we just handed to the client as "issued" so
     * the next continuation can reject any `tool_results[i].call_id`
     * that was never actually requested. Replay then treats persisted
     * history as ground truth and a forged id (e.g. `call_042`) would
     * otherwise be served as a cache hit on the next sandbox run,
     * silently skipping the real tool call the user code makes. */
    const alreadyIssued = new Set(state.emittedCallIds ?? []);
    const emittedToolCalls = new Map(
      (state.emittedToolCalls ?? []).map(call => [call.id, call]),
    );
    for (const p of pending) {
      alreadyIssued.add(p.call_id);
      emittedToolCalls.set(p.call_id, {
        id: p.call_id,
        name: p.tool_name,
        input_hash: p.input_hash,
        call_site: p.call_site,
      });
    }
    state.emittedCallIds = Array.from(alreadyIssued);
    state.emittedToolCalls = Array.from(emittedToolCalls.values());
    /** Refresh both exec_state and tool_history TTLs before handing a
     * continuation token back to the client. The sandbox run we just
     * awaited can take several minutes for heavy user code; without this,
     * the remaining Redis TTLs shrink proportionally and a slow client
     * may hit either a 404 on the token or a silent history loss that
     * forces the sandbox to re-emit earlier calls on replay. Also resets
     * `lastActivity` for the stale-execution sweeper. */
    state.lastActivity = Date.now();
    /** Persist the updated state (including `emittedCallIds` and the
     * fresh `lastActivity`) and refresh both Redis key TTLs BEFORE
     * issuing the continuation token. If either write fails, the client
     * would otherwise hold a token whose `call_id`s aren't in the
     * persisted `emittedCallIds` set — the next continuation would
     * reject every result as "not issued" — and whose TTLs may have
     * already started counting down from the pre-iteration values.
     * Tear the execution down and return a retryable 503 so the client
     * can resubmit from scratch rather than burning retries against a
     * half-committed state. */
    try {
      await setExecutionState(state);
      await refreshExecutionTtl(state.execution_id);
    } catch (err) {
      logger.error('Failed to persist execution state before continuation; aborting', {
        execution_id: state.execution_id,
        err: (err as Error).message,
      });
      await cleanupExecution(state.execution_id, 'replay').catch(() => {});
      if (!isDisconnected()) {
        if (err instanceof ExecutionStateTooLargeError) {
          /** A continuation that pushes `emittedCallIds` past the
           * `MAX_EXECUTION_STATE_BYTES` cap is a client-input sizing
           * issue (too many tool calls in a single execution), not a
           * server failure. Surface 413 so the client doesn't burn
           * retries against the same oversized state. */
          ptcReplayStateOversize.inc();
          res.status(413).json({
            status: 'error',
            error: `Replay state grew too large (${err.bytes} bytes, max ${err.cap}). The execution accumulated more state than can be safely persisted; restart with a smaller request or break work into multiple executions.`,
            session_id: state.session_id,
          });
        } else {
          res.status(503).json({
            status: 'error',
            error:
              'Failed to persist replay state; please retry the request from scratch',
            session_id: state.session_id,
          });
        }
      }
      return;
    }
    res.status(200).json({
      status: 'tool_call_required',
      continuation_token: generateContinuationToken(state.execution_id),
      tool_calls: pending.map(p => ({
        id: p.call_id,
        name: p.tool_name,
        input: p.input,
      })),
      partial_stdout: cleanStdout || undefined,
      partial_stderr: result.stderr || undefined,
      session_id: state.session_id,
    });
    return;
  }

  if (!isSandboxRunSuccess(result)) {
    await cleanupExecution(state.execution_id, 'replay');
    const errorMessage = result.message != null && result.message !== ''
      ? result.message
      : `Sandbox exited with code ${result.code ?? 'unknown'}`;
    res.status(200).json({
      status: 'error',
      error: errorMessage,
      stdout: cleanStdout,
      stderr: result.stderr,
      session_id: state.session_id,
    });
    return;
  }

  // Completed cleanly.
  await cleanupExecution(state.execution_id, 'replay');
  res.status(200).json({
    status: 'completed',
    stdout: cleanStdout,
    stderr: result.stderr,
    files: result.files,
    session_id: state.session_id,
  });
}

// ---------------------------------------------------------------------------
// Request entrypoint
// ---------------------------------------------------------------------------

router.post('/exec/programmatic', executionLimiter, async (req: t.AuthenticatedRequest, res) => {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return;
  const apiKeyId = getCredentialId(req);
  const userId = principal.userId;

  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'Service is shutting down' });
  }
  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'Service is starting up' });
  }

  const {
    continuation_token,
    tool_results,
  } = req.body as t.ProgrammaticRequestBody;
  const rawBody = req.body as Record<string, unknown>;
  const requestedLanguage: unknown = rawBody.language ?? rawBody.lang;
  let bridgeWorkerId: string | undefined;
  if (continuation_token == null || continuation_token === '') {
    try {
      const bridgeSelection = resolveBridgeWorkerSelection({
        backend: env.SANDBOX_BACKEND,
        configuredWorkerId: env.BRIDGE_WORKER_ID,
        dynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
        requestedWorkerId: req.header(CODEAPI_BRIDGE_WORKER_HEADER),
        trustedWorkerId: principal.codeWorkerId,
      });
      bridgeWorkerId = bridgeSelection?.explicit === true
        ? bridgeSelection.workerId
        : undefined;
    } catch (error) {
      if (error instanceof BridgeWorkerSelectionError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  }

  if (
    requestedLanguage !== undefined &&
    requestedLanguage !== 'python' &&
    requestedLanguage !== 'bash'
  ) {
    return res.status(400).json({
      error: `Unsupported language "${String(requestedLanguage)}"; supported values are "python" and "bash"`,
    });
  }

  try {
    /** For continuations, peek at the stored execution to route by the
     * mode it was started in rather than the current process default.
     * Without this, a replay-mode execution resumed via an instance
     * running in blocking mode (rollback / mixed fleet during rollout)
     * would be forced down `handleBlocking`, fail on the missing
     * sandbox session, and cleanup an otherwise-valid execution —
     * dropping the client's continuation mid-flow. Cheap Redis GET;
     * the chosen handler re-loads under the per-execution lock. */
    if (continuation_token != null && continuation_token !== '') {
      if (!Array.isArray(tool_results)) {
        return res.status(400).json({
          error: 'tool_results must be an array when continuation_token is provided',
        });
      }
      if (tool_results.length === 0) {
        return res.status(400).json({
          error: 'tool_results must be a non-empty array; resubmit with at least one result per pending tool call',
        });
      }
      const decoded = decodeContinuationToken(continuation_token);
      if (!decoded) {
        return res.status(400).json({ error: 'Invalid continuation token' });
      }
      const existing = await getExecutionState(decoded.execution_id);
      if (existing?.mode === 'replay') {
        return await handleReplayContinuation(req, res, {
          apiKeyId,
          userId,
          decoded,
          tool_results,
        });
      }
      return await handleBlocking(req, res, { apiKeyId, userId });
    }

    /** Initial requests use the process-level default. `language: bash`
     * still requires replay mode because the bash preamble has no
     * blocking-mode equivalent. */
    if (env.PTC_MODE !== 'replay' && requestedLanguage === 'bash') {
      return res.status(400).json({
        error: 'language "bash" is only supported when PTC_MODE=replay',
      });
    }
    if (env.PTC_MODE === 'replay') {
      return await handleReplayInitial(req, res, { apiKeyId, userId, bridgeWorkerId });
    }
    return await handleBlocking(req, res, { apiKeyId, userId, bridgeWorkerId });
  } catch (err) {
    logger.error(`[${INSTANCE_ID}] Programmatic routing error:`, err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// Blocking-mode handler (extracted from the original implementation).
// Kept intact behind `PTC_MODE=blocking` for a clean rollout/rollback path.
// ---------------------------------------------------------------------------

async function handleBlocking(
  req: t.AuthenticatedRequest,
  res: Response,
  params: { apiKeyId: string; userId: string; bridgeWorkerId?: string },
): Promise<void | ReturnType<typeof res.status>> {
  const { apiKeyId, userId, bridgeWorkerId } = params;
  const {
    code,
    tools,
    user_id,
    files,
    continuation_token,
    tool_results,
  } = req.body as t.ProgrammaticRequestBody;
  let timeout: number;
  try {
    timeout = normalizeProgrammaticTimeoutMs((req.body as t.ProgrammaticRequestBody).timeout);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }

  // CASE 1: Continuation
  if (continuation_token != null && continuation_token !== '' && tool_results) {
    const decoded = decodeContinuationToken(continuation_token);
    if (!decoded) {
      return res.status(400).json({ error: 'Invalid continuation token' });
    }

    const { execution_id } = decoded;
    const execution = await getExecutionState(execution_id);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found or expired' });
    }

    const identity = getExecutionIdentity(req, userId);
    if (
      execution.userId !== userId ||
      (execution.apiKeyId != null && execution.apiKeyId !== apiKeyId) ||
      (
        execution.tenantId != null &&
        execution.tenantId !== identity.storageNamespace
      ) ||
      (
        execution.authContextHash != null &&
        execution.authContextHash !== req.codeApiAuthContext?.authContextHash
      )
    ) {
      logger.warn('Unauthorized blocking continuation request rejected', {
        execution_id,
        requestUserId: userId,
        requestApiKeyId: apiKeyId,
        requestTenantId: identity.storageNamespace,
        executionUserId: execution.userId,
        executionApiKeyId: execution.apiKeyId,
        executionTenantId: execution.tenantId,
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    logger.info('Continuation request received', {
      execution_id,
      resultCount: tool_results.length,
    });

    execution.lastActivity = Date.now();
    await setExecutionState(execution);

    try {
      await retryToolCallServerRequest(
        () => axios.post(`${env.TOOL_CALL_SERVER_URL}/sessions/${execution_id}/results`, {
          results: tool_results.map(r => ({
            call_id: r.call_id,
            result: r.result,
            is_error: r.is_error ?? false,
            error_message: r.error_message,
          })),
        }, { headers: internalServiceHeaders() }),
        'Submit tool results',
      );

      const state = await waitForExecutionState(execution_id, timeout);

      if (state.status === 'waiting' && state.pending_calls) {
        return res.status(200).json({
          status: 'tool_call_required',
          continuation_token: generateContinuationToken(execution_id),
          tool_calls: state.pending_calls,
          session_id: execution.session_id,
        });
      }

      if (state.status === 'completed') {
        await cleanupExecution(execution_id, 'blocking');
        return res.status(200).json({
          status: 'completed',
          stdout: state.stdout ?? '',
          stderr: state.stderr ?? '',
          files: state.files ?? [],
          session_id: execution.session_id,
        });
      }

      await cleanupExecution(execution_id, 'blocking');
      return res.status(200).json({
        status: 'error',
        error: 'Execution failed or timed out',
        session_id: execution.session_id,
      });
    } catch (error) {
      logger.error('Error processing continuation:', error);
      await cleanupExecution(execution_id, 'blocking');
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // CASE 2: Initial execution
  if (!code) {
    return res.status(400).json({ error: 'Missing required field: code' });
  }
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return res.status(400).json({ error: 'Missing required field: tools (must be a non-empty array)' });
  }
  if (tools.length > MAX_TOOLS_PER_REQUEST) {
    logger.warn(`Too many tools provided: ${tools.length}, limit is ${MAX_TOOLS_PER_REQUEST}`, {
      execution_id: 'pre-creation',
      userId,
      toolCount: tools.length,
    });
    return res.status(400).json({
      error: `Too many tools provided (${tools.length}). Maximum is ${MAX_TOOLS_PER_REQUEST}.`,
    });
  }
  if (Array.isArray(files)) {
    const collision = files.find(f => isReservedPtcFilename(f.name));
    if (collision) {
      return res.status(400).json({
        error: `files[].name "${collision.name}" is reserved for PTC runtime and cannot be supplied by callers`,
      });
    }
  }

  let authorizedFiles: t.RequestFile[];
  try {
    authorizedFiles = await authorizeRequestedFiles({
      req,
      files,
      store: connection,
    });
    (req.body as t.ProgrammaticRequestBody).files = authorizedFiles.length > 0 ? authorizedFiles : undefined;
  } catch (error) {
    if (sendFileRefAuthorizationError(error, res, req)) return;
    logger.error('Error authorizing programmatic file refs:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  /* Output bucket: hardcoded user-private. See router.ts /exec for the
   * full rationale. */
  let sessionKey: string;
  try {
    sessionKey = resolveOutputBucketSessionKey(req);
  } catch (error) {
    if (sendSessionKeyResolutionError(error, res, req, 'programmatic /exec-blocking: resolveOutputBucketSessionKey')) {
      return;
    }
    throw error;
  }

  const session_id = nanoid();
  const execution_id = nanoid();
  const identity = getExecutionIdentity(req, userId);

  connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);

  const executionState: ExecutionState = {
    execution_id,
    session_id,
    sessionKey,
    userId,
    tenantId: identity.storageNamespace,
    canonicalUserId: identity.canonicalUserId,
    orgId: identity.orgId,
    serviceId: identity.serviceId,
    externalUserId: identity.externalUserId,
    principalSource: identity.principalSource,
    authContextHash: identity.authContextHash,
    apiKeyId,
    bridgeWorkerId,
    startTime: Date.now(),
    lastActivity: Date.now(),
    mode: 'blocking',
  };
  await setExecutionState(executionState);

  try {
    logger.info('Programmatic execution request received', {
      userId,
      apiKeyId,
      user: user_id,
      session_id,
      execution_id,
      toolCount: tools.length,
      codeLength: code.length,
      files: summarizeRequestedFiles(authorizedFiles),
      sessionKey,
      timeout,
    });

    let callbackUrl: string;
    try {
      callbackUrl = normalizeEgressGatewayUrl(env.EGRESS_GATEWAY_URL);
    } catch (error) {
      logger.error('Blocking PTC requires egress gateway callback URL:', error);
      await cleanupExecution(execution_id, 'blocking');
      return res.status(503).json({ error: 'Egress gateway unavailable' });
    }

    let callbackToken: string;

    try {
      const toolCallResponse = await retryToolCallServerRequest(
        () => axios.post<{
          success: boolean;
          callback_token: string;
        }>(`${env.TOOL_CALL_SERVER_URL}/sessions`, {
          execution_id,
          session_id,
          timeout,
          tools,
        }, { headers: internalServiceHeaders() }),
        'Create Tool Call Server session',
      );

      callbackToken = await sealPtcCallbackTokenForGateway({
        executionId: execution_id,
        sessionId: session_id,
        callbackToken: toolCallResponse.data.callback_token,
        timeoutSeconds: timeoutMsToGrantSeconds(timeout),
        allowedToolNames: tools.map(tool => tool.name),
      });
    } catch (error) {
      logger.error('Failed to create Tool Call Server session or callback token:', error);
      await cleanupExecution(execution_id, 'blocking');
      return res.status(503).json({ error: 'Tool Call Server unavailable' });
    }

    let rawPayload: t.PayloadBody;
    try {
      rawPayload = createProgrammaticPayload({
        req,
        session_id,
        execution_id,
        callbackUrl,
        callbackToken,
        tools: tools as LCTool[],
        timeout,
      });
    } catch (error) {
      logger.error('Failed to create payload', { execution_id, error: (error as Error).message });
      await cleanupExecution(execution_id, 'blocking');
      return res.status(400).json({
        error: (error as Error).message || 'Failed to generate code payload',
      });
    }
    const sandboxSecurity = prepareSandboxJobSecurity({
      req,
      executionId: execution_id,
      userId,
      sessionKey,
      outputSessionId: session_id,
      payload: rawPayload,
    });

    const job = await pyQueue.add(Jobs.execute, {
      code,
      userId,
      payload: sandboxSecurity.payload,
      apiKeyId,
      isPyPlot: false,
      principalSource: identity.principalSource,
      executionId: execution_id,
      tenantId: identity.storageNamespace,
      canonicalUserId: identity.canonicalUserId,
      executionProfile: env.EXECUTION_PROFILE,
      sandboxBackend: resolveQueuedSandboxBackend(
        env.EXECUTION_PROFILE,
        env.SANDBOX_BACKEND,
        env.EXECUTION_PROFILE_SOURCE,
      ),
      ...(bridgeWorkerId != null ? { bridgeWorkerId } : {}),
      runtimeSessionMode: 'stateless',
      runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
      executionManifestClaims: sandboxSecurity.executionManifestClaims,
      egressGrantClaims: sandboxSecurity.egressGrantClaims,
      egressGrantToken: sandboxSecurity.egressGrantToken,
    }, {
      removeOnComplete: { age: 60, count: 1 },
      removeOnFail: { age: 180, count: 1 },
      attempts: 1,
      jobId: session_id,
    });
    jobsSubmitted.inc({ language: 'python' });

    logger.info('Job queued, polling for tool calls', { execution_id, session_id });

    let clientDisconnected = false;
    req.on('close', async () => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      logger.warn(`Client disconnected for execution ${execution_id}`);
      try {
        await job.remove();
        await cleanupExecution(execution_id, 'blocking');
      } catch (error) {
        logger.error('Error cleaning up after client disconnect:', error);
      }
    });

    job.waitUntilFinished(pyQueueEvents, JOB_COMPLETION_WAIT_TIMEOUT_MS)
      .then(async (result) => {
        if (clientDisconnected) return;
        await setExecutionResult(execution_id, result);
      })
      .catch(async (error) => {
        if (clientDisconnected) return;
        await setExecutionError(execution_id, error);
      });

    const state = await waitForExecutionState(execution_id, Math.min(timeout, MAX_POLL_TIME));

    if (state.status === 'waiting' && state.pending_calls) {
      return res.status(200).json({
        status: 'tool_call_required',
        continuation_token: generateContinuationToken(execution_id),
        tool_calls: state.pending_calls,
        session_id,
      });
    }

    if (state.status === 'completed') {
      await cleanupExecution(execution_id, 'blocking');
      return res.status(200).json({
        status: 'completed',
        stdout: state.stdout ?? '',
        stderr: state.stderr ?? '',
        files: state.files ?? [],
        session_id,
      });
    }

    await cleanupExecution(execution_id, 'blocking');
    return res.status(200).json({
      status: 'error',
      error: 'Execution failed or timed out',
      session_id,
    });
  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | Execution ID: ${execution_id} | Error:`, error);
    await cleanupExecution(execution_id, 'blocking');
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default router;
