import express from 'express';
import { loadPackages } from './runtime';
import { logger } from './logger';
import { config } from './config';
import { validateHardenedSandboxStartup } from './secure-startup';
import { initializeSandboxWorkspaceIsolation, startWorkspaceReaper } from './workspace-isolation';
import { httpMetricsMiddleware, metricsHandler } from './metrics';
import { positiveInt, shutdownTelemetry, traceHttpRequest } from './telemetry';
import { startWarmupCommand } from './warmup';
import { stopToolCallSocketProxy } from './tool-call-socket-process';
import { hostedAppSupervisor, validateHostedAppStartup } from './hosted-app';
import v2Router from './api/v2';
import lifecycleRouter, { LIFECYCLE_HOOK_BASE_PATH } from './api/lifecycle';

const app = express();

app.use(traceHttpRequest('codeapi.sandbox_runner.request'));
app.use(httpMetricsMiddleware);
app.use(express.urlencoded({ extended: true }));
/** No global `express.json()` is registered here on purpose. A global parser
 * runs *before* any route-level middleware, so its limit is the effective
 * cap for every endpoint regardless of any per-route override (a global
 * default-limit parser would always reject `/api/v2/execute`'s large replay
 * payloads with `PayloadTooLargeError` before the route's configured parser could
 * fire). Each route brings its own JSON parser with the right limit:
 *   - `/api/v2/execute` -> configurable JSON limit (replay PTC / scripts)
 *   - other POSTs       -> default `express.json()`
 *   - `GET /api/v2/runtimes`, `GET /` -> no body -> no parser needed.
 * `services/codeapi/api/src/api/v2.ts` is responsible for installing the
 * right parser per route. */

loadPackages(config.packages_directory);

logger.info('Registering routes');
app.get('/metrics', metricsHandler);
app.use(LIFECYCLE_HOOK_BASE_PATH, lifecycleRouter);
app.use('/api/v2', v2Router);

app.get('/', (_req, res) => {
  return res.status(200).json({ message: 'Sandbox v2.0.0 (nsjail)' });
});

app.use((_req, res) => {
  return res.status(404).json({ message: 'Not Found' });
});

/** Express resolves error handlers strictly *forward* from the position
 * where `next(err)` was called, so this MUST be the last `app.use` for it
 * to catch errors from the v2 router (e.g. body-parser's
 * `PayloadTooLargeError` from the route-level `express.json({ limit: '50mb' })`
 * on `/execute`, or `SyntaxError` from malformed JSON). When this lived
 * before the router it was effectively dead code for route-originated
 * errors, and Express's built-in handler (plain text body) was firing
 * instead — breaking clients that rely on the structured JSON shape.
 *
 * `err.status` is set by `body-parser` (413 for oversize, 400 for bad
 * JSON) and we forward it verbatim so callers can distinguish; legacy
 * `err.statusCode` is also honored for forward compatibility. */
interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}
app.use((err: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  const status = err.status ?? err.statusCode ?? 400;
  return res.status(status).json({ message: err.message || 'Bad request' });
});

async function main(): Promise<void> {
  validateHostedAppStartup();
  validateHardenedSandboxStartup();
  await initializeSandboxWorkspaceIsolation();
  await startWarmupCommand();

  const [address, port] = config.bind_address.split(':');
  const stopWorkspaceReaper = startWorkspaceReaper();
  const server = app.listen(Number(port), address, () => {
    logger.info({ address: config.bind_address }, 'Sandbox API started');
  });
  let shuttingDown = false;
  const closeHttpServer = (): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });

  const closeHttpServerWithTimeout = async (
    timeoutMillis = positiveInt(process.env.CODEAPI_SHUTDOWN_HTTP_TIMEOUT_MS, 3000),
  ): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const closePromise = closeHttpServer().catch((err) => {
      logger.warn({ err }, 'Sandbox HTTP server close failed');
    });
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        logger.warn({ timeoutMillis }, 'Timed out waiting for sandbox HTTP server to close');
        resolve();
      }, timeoutMillis);
      (timeout as { unref?: () => void }).unref?.();
    });

    try {
      await Promise.race([closePromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWorkspaceReaper();
    await closeHttpServerWithTimeout();
    await hostedAppSupervisor.shutdown().catch((err) => {
      logger.warn({ err }, 'Hosted-app process shutdown failed');
    });
    await stopToolCallSocketProxy().catch((err) => {
      logger.warn({ err }, 'Tool-call socket proxy shutdown failed');
    });
    try {
      await shutdownTelemetry();
    } catch (err) {
      logger.warn({ err }, 'OpenTelemetry shutdown failed');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'Sandbox API startup failed');
  process.exit(1);
});
