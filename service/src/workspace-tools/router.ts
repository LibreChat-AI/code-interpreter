import { Router } from 'express';

import type { RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import type { RedisBridgeStore } from '../bridge/store';
import type { WorkspaceToolRequest } from '../../../packages/code/src/protocol';

import { getWorkspaceToolOutcome } from './outcome';
import { getPrincipalOrReject } from '../auth/principal';
import { BridgeStoreError } from '../bridge/store';
import { checkServiceShutDown } from '../lifecycle';
import {
  isWorkspaceToolRequest,
  BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
} from '../../../packages/code/src/protocol';
import {
  CODEAPI_BRIDGE_WORKER_HEADER,
  BridgeWorkerSelectionError,
  resolveBridgeWorkerSelection,
} from '../bridge/selection';
import { principalWorkspaceInstanceId } from '../bridge/workspace-instance';
import { WorkspaceRequestConflict } from './requests';
import type { RedisWorkspaceRequests } from './requests';

const MAX_WORKSPACE_QUEUE_WAIT_MS = 5 * 60_000;
const DEFAULT_WORKSPACE_QUEUE_WAIT_MS = 30_000;
const WORKSPACE_QUEUE_WAIT_HEADER = 'X-LibreChat-Workspace-Queue-Wait-Ms';

interface WorkspaceToolsRouterOptions {
  store: Pick<RedisBridgeStore, 'dispatchWorkspaceTool'>;
  requests?: RedisWorkspaceRequests;
  backend: 'http' | 'lambda-microvm' | 'remote-bridge';
  configuredWorkerId: string;
  dynamicWorkers: boolean;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  isShuttingDown?: () => boolean;
}

function asyncRoute(handler: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req as AuthenticatedRequest, res).catch(next);
  };
}

export function bridgeStoreStatus(error: BridgeStoreError): number {
  if (error.code === 'WORKSPACE_QUEUE_TIMEOUT') return 503;
  if (error.code === 'WORKER_QUEUE_FULL') return 429;
  if (error.code === 'WORKER_UNAUTHORIZED') return 403;
  if (error.code === 'ASSIGNMENT_INVALID') return 400;
  if (error.code === 'RESULT_INVALID') return 502;
  if (error.code === 'ASSIGNMENT_EXPIRED') return 504;
  if (error.code === 'WORKER_OFFLINE' || error.code === 'WORKER_BUSY') {
    return 503;
  }
  return 409;
}

