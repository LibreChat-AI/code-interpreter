import { Router } from 'express';

import { bridgeStore } from '../bridge';
import { env } from '../config';
import { executionLimiter } from '../middleware/limits';
import { createWorkspaceToolsRouter } from './router';
import { RedisWorkspaceRequests } from './requests';
import { connection } from '../queue';
import logger from '../logger';
import { checkServiceStartUp, checkServiceShutDown } from '../lifecycle';
import { withSpan } from '../telemetry';
import { isBridgeEnabled } from '../bridge/enabled';
import { workspaceRequestCoordinationScope } from './coordination';

const router = Router();
const coordinationScope = workspaceRequestCoordinationScope({
  bridgeEnabled: isBridgeEnabled(), backend: env.SANDBOX_BACKEND,
  executionProfile: env.EXECUTION_PROFILE, authMode: env.BRIDGE_AUTH_MODE,
  configuredWorkerId: env.BRIDGE_WORKER_ID, dynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
  maxWorkspaceLeaseSlots: env.BRIDGE_MAX_WORKSPACE_LEASE_SLOTS, maxCommandTimeoutMs: env.JOB_TIMEOUT,
});
const requests = coordinationScope === undefined ? undefined : new RedisWorkspaceRequests(connection, bridgeStore, record => {
  const attributes = {
    'codeapi.request.id': record.id,
    'codeapi.admission.state': record.state,
    'codeapi.worker.id': record.workerId,
    'codeapi.workspace.id': record.request.workspaceId,
    'codeapi.workspace.instance_id': record.request.workspaceInstanceId ?? '',
    'codeapi.workspace.worktree': record.request.worktree ?? '',
    'codeapi.admission.wait_ms': Math.max(0, (record.admittedAtMs ?? Math.min(record.finishedAtMs ?? Date.now(), record.queueDeadlineAtMs)) - record.createdAtMs),
    'codeapi.admission.error_code': record.error?.code ?? '',
  };
  logger.info('Durable workspace admission transition', attributes);
  void withSpan('codeapi.workspace.admission.transition', attributes, () => undefined).catch(error => {
    logger.warn('Admission transition telemetry failed', { error });
  });
}, coordinationScope);
if (requests != null) {
  const coordinator = requests;
  let reconciling = false;
  let unavailable = false;
  const reconciliation = setInterval(() => {
    if (reconciling || checkServiceStartUp() || checkServiceShutDown()) return;
    reconciling = true;
    void coordinator.reconcile().then(() => { unavailable = false; }).catch(error => {
      if (!unavailable) logger.warn('Durable workspace reconciliation unavailable', { error });
      unavailable = true;
    }).finally(() => { reconciling = false; });
  }, 250);
  reconciliation.unref();
}
router.use(['/workspace-tools/execute', '/workspace-tools/requests'], (req, res, next) => {
  if (req.method === 'POST') executionLimiter(req, res, next);
  else next();
});
router.use(
  createWorkspaceToolsRouter({
    store: bridgeStore,
    requests,
    backend: env.SANDBOX_BACKEND,
    configuredWorkerId: env.BRIDGE_WORKER_ID,
    dynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
    timeoutMs: env.JOB_TIMEOUT,
  }),
);

export default router;
