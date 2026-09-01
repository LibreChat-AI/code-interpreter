/**
 * Worker-Only Server
 *
 * This is a worker process that:
 * - Processes jobs from the global queue
 * - Directly dispatches stateless npm-unit requests without queueing them
 * - Sends code to co-located sandbox for execution
 * - Returns results via Redis pub/sub
 * - Exposes only health/metrics and the authenticated internal npm dispatcher
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
import { httpLatencyElapsedSeconds, httpLatencyStartMs, metricsResponse, recordHttpRequest } from './metrics';
import { env } from './config';
import logger from './logger';
import {
  internalServiceAuthEnabled,
  isAuthorizedInternalServiceRequest,
} from './internal-service-auth';
import {
  processNpmUnitDispatch,
  validateNpmUnitDispatchRequest,
} from './npm-unit-dispatch';
import { NpmUnitValidationError } from './npm-unit-contract';

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
const INTERNAL_BODY_LIMIT = 64 * 1024;
const activeDirectDispatches = new Set<AbortController>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > INTERNAL_BODY_LIMIT) {
    throw new NpmUnitValidationError('dispatch body is too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > INTERNAL_BODY_LIMIT) throw new NpmUnitValidationError('dispatch body is too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NpmUnitValidationError('dispatch body must be valid JSON');
  }
}

function workerRouteLabel(url: string | undefined, method: string | undefined): string {
  if (url === '/health' && method === 'GET') {
    return '/health';
  }
  if (url === '/ready' && method === 'GET') {
    return '/ready';
  }
  if (url === '/metrics' && method === 'GET') {
    return '/metrics';
  }
  if (url === '/internal/npm-unit' && method === 'POST') {
    return '/internal/npm-unit';
  }
  return 'unmatched';
}

const healthServer = http.createServer(async (req, res) => {
  const start = httpLatencyStartMs();
  const method = req.method ?? 'GET';
  const pathname = (req.url ?? '').split('?')[0] || '/';
  const route = workerRouteLabel(pathname, method);
  let metricsRecorded = false;
  const recordOnce = () => {
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

  if (pathname === '/internal/npm-unit' && method === 'POST') {
    if (!internalServiceAuthEnabled()) {
      sendJson(res, 503, { error: 'sandbox_unavailable', message: 'internal service auth is not configured', retryable: true });
      return;
    }
    if (!isAuthorizedInternalServiceRequest(req.headers)) {
      sendJson(res, 401, { error: 'sandbox_unavailable', message: 'unauthorized', retryable: false });
      return;
    }
    if (!env.NPM_UNIT_ENABLED) {
      sendJson(res, 503, { error: 'disabled', message: 'npm unit indexing is disabled', retryable: false });
      return;
    }
    const controller = new AbortController();
    activeDirectDispatches.add(controller);
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const input = validateNpmUnitDispatchRequest(await readJsonBody(req));
      const result = await processNpmUnitDispatch(input, controller.signal);
      sendJson(res, 200, result);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof NpmUnitValidationError) {
          sendJson(res, 400, { error: 'invalid_request', message: error.message, retryable: false });
        } else {
          logger.error('Direct npm unit dispatch failed', { error });
          sendJson(res, 500, { error: 'sandbox_unavailable', message: 'npm unit dispatcher failed', retryable: true });
        }
      }
    } finally {
      activeDirectDispatches.delete(controller);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  } else if (pathname === '/health' && method === 'GET') {
    try {
      // Check Redis connection
      await connection.ping();

      // Check workers are running
      const pyRunning = pyWorker.isRunning();
      const otherRunning = otherWorker.isRunning();

      if (pyRunning && otherRunning) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          workers: {
            python: pyRunning,
            other: otherRunning,
          },
          config: {
            pythonConcurrency: env.PYTHON_CONCURRENCY,
            otherConcurrency: env.OTHER_CONCURRENCY,
            npmUnitDirectConcurrency: env.NPM_UNIT_CONCURRENCY,
            sandboxEndpoint: env.SANDBOX_ENDPOINT
          }
        }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'unhealthy',
          workers: { python: pyRunning, other: otherRunning }
        }));
      }
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'unhealthy',
        error: (error as Error).message
      }));
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
    logger.info(`Worker health check server running on port ${HEALTH_PORT}`);
  });
});

async function closeWorkerHttpServer(): Promise<void> {
  for (const controller of activeDirectDispatches) controller.abort();
  await new Promise<void>(resolve => healthServer.close(() => resolve()));
}

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, initiating graceful shutdown...');
  await closeWorkerHttpServer();
  await gracefulShutdown();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, initiating graceful shutdown...');
  await closeWorkerHttpServer();
  await gracefulShutdown();
});

process.on('SIGUSR2', async () => {
  logger.info('SIGUSR2 received, initiating graceful shutdown...');
  await closeWorkerHttpServer();
  await gracefulShutdown();
});

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await closeWorkerHttpServer();
  await gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
