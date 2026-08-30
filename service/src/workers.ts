import axios from 'axios';
import { Worker } from 'bullmq';
import type * as t from './types';
import { filterSystemLogs, applySystemReplacements, getAxiosErrorDetails, sandboxErrorMessageFromAxios } from './utils';
import { jobProcessingDuration, jobsCompleted, jobsFailed, activeJobs, workerRunning } from './metrics';
import { connection, queueNames } from './queue';
import { env, jobDeadlineAtMs } from './config';
import { summarizeSandboxResponse, summarizeText } from './execution-log';
import { createGatewayEgressGrant, restoreGatewaySandboxResult, revokeGatewayEgressGrant } from './egress-gateway-client';
import { refreshEgressGrantClaims } from './sandbox-egress';
import { buildSandboxExecuteRequest } from './sandbox-dispatch';
import { prepareInputDelivery } from './runtime-session/input-delivery';
import { SessionFilesError } from './runtime-session/files';
import { resolveRuntimeSessionForJob } from './runtime-session/job-policy';
import { getSandboxBackend, SandboxBackendError, type SandboxRawResponse } from './sandbox-backend';
import { isSyntheticPrincipalSource } from './auth/synthetic';
import { withSpan, withTraceContext } from './telemetry';
import { workerDeadlineFailure } from './worker-error';
import logger from './logger';
import {
  validateQueuedExecutionProfile,
  validateQueuedSandboxBackend,
} from './execution-profile';

const { INSTANCE_ID } = env;
const WORKER_ID = `${INSTANCE_ID}-${process.pid}`;

function isAbortError(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.name === 'AbortError' || error.code === 'ERR_CANCELED');
}

async function processJob(job: t.ExecuteJob): Promise<t.ExecuteResult> {
  return withTraceContext(job.data._otel, () => withSpan('codeapi.job.process', {
    'messaging.system': 'bullmq',
    'messaging.operation.name': 'process',
    'messaging.message.id': typeof job.id === 'string' ? job.id : String(job.id ?? ''),
    'codeapi.language': job.data.payload?.language ?? 'unknown',
    'codeapi.execution_profile': job.data.executionProfile ?? 'legacy',
    'codeapi.worker_execution_profile': env.EXECUTION_PROFILE,
  }, () => processJobInner(job), 'CONSUMER'));
}

