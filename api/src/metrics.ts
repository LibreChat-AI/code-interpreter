import client, { Counter, Gauge, Histogram, register } from 'prom-client';
import type { NextFunction, Request, Response } from 'express';

client.collectDefaultMetrics({ register });

const httpRequestsTotal = new Counter({
    name: 'codeapi_sandbox_http_requests_total',
    help: 'Total number of sandbox-runner HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
});

const httpRequestDuration = new Histogram({
    name: 'codeapi_sandbox_http_request_duration_seconds',
    help: 'Sandbox-runner HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

export const sandboxExecutions = new Counter({
    name: 'codeapi_sandbox_executions_total',
    help: 'Total number of sandbox execution attempts by outcome',
    labelNames: ['language', 'outcome'] as const,
});

export const sandboxExecutionDuration = new Histogram({
    name: 'codeapi_sandbox_execution_duration_seconds',
    help: 'Sandbox execution request duration in seconds',
    labelNames: ['language', 'outcome'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 15, 30, 60, 120, 300],
});

export const activeSandboxExecutions = new Gauge({
    name: 'codeapi_sandbox_active_executions',
    help: 'Number of sandbox executions currently past request validation',
});

/* Increments when the NsJail setup gate releases on its watchdog rather than
 * the "Executing" log marker. A small steady rate is tolerable (slow flushes
 * happen); a spike means concurrent NsJail launches are again overlapping in
 * the unsafe mount-setup window and the gate is no longer doing its job. */
export const nsjailSetupGateWatchdogFires = new Counter({
    name: 'codeapi_sandbox_nsjail_setup_gate_watchdog_fires_total',
    help: 'NsJail setup gate watchdog releases (post-mount marker never observed before deadline)',
});

function routeLabel(req: Request): string {
    if (req.path === '/') return '/';
    if (req.path === '/metrics') return '/metrics';
    if (req.path === '/api/v2/execute') return '/api/v2/execute';
    if (req.path === '/api/v2/health') return '/api/v2/health';
    if (req.path === '/api/v2/runtimes') return '/api/v2/runtimes';
    return 'unmatched';
}

export function httpMetricsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const started = performance.now();
    let recorded = false;

    const recordOnce = (statusCode: number): void => {
        if (recorded) return;
        recorded = true;
        const labels = {
            method: req.method,
            route: routeLabel(req),
            status_code: String(statusCode),
        };
        const durationSeconds = (performance.now() - started) / 1000;
        httpRequestsTotal.inc(labels);
        httpRequestDuration.observe(labels, durationSeconds);
    };

    res.once('finish', () => recordOnce(res.statusCode));
    req.once('aborted', () => recordOnce(499));
    res.once('close', () => {
        if (!res.writableEnded) {
            recordOnce(499);
        }
    });

    next();
}

export function recordSandboxExecution(params: {
    language: string;
    outcome:
        | 'success'
        | 'manifest_error'
        | 'bad_request'
        | 'validation_error'
        | 'execution_error';
    durationSeconds: number;
}): void {
    const labels = {
        language: params.language || 'unknown',
        outcome: params.outcome,
    };
    sandboxExecutions.inc(labels);
    sandboxExecutionDuration.observe(labels, params.durationSeconds);
}

export async function metricsHandler(
    _req: Request,
    res: Response,
): Promise<void> {
    res.set('Content-Type', client.contentType);
    res.send(await register.metrics());
}
