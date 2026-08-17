import client, { register, Counter, Histogram, Gauge } from 'prom-client';
import { normalizeMetricPath } from './httpPathNormalize';

client.collectDefaultMetrics({ register });

// -- HTTP metrics (shared across Express and Bun servers) --
export const httpRequestsTotal = new Counter({
    name: 'codeapi_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
});

const httpRequestDuration = new Histogram({
    name: 'codeapi_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Same names, labels (`method`, `path`, `status`), and buckets as LibreChat
 * `packages/api/src/app/metrics.ts`, so PromQL from LibreChat alert rules
 * can be reused per-namespace against codeapi scrape targets.
 */
const httpRequestsTotalCompat = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
});

const httpRequestDurationSecondsCompat = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

/** Monotonic start time in ms (Node `performance.now` / Bun). Pair with `httpLatencyElapsedSeconds`. */
export function httpLatencyStartMs(): number {
    return performance.now();
}

export function httpLatencyElapsedSeconds(startMs: number): number {
    return (performance.now() - startMs) / 1000;
}

export function recordHttpRequest(params: {
    method: string;
    route: string;
    /** Raw URL path without query (e.g. Express `req.path`); drives LibreChat-style `path` label */
    rawPath?: string;
    statusCode: number;
    durationSeconds: number;
}): void {
    const status_code = String(params.statusCode);
    const labels = { method: params.method, route: params.route, status_code };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, params.durationSeconds);

    const path = normalizeMetricPath(params.rawPath ?? params.route);
    const compatLabels = { method: params.method, path, status: status_code };
    httpRequestsTotalCompat.inc(compatLabels);
    httpRequestDurationSecondsCompat.observe(
        compatLabels,
        params.durationSeconds,
    );
}

// -- Job queue metrics (API server submits, worker processes) --
export const jobsSubmitted = new Counter({
    name: 'codeapi_jobs_submitted_total',
    help: 'Total number of jobs submitted to the queue',
    labelNames: ['language'] as const,
});

export const jobProcessingDuration = new Histogram({
    name: 'codeapi_job_processing_duration_seconds',
    help: 'Duration of job processing in seconds',
    labelNames: ['language'] as const,
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
});

export const jobsCompleted = new Counter({
    name: 'codeapi_jobs_completed_total',
    help: 'Total number of jobs completed successfully',
    labelNames: ['language'] as const,
});

export const jobsFailed = new Counter({
    name: 'codeapi_jobs_failed_total',
    help: 'Total number of jobs that failed',
    labelNames: ['language'] as const,
});

export const activeJobs = new Gauge({
    name: 'codeapi_active_jobs',
    help: 'Number of jobs currently being processed',
    labelNames: ['language'] as const,
});

let bullmqQueueMetricsCollector: (() => Promise<void> | void) | undefined;

export const bullmqQueueJobs = new Gauge({
    name: 'codeapi_bullmq_queue_jobs',
    help: 'Number of BullMQ jobs by queue and state',
    labelNames: ['queue', 'state'] as const,
    async collect(): Promise<void> {
        await bullmqQueueMetricsCollector?.();
    },
});

export function registerBullmqQueueMetricsCollector(
    collector: (() => Promise<void> | void) | undefined,
): void {
    bullmqQueueMetricsCollector = collector;
}

export const workerRunning = new Gauge({
    name: 'codeapi_worker_running',
    help: 'Whether a worker is running (1) or stopped (0)',
    labelNames: ['worker_type'] as const,
});

// -- File server metrics --
export const fileUploads = new Counter({
    name: 'codeapi_file_uploads_total',
    help: 'Total number of files uploaded',
});

export const fileDownloads = new Counter({
    name: 'codeapi_file_downloads_total',
    help: 'Total number of files downloaded',
});

// -- Tool call server metrics --
export const toolCalls = new Counter({
    name: 'codeapi_tool_calls_total',
    help: 'Total number of tool calls received',
});

export const toolCallTimeouts = new Counter({
    name: 'codeapi_tool_call_timeouts_total',
    help: 'Total number of tool calls that timed out',
});

export const toolCallActiveSessions = new Gauge({
    name: 'codeapi_tool_call_active_sessions',
    help: 'Number of active tool call sessions',
});