async function processJobInner(job: t.ExecuteJob): Promise<t.ExecuteResult> {
  const { payload, isPyPlot } = job.data;
  const isSyntheticJob = job.data.isSynthetic === true || isSyntheticPrincipalSource(job.data.principalSource);
  const language = payload?.language ?? 'unknown';
  const endTimer = jobProcessingDuration.startTimer({ language });
  activeJobs.inc({ language });

  const controller = new AbortController();
  const deadlineAtMs = jobDeadlineAtMs(job.timestamp, env.JOB_TIMEOUT);
  const remainingBudgetMs = Math.max(0, deadlineAtMs - Date.now());
  const timer = remainingBudgetMs > 0
    ? setTimeout(() => controller.abort(), remainingBudgetMs)
    : undefined;
  if (remainingBudgetMs === 0) controller.abort();
  let egressGrantId: string | undefined;
  let egressGrantTokenForRestore: string | undefined;
  let revokeReason = 'completed';

  try {
    if (controller.signal.aborted) {
      throw new Error(`Job timed out after ${env.JOB_TIMEOUT}ms`);
    }
    validateQueuedExecutionProfile(job.data.executionProfile, env.EXECUTION_PROFILE);
    validateQueuedSandboxBackend(job.data.sandboxBackend, env.SANDBOX_BACKEND);
    let sandboxPayload = payload;
    let executionManifestClaims = job.data.executionManifestClaims;
    let egressGrantToken = job.data.egressGrantToken;

    if (job.data.egressGrantClaims) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const prepared = await createGatewayEgressGrant({
        payload,
        claims: refreshEgressGrantClaims(job.data.egressGrantClaims, nowSeconds),
        isSynthetic: isSyntheticJob,
        signal: controller.signal,
      });
      egressGrantId = prepared.grant_id;
      sandboxPayload = prepared.payload;
      egressGrantToken = prepared.egressGrantToken;
      egressGrantTokenForRestore = prepared.egressGrantToken;
      executionManifestClaims = (env.EXECUTION_MANIFEST_PRIVATE_KEY || env.EXECUTION_MANIFEST_SECRET)
        ? prepared.executionManifestClaims
        : undefined;
    }

    const delivery = prepareInputDelivery(payload, sandboxPayload);
    const sandboxRequest = buildSandboxExecuteRequest({
      payload: delivery.payload,
      egressGrantToken,
      executionManifestClaims,
      executionManifestPrivateKey: env.EXECUTION_MANIFEST_PRIVATE_KEY,
      executionManifestSecret: env.EXECUTION_MANIFEST_SECRET,
      executionManifestTtlSeconds: env.EXECUTION_MANIFEST_TTL_SECONDS,
    });
    egressGrantTokenForRestore = egressGrantToken;

    const runtimeSession = resolveRuntimeSessionForJob({
      workerMode: env.RUNTIME_SESSION_MODE,
      workerBackend: env.SANDBOX_BACKEND,
      runtimeSessionMode: job.data.runtimeSessionMode,
      runtimeSessionId: job.data.runtimeSessionId,
      runtimeSessionExemption: job.data.runtimeSessionExemption,
      isSynthetic: isSyntheticJob,
    });

    /* Stateful Lambda runs this inside its session commit barrier. The worker
     * still invokes it unconditionally as the HTTP/stateless fallback; marking
     * the transformed object makes that second call an idempotent no-op. */
    const resultRestoreToken = egressGrantTokenForRestore;
    const finalizedSandboxResults = new WeakSet<SandboxRawResponse>();
    const finalizeSandboxResult = async (result: SandboxRawResponse): Promise<SandboxRawResponse> => {
      if (
        resultRestoreToken === undefined ||
        resultRestoreToken.length === 0 ||
        finalizedSandboxResults.has(result)
      ) {
        return result;
      }
      const restored = await restoreGatewaySandboxResult({
        grantId: egressGrantId,
        egressGrantToken: resultRestoreToken,
        result,
        isSynthetic: isSyntheticJob,
        signal: controller.signal,
      });
      finalizedSandboxResults.add(restored);
      return restored;
    };

    const responseRaw = await getSandboxBackend().execute(
      {
        body: sandboxRequest.body,
        headers: sandboxRequest.headers,
        inputDelivery: delivery.refs,
      },
      {
        executionId: job.data.executionId ?? '',
        language,
        isSynthetic: isSyntheticJob,
        signal: controller.signal,
        deadlineAtMs,
        tenantId: job.data.tenantId,
        canonicalUserId: job.data.canonicalUserId,
        bridgeWorkerId: job.data.bridgeWorkerId,
        runtimeSessionId: runtimeSession.runtimeSessionId,
        runtimeSessionMode: runtimeSession.runtimeSessionMode,
        /* Stateful backends run this as a commit barrier after user code but
         * before checkpointing/reusing the mutated workspace. Stateless/HTTP
         * paths retain the worker-owned fallback immediately below. */
        sessionResultFinalizer: resultRestoreToken !== undefined && resultRestoreToken.length > 0
          ? finalizeSandboxResult
          : undefined,
      },
    );

    const responseData = await finalizeSandboxResult(responseRaw);

    if (!isSyntheticJob) {
      logger.info('Sandbox response', summarizeSandboxResponse(responseData));
    }

    const { files } = responseData;
    const run = responseData.run;
    const stdout = applySystemReplacements(run?.stdout ?? '');
    const stderr = filterSystemLogs(run?.stderr ?? '', isPyPlot);

    const result: t.ExecuteResult = {
      session_id: responseData.session_id,
      /* `files` is optional on the sandbox response (e.g. dry-run
       * execute with no outputs); the public `ExecuteResult.files` is
       * required and downstream callers always iterate it. Default to
       * `[]` so the strictened response type from Phase B doesn't
       * surface a regression that wasn't there before. */
      files: files ?? [],
      stdout,
      stderr,
    };

    if (run) {
      result.code = run.code ?? null;
      result.signal = run.signal != null ? String(run.signal) : null;
      result.message = run.message ?? null;
      result.status = run.status ?? null;
      result.wall_time = (run as Record<string, unknown>).wall_time as number | null ?? null;
    }

    if (result.message || result.signal) {
      logger.warn('Sandbox execution error metadata', {
        session_id: responseData.session_id,
        code: result.code,
        signal: result.signal,
        message: summarizeText(result.message),
        status: result.status,
        wall_time: result.wall_time,
      });
    }

    return result;
  } catch (error) {
    revokeReason = controller.signal.aborted || isAbortError(error) ? 'timeout' : 'failed';
    const errorDetails = getAxiosErrorDetails(error);
    logger.error('Error processing job', errorDetails);

    const deadlineFailure = workerDeadlineFailure(
      error,
      controller.signal.aborted,
      env.JOB_TIMEOUT,
    );
    if (deadlineFailure) {
      throw deadlineFailure;
    } else if (error instanceof SandboxBackendError) {
      throw new Error(`${error.code}: ${error.message}`);
    } else if (error instanceof SessionFilesError) {
      /* BullMQ serializes Error rather than preserving custom prototypes.
       * Carry the stable code in the message so the public router can map the
       * input failure without confusing it with MicroVM health. */
      throw new Error(`${error.code}: ${error.message}`);
    } else if (isAbortError(error)) {
      throw new Error(`Job timed out after ${env.JOB_TIMEOUT}ms`);
    } else if (axios.isAxiosError(error)) {
      /** Preserve error message from sandbox */
      const sandboxError = sandboxErrorMessageFromAxios(error);
      throw new Error(`Error from sandbox: ${sandboxError}`);
    }
    throw error;
  } finally {
    if (egressGrantId || egressGrantTokenForRestore) {
      await revokeGatewayEgressGrant({
        grantId: egressGrantId,
        egressGrantToken: egressGrantId ? undefined : egressGrantTokenForRestore,
        isSynthetic: isSyntheticJob,
        reason: revokeReason,
        timeoutMs: env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
      }).catch(error => {
        logger.error('Failed to revoke egress grant', { grantId: egressGrantId, error: getAxiosErrorDetails(error) });
      });
    }
    if (timer) clearTimeout(timer);
    endTimer();
    activeJobs.dec({ language });
  }
}