export function createWorkspaceToolsRouter(options: WorkspaceToolsRouterOptions): Router {
  if (options.timeoutMs !== undefined && (
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
  )) {
    throw new RangeError('Workspace execution timeout must be a positive safe integer');
  }
  // A configured queue timeout is a ceiling. Legacy callers get 30 seconds even
  // when their execution timeout is longer; only the per-request header opts in.
  const queueCeilingMs = options.queueTimeoutMs ?? MAX_WORKSPACE_QUEUE_WAIT_MS;
  if (!Number.isSafeInteger(queueCeilingMs) || queueCeilingMs < 1 || queueCeilingMs > MAX_WORKSPACE_QUEUE_WAIT_MS) {
    throw new RangeError('Workspace queue timeout must be between 1 and 300000 milliseconds');
  }
  const router = Router();

  const execute = (durable: boolean): RequestHandler => asyncRoute(async (req, res) => {
    const outcome = getWorkspaceToolOutcome(res, req.path);
    const principal = getPrincipalOrReject(req, res);
    if (!principal) {
      outcome.errorCode = 'UNAUTHENTICATED';
      return;
    }
    if ((options.isShuttingDown ?? checkServiceShutDown)()) {
      outcome.errorCode = 'SERVICE_SHUTTING_DOWN';
      res.status(503).json({ error: 'Service is shutting down' });
      return;
    }
    if (!isWorkspaceToolRequest(req.body)) {
      outcome.errorCode = 'INVALID_WORKSPACE_TOOL_REQUEST';
      res.status(400).json({
        error: 'Invalid workspace tool request',
      });
      return;
    }
    const advertisedQueueWait = req.header(WORKSPACE_QUEUE_WAIT_HEADER);
    if (advertisedQueueWait !== undefined && !/^[1-9]\d*$/.test(advertisedQueueWait)) {
      outcome.errorCode = 'INVALID_WORKSPACE_QUEUE_WAIT';
      res.status(400).json({ error: 'Invalid workspace queue wait', code: 'INVALID_WORKSPACE_QUEUE_WAIT' });
      return;
    }
    const requestedQueueWaitMs = advertisedQueueWait === undefined
      ? DEFAULT_WORKSPACE_QUEUE_WAIT_MS
      : Number(advertisedQueueWait);
    if (!Number.isSafeInteger(requestedQueueWaitMs) || requestedQueueWaitMs > MAX_WORKSPACE_QUEUE_WAIT_MS) {
      outcome.errorCode = 'INVALID_WORKSPACE_QUEUE_WAIT';
      res.status(400).json({ error: 'Invalid workspace queue wait', code: 'INVALID_WORKSPACE_QUEUE_WAIT' });
      return;
    }
    const queueBudgetMs = Math.min(requestedQueueWaitMs, queueCeilingMs);
    outcome.operation = req.body.operation;
    const principalRequest: WorkspaceToolRequest = req.body.workspaceInstanceId == null
      ? req.body
      : {
        ...req.body,
        workspaceInstanceId: principalWorkspaceInstanceId({
          instanceId: req.body.workspaceInstanceId,
          tenantId: principal.tenantId,
          principalId: principal.userId,
        }),
      };
    const request: WorkspaceToolRequest = principalRequest.operation === 'execute_command'
      ? { ...principalRequest, timeoutMs: Math.min(
        principalRequest.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
        options.timeoutMs ?? Number.MAX_SAFE_INTEGER,
      ) }
      : principalRequest;
    const executionBudgetMs = request.operation === 'execute_command'
      ? request.timeoutMs! + 5_000
      : Math.min(options.timeoutMs ?? 30_000, 30_000);
    outcome.deadlineBudgetMs = queueBudgetMs + executionBudgetMs;

    let selection: { workerId: string; explicit: boolean } | undefined;
    try {
      selection = resolveBridgeWorkerSelection({
        backend: options.backend,
        configuredWorkerId: options.configuredWorkerId,
        dynamicWorkers: options.dynamicWorkers,
        requestedWorkerId: req.header(CODEAPI_BRIDGE_WORKER_HEADER),
        trustedWorkerId: principal.codeWorkerId,
      });
    } catch (error) {
      if (error instanceof BridgeWorkerSelectionError) {
        outcome.errorCode = 'WORKER_SELECTION_REJECTED';
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (selection == null) {
      outcome.errorCode = 'WORKSPACE_BACKEND_UNAVAILABLE';
      res.status(503).json({
        error: 'Workspace tools require the remote-bridge backend',
      });
      return;
    }
    outcome.workerId = selection.workerId;

    if (durable) {
      if (options.requests == null) {
        res.status(404).json({ error: 'Durable workspace requests are unavailable' });
        return;
      }
      try {
        const status = await options.requests.submit({
          owner: principal, requestId: req.header('X-LibreChat-Workspace-Request-Id') ?? '',
          workerId: selection.workerId,
          requireTenantBinding: selection.explicit && (options.dynamicWorkers || selection.workerId !== options.configuredWorkerId),
          request, queueWaitMs: queueBudgetMs, executionTimeoutMs: executionBudgetMs,
        });
        res.status(202).json(status);
      } catch (error) {
        if (error instanceof WorkspaceRequestConflict) {
          res.status(409).json({ error: error.message, code: 'REQUEST_CONFLICT' });
        } else if (error instanceof BridgeStoreError) {
          res.status(bridgeStoreStatus(error)).json({ error: error.message, code: error.code });
        } else throw error;
      }
      return;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    req.once('aborted', abort);
    const abortClosedResponse = (): void => {
      if (!res.writableEnded) abort();
    };
    res.once('close', abortClosedResponse);
    try {
      outcome.dispatchPending = true;
      const dispatchStartedAt = performance.now();
      const settlement = await options.store.dispatchWorkspaceTool({
        workerId: selection.workerId,
        tenantId: principal.tenantId,
        requireTenantBinding:
            selection.explicit && (options.dynamicWorkers || selection.workerId !== options.configuredWorkerId),
        request,
        deadlineAtMs: Date.now() + queueBudgetMs,
        executionTimeoutMs: executionBudgetMs,
        signal: controller.signal,
      }).finally(() => {
        outcome.dispatchDurationMs = Math.round(performance.now() - dispatchStartedAt);
      });
      if (settlement.status === 'rejected') {
        outcome.errorCode = settlement.errorCode ?? 'WORKSPACE_TOOL_REJECTED';
        let status = 422;
        if (
          settlement.errorCode === 'SEARCH_TIMEOUT' ||
            settlement.errorCode === 'LIST_TIMEOUT' ||
            settlement.errorCode === 'COMMAND_TIMEOUT'
        ) {
          status = 504;
        }
        if (
          settlement.errorCode === 'SEARCH_UNAVAILABLE' ||
            settlement.errorCode === 'LIST_UNAVAILABLE' ||
            settlement.errorCode === 'COMMAND_UNAVAILABLE'
        ) {
          status = 503;
        }
        if (settlement.errorCode === 'WRITE_DISABLED') status = 403;
        if (settlement.errorCode === 'COMMAND_DISABLED') status = 403;
        if (settlement.errorCode === 'WRITE_LIMIT_EXCEEDED') status = 413;
        if (settlement.errorCode === 'WRITE_UNAVAILABLE') status = 503;
        if (settlement.errorCode === 'EDIT_CONFLICT') status = 409;
        res.status(status).json({
          error: settlement.error,
          code: settlement.errorCode ?? 'WORKSPACE_TOOL_REJECTED',
        });
        return;
      }
      res.status(200).json(settlement.result);
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        outcome.errorCode = error.code;
        if (error.code === 'WORKSPACE_QUEUE_TIMEOUT') res.setHeader('Retry-After', '1');
        res.status(bridgeStoreStatus(error)).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      outcome.errorCode = 'INTERNAL_ERROR';
      throw error;
    } finally {
      outcome.dispatchPending = false;
      outcome.flush();
      req.removeListener('aborted', abort);
      res.removeListener('close', abortClosedResponse);
    }
  });
  router.post('/workspace-tools/execute', execute(false));
  router.post('/workspace-tools/requests', execute(true));

  router.get('/workspace-tools/capabilities', asyncRoute(async (req, res) => {
    if (!getPrincipalOrReject(req, res)) return;
    res.json({ durableWorkspaceRequests: options.requests != null ? 1 : 0 });
  }));

  const requestStatus = (cancel: boolean): RequestHandler => asyncRoute(async (req, res) => {
    const principal = getPrincipalOrReject(req, res);
    if (!principal) return;
    const status = cancel
      ? await options.requests?.cancel(principal, req.params.requestId)
      : await options.requests?.get(principal, req.params.requestId);
    if (status == null) { res.status(404).json({ error: 'Workspace request not found' }); return; }
    res.json(status);
  });
  router.get('/workspace-tools/requests/:requestId', requestStatus(false));
  router.delete('/workspace-tools/requests/:requestId', requestStatus(true));

  return router;
}
