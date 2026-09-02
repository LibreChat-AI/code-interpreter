import express, { json, Router } from 'express';
import { startServer, gracefulShutdown } from './lifecycle';
import { apiKeyAuth } from './middleware/auth';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { executionProfileMiddleware } from './middleware/execution-profile';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import bridgeRouter from './bridge';
import workspaceToolsRouter from './workspace-tools';
import { connection } from './queue';
import { env } from './config';
import logger from './logger';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(executionProfileMiddleware);

const v1 = Router();

app.use(json({ limit: env.HTTP_JSON_LIMIT })); // Large scripts/tool definitions are configurable.

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
v1.use(apiKeyAuth);

v1.use(workspaceToolsRouter);
v1.use(serviceRouter);
v1.use(programmaticRouter);

app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

startServer(app);

// Add SIGTERM handler
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGUSR2', gracefulShutdown); // For nodemon restarts

// Improve your existing handlers
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
