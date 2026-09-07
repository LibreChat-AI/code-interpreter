import { Router } from 'express';

import { bridgeStore } from '../bridge';
import { env } from '../config';
import { executionLimiter } from '../middleware/limits';
import { createWorkspaceToolsRouter } from './router';

const router = Router();
router.use('/workspace-tools/execute', executionLimiter);
router.use(
  createWorkspaceToolsRouter({
    store: bridgeStore,
    backend: env.SANDBOX_BACKEND,
    configuredWorkerId: env.BRIDGE_WORKER_ID,
    dynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
    timeoutMs: env.JOB_TIMEOUT,
  }),
);

export default router;
