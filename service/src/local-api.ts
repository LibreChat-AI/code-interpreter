/**
 * Local Development API
 *
 * This is a simplified API for local testing that:
 * - Does NOT require production JWT configuration
 * - Uses a mock user for all requests
 *
 * NOT FOR PRODUCTION USE
 */
import express, { json, Router } from 'express';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import bridgeRouter from './bridge/router';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { executionProfileMiddleware } from './middleware/execution-profile';
import { localAuth } from './auth/local';
import { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, connection } from './queue';
import { setStartupComplete } from './lifecycle';
// Workers are imported to ensure they're started with the process
import './workers';
import { env } from './config';
import logger from './logger';
import { shutdownTelemetry, traceHttpRequest } from './telemetry';
import {
  validateApiBridgePolicy,
  validateExecutionProfilePolicy,
  validateSandboxBackendPolicy,
} from './secure-startup';
import { configureExecutionProfileMetrics } from './metrics';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
let localShuttingDown = false;

const v1 = Router();

app.use(traceHttpRequest('codeapi.local_api.request'));
app.use(executionProfileMiddleware);
app.use(json({ limit: env.HTTP_JSON_LIMIT }));

// Health check
app.get('/v1/health', async (_, res) => {
  try {
    await connection.ping();
    res.sendStatus(200);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.sendStatus(503);
  }
});

v1.use('/bridge', bridgeRouter);
v1.use(localAuth);
v1.use(serviceRouter);
v1.use(programmaticRouter);
app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

// Simplified startup for local development
async function localStartup(): Promise<void> {
  logger.info('Starting local development server...');
  logger.info('⚠️  LOCAL MODE - No authentication required');
  validateApiBridgePolicy();
  validateExecutionProfilePolicy();
  validateSandboxBackendPolicy();
  configureExecutionProfileMetrics({
    profile: env.EXECUTION_PROFILE,
    sandboxBackend: env.SANDBOX_BACKEND,
    runtimeSessionMode: env.RUNTIME_SESSION_MODE,
  });

  try {
    // Set a local user ID for session management
    await connection.set('access-user', 'local-test-user');

    // Note: We no longer drain/clean queues on startup because they are shared
    // across all workers in a horizontally scaled deployment.
    // Stale jobs are handled by BullMQ's stalledInterval configuration.

    // Resume queues (in case they were paused)
    await Promise.all([
      pyQueue.resume(),
      otherQueue.resume()
    ]);

    setStartupComplete();
    logger.info('Local startup complete');
  } catch (error) {
    logger.error('Error during local startup:', error);
    throw error;
  }
}

async function localShutdown(): Promise<void> {
  if (localShuttingDown) return;
  localShuttingDown = true;
  logger.info('Shutting down local server...');
  try {
    await Promise.all([
      pyQueue.close(),
      otherQueue.close(),
      pyQueueEvents.close(),
      otherQueueEvents.close()
    ]);
    try {
      await shutdownTelemetry();
    } catch (telemetryError) {
      logger.warn('OpenTelemetry shutdown failed', { error: telemetryError });
    }
    logger.info('Local shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    try {
      await shutdownTelemetry();
    } catch (telemetryError) {
      logger.warn('OpenTelemetry shutdown failed', { error: telemetryError });
    }
    process.exit(1);
  }
}

// Start server
localStartup().then(() => {
  app.listen(env.PORT, () => {
    logger.info(`[LOCAL] Server running on port ${env.PORT}`);
    logger.info(`[LOCAL] PYTHON_CONCURRENCY: ${env.PYTHON_CONCURRENCY} | OTHER_CONCURRENCY: ${env.OTHER_CONCURRENCY}`);
  });
}).catch((error) => {
  logger.error('Failed to start local server:', error);
  process.exit(1);
});

process.on('SIGTERM', localShutdown);
process.on('SIGINT', localShutdown);
process.on('SIGUSR2', localShutdown);

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await localShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
