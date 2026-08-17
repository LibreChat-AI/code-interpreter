/**
 * Worker-Only Server
 *
 * This is a worker process that:
 * - Processes jobs from the global queue
 * - Sends code to co-located sandbox for execution
 * - Returns results via Redis pub/sub
 * - Does NOT handle HTTP requests (API runs in separate pods)
 *
 * For horizontal scaling:
 * - Deploy this as a pod WITH a sandbox sidecar
 * - PYTHON_CONCURRENCY controls how many jobs this worker handles
 * - Each worker talks to its own sandbox (localhost or sidecar)
 * - Scale based on queue depth / job wait time
 *
 * Architecture:
 * ┌─────────────────────────────────────────┐
 * │ Worker-Sandbox Pod                      │
 * │  ┌──────────────┐    ┌──────────────┐   │
 * │  │ worker-server│───▶│   sandbox    │   │
 * │  │ (this file)  │    │ (sidecar)    │   │
 * │  └──────────────┘    └──────────────┘   │
 * └─────────────────────────────────────────┘
 */
import { startWorkerServer, gracefulShutdown } from './lifecycle';
import {
    httpLatencyElapsedSeconds,
    httpLatencyStartMs,
    metricsResponse,
    recordHttpRequest,
} from './metrics';
import { env } from './config';
import logger from './logger';

// Health check endpoint (optional, for K8s liveness probes)
import http from 'http';
import { connection } from './queue';

/**
 * NOTE: This import and the dynamic import in startupWorkerOnly() return the SAME instances.
 *
 * Node.js caches modules - when workers.ts is first imported, pyWorker and otherWorker
 * are instantiated as module-level singletons. All subsequent imports (static or dynamic
 * via `await import()`) return the same cached module with the same worker instances.
 *
 * There is NO race condition because:
 * 1. This file loads → workers.ts is imported → workers instantiate immediately
 * 2. Health server is defined (references same worker instances)
 * 3. startWorkerServer() calls startupWorkerOnly() → dynamic import returns SAME cached module
 * 4. isRunning() check verifies workers are ready → health server starts listening
 *
 * The workers are singletons, not created fresh on each import.
 */
import { pyWorker, otherWorker } from './workers';

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT) || 3113;

function workerRouteLabel(
    url: string | undefined,
    method: string | undefined,
): string {
    if (url === '/health' && method === 'GET') {
        return '/health';
    }
    if (url === '/ready' && method === 'GET') {
        return '/ready';
    }
    if (url === '/metrics' && method === 'GET') {
        return '/metrics';
    }
    return 'unmatched';
}

const healthServer = http.createServer(async (req, res) => {
    const start = httpLatencyStartMs();
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '').split('?')[0] || '/';
    const route = workerRouteLabel(pathname, method);
    let metricsRecorded = false;
    const recordOnce = (): void => {
        if (metricsRecorded) {
            return;
        }
        metricsRecorded = true;
        recordHttpRequest({
            method,
            route,
            statusCode: res.statusCode,
            durationSeconds: httpLatencyElapsedSeconds(start),
        });
    };
    res.on('finish', () => {
        recordOnce();
    });
    req.on('aborted', () => {
        recordOnce();
    });
    res.on('close', () => {
        if (!res.writableEnded) {
            recordOnce();
        }
    });

    if (pathname === '/health' && method === 'GET') {
        try {
            // Check Redis connection
            await connection.ping();

            // Check workers are running
            const pyRunning = pyWorker.isRunning();
            const otherRunning = otherWorker.isRunning();

            if (pyRunning && otherRunning) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'healthy',
                        workers: {
                            python: pyRunning,
                            other: otherRunning,
                        },
                        config: {
                            pythonConcurrency: env.PYTHON_CONCURRENCY,
                            otherConcurrency: env.OTHER_CONCURRENCY,
                            sandboxEndpoint: env.SANDBOX_ENDPOINT,
                        },
                    }),
                );
            } else {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'unhealthy',
                        workers: { python: pyRunning, other: otherRunning },
                    }),
                );
            }
        } catch (error) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'unhealthy',
                    error: (error as Error).message,
                }),
            );
        }
    } else if (pathname === '/ready' && method === 'GET') {
        // Readiness probe - are we ready to accept jobs?
        try {
            await connection.ping();
            const pyRunning = pyWorker.isRunning();
            const otherRunning = otherWorker.isRunning();

            if (pyRunning && otherRunning) {
                res.writeHead(200);
                res.end('ready');
            } else {
                res.writeHead(503);
                res.end('not ready');
            }
        } catch {
            res.writeHead(503);
            res.end('not ready');
        }
    } else if (pathname === '/metrics' && method === 'GET') {
        const { body, contentType } = await metricsResponse();
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(body);
    } else {
        res.writeHead(404);
        res.end('not found');
    }
});

// Start worker server
startWorkerServer(async () => {
    // Start health check server
    healthServer.listen(HEALTH_PORT, () => {
        logger.info(
            `Worker health check server running on port ${HEALTH_PORT}`,
        );
    });
});

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, initiating graceful shutdown...');
    healthServer.close();
    await gracefulShutdown();
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, initiating graceful shutdown...');
    healthServer.close();
    await gracefulShutdown();
});

process.on('SIGUSR2', async () => {
    logger.info('SIGUSR2 received, initiating graceful shutdown...');
    healthServer.close();
    await gracefulShutdown();
});

process.on('uncaughtException', async error => {
    logger.error('Uncaught Exception', error);
    healthServer.close();
    await gracefulShutdown();
});

process.on('unhandledRejection', reason => {
    logger.error('Unhandled Rejection', reason);
});
