/**
 * API-Only Server
 *
 * This is a stateless API server that:
 * - Handles HTTP requests
 * - Submits jobs to the global queue
 * - Waits for results via Redis pub/sub
 * - Does NOT run workers (workers run in separate pods)
 *
 * For horizontal scaling:
 * - Scale this independently based on HTTP traffic
 * - Jobs are processed by Worker pods (worker-server.ts)
 */
import express, { json, Router } from 'express';
import { startApiServer, gracefulShutdown } from './lifecycle';
import { apiKeyAuth } from './middleware/auth';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { localAuth } from './auth/local';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import bridgeRouter from './bridge';
import { connection } from './queue';
import { metricsHandler } from './metrics';
import { httpMetricsMiddleware } from './middleware/httpMetrics';
import { executionProfileMiddleware } from './middleware/execution-profile';
import { traceHttpRequest } from './telemetry';
import { env } from './config';
import logger from './logger';

const { LOCAL_MODE: isLocalMode } = env;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(traceHttpRequest('codeapi.api.request'));
app.use(httpMetricsMiddleware);
app.use(executionProfileMiddleware);

const v1 = Router();

app.use(json({ limit: env.HTTP_JSON_LIMIT }));

app.get('/metrics', metricsHandler);

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
v1.use(isLocalMode ? localAuth : apiKeyAuth);

v1.use(serviceRouter);
v1.use(programmaticRouter);

app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

// Start API-only server (no workers)
startApiServer(app);

// Graceful shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGUSR2', gracefulShutdown);

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