// Global workers - no INSTANCE_ID prefix
// This enables horizontal scaling where any worker can process any job from the shared queue
// Each worker respects its own concurrency limit based on its co-located sandbox capacity
export const pyWorker = new Worker(queueNames.python, processJob, {
  connection,
  concurrency: env.PYTHON_CONCURRENCY,
  limiter: {
    max: env.PYTHON_CONCURRENCY,
    duration: env.JOB_WINDOW,
  },
});

export const otherWorker = new Worker(queueNames.other, processJob, {
  connection,
  concurrency: env.OTHER_CONCURRENCY,
  limiter: {
    max: env.OTHER_CONCURRENCY,
    duration: env.JOB_WINDOW,
  },
});

workerRunning.set({ worker_type: 'python' }, 1);
workerRunning.set({ worker_type: 'other' }, 1);

pyWorker.on('completed', job => {
  if (job.data.isSynthetic !== true) {
    logger.info(`[${WORKER_ID}] Python job completed ${job.id}`);
  }
  jobsCompleted.inc({ language: 'python' });
});

otherWorker.on('completed', job => {
  if (job.data.isSynthetic !== true) {
    logger.info(`[${WORKER_ID}] Other job completed ${job.id}`);
  }
  jobsCompleted.inc({ language: 'other' });
});

pyWorker.on('failed', (job, err) => {
  logger.error(`[${WORKER_ID}] Python job ${job?.id} failed`, err);
  jobsFailed.inc({ language: 'python' });
});

otherWorker.on('failed', (job, err) => {
  logger.error(`[${WORKER_ID}] Other job ${job?.id} failed`, err);
  jobsFailed.inc({ language: 'other' });
});

pyWorker.on('error', (err) => {
  logger.error(`[${WORKER_ID}] Python worker error`, err);
  workerRunning.set({ worker_type: 'python' }, 0);
});

otherWorker.on('error', (err) => {
  logger.error(`[${WORKER_ID}] Other worker error`, err);
  workerRunning.set({ worker_type: 'other' }, 0);
});

pyWorker.on('closed', () => {
  workerRunning.set({ worker_type: 'python' }, 0);
});

otherWorker.on('closed', () => {
  workerRunning.set({ worker_type: 'other' }, 0);
});