// -- PTC replay metrics --
//
// These instrument the Temporal-style replay flow in
// `service/programmatic-router.ts` and `service/replay-state.ts`. Counts and
// outcomes are labeled by `mode` (`replay` vs `blocking`) so dashboards can
// compare the two execution paths during the rollout. `outcome` on the
// continuation counter distinguishes `tool_calls_pending` (sandbox emitted a
// sentinel asking for more tool results), `completed` (job finished), and
// `error` (sandbox or transport failure), which together fully partition
// the continuation outcome space.

export const ptcReplayContinuations = new Counter({
    name: 'codeapi_ptc_replay_continuations_total',
    help: 'Total number of PTC replay continuation requests by outcome',
    labelNames: ['mode', 'outcome'] as const,
});

export const ptcReplayContinuationDuration = new Histogram({
    name: 'codeapi_ptc_replay_continuation_duration_seconds',
    help: 'Wall-clock duration of a PTC replay continuation (lock acquire -> response)',
    labelNames: ['mode', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

export const ptcReplayLockContention = new Counter({
    name: 'codeapi_ptc_replay_lock_contention_total',
    help: 'Continuations that returned 409 because another continuation already held the per-execution lock',
});

export const ptcReplayHistorySize = new Histogram({
    name: 'codeapi_ptc_replay_history_size_bytes',
    help: 'Serialized size of the replay tool_history blob committed to Redis',
    buckets: [
        1024,
        4 * 1024,
        16 * 1024,
        64 * 1024,
        256 * 1024,
        1024 * 1024,
        4 * 1024 * 1024,
        10 * 1024 * 1024,
    ],
});

export const ptcReplayHistoryEntries = new Histogram({
    name: 'codeapi_ptc_replay_history_entries',
    help: 'Number of cached tool-result entries in the history blob committed to Redis',
    buckets: [1, 2, 4, 8, 16, 32, 64, 128, 256],
});

export const ptcReplayStateOversize = new Counter({
    name: 'codeapi_ptc_replay_state_oversize_total',
    help: 'Times the serialized exec_state exceeded MAX_EXECUTION_STATE_BYTES and the continuation was rejected with 413',
});

export const ptcReplayStaleCleanups = new Counter({
    name: 'codeapi_ptc_replay_stale_cleanups_total',
    help: 'Stale executions reaped by the periodic cleanup sweep',
});

export const microvmLaunches = new Counter({
    name: 'codeapi_microvm_launches_total',
    help: 'Lambda MicroVM launch attempts by outcome',
    labelNames: ['outcome'] as const,
});

export const microvmLaunchDuration = new Histogram({
    name: 'codeapi_microvm_launch_duration_seconds',
    help: 'Time from RunMicrovm to a healthy RUNNING MicroVM',
    buckets: [0.5, 1, 2, 5, 10, 20, 40, 60],
});

export const microvmTerminations = new Counter({
    name: 'codeapi_microvm_terminations_total',
    help: 'Lambda MicroVM terminations by reason',
    labelNames: ['reason'] as const,
});

export const microvmThrottleEvents = new Counter({
    name: 'codeapi_microvm_throttle_events_total',
    help: 'Control-plane throttle waits/errors by operation',
    labelNames: ['op'] as const,
});

export const runtimeSessionLockContention = new Counter({
    name: 'codeapi_runtime_session_lock_contention_total',
    help: 'Runtime session lock waits that timed out, by mode',
    labelNames: ['mode'] as const,
});

export const microvmCheckpoints = new Counter({
    name: 'codeapi_microvm_checkpoints_total',
    help: 'Session workspace checkpoint attempts by outcome',
    labelNames: ['outcome'] as const,
});

export const microvmRestores = new Counter({
    name: 'codeapi_microvm_restores_total',
    help: 'Session workspace restore attempts by outcome',
    labelNames: ['outcome'] as const,
});

export const microvmCheckpointBytes = new Histogram({
    name: 'codeapi_microvm_checkpoint_bytes',
    help: 'Size of stored session workspace checkpoints',
    buckets: [
        1024,
        64 * 1024,
        1024 * 1024,
        16 * 1024 * 1024,
        64 * 1024 * 1024,
        256 * 1024 * 1024,
        512 * 1024 * 1024,
    ],
});

// -- Helpers for serving metrics --

export async function metricsHandler(
    _req: unknown,
    res: {
        set: (key: string, value: string) => void;
        send: (data: string) => void;
    },
): Promise<void> {
    const data = await register.metrics();
    res.set('Content-Type', client.contentType);
    res.send(data);
}

export async function metricsResponse(): Promise<{
    body: string;
    contentType: string;
}> {
    return { body: await register.metrics(), contentType: client.contentType };
}
