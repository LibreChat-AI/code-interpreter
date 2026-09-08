import { Router } from 'express';

import type { RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import type { RedisBridgeStore } from '../bridge/store';
import type { WorkspaceToolRequest } from '../../../packages/code/src/protocol';

import logger from '../logger';
import { getPrincipalOrReject } from '../auth/principal';
import { BridgeStoreError } from '../bridge/store';
import { checkServiceShutDown } from '../lifecycle';
import { isWorkspaceToolRequest } from '../../../packages/code/src/protocol';
import {
  CODEAPI_BRIDGE_WORKER_HEADER,
  BridgeWorkerSelectionError,
  resolveBridgeWorkerSelection,
} from '../bridge/selection';

interface WorkspaceToolsRouterOptions {
  store: Pick<RedisBridgeStore, 'dispatchWorkspaceTool'>;
  backend: 'http' | 'lambda-microvm' | 'remote-bridge';
  configuredWorkerId: string;
  dynamicWorkers: boolean;
  timeoutMs?: number;
  isShuttingDown?: () => boolean;
}

function asyncRoute(handler: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req as AuthenticatedRequest, res).catch(next);
  };
}

export function bridgeStoreStatus(error: BridgeStoreError): number {
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
  const router = Router();

  router.post(
    '/workspace-tools/execute',
    asyncRoute(async (req, res) => {
      const startedAt = performance.now();
      const target: { operation?: WorkspaceToolRequest['operation']; workerId?: string } = {};
      let errorCode: string | undefined;
      let dispatchStartedAt: number | undefined;
      const deadlineBudgetMs = Math.max(1, options.timeoutMs ?? 30_000);
      const logOutcome = (): void => {
        res.removeListener('finish', logOutcome);
        res.removeListener('close', logOutcome);
        const finished = res.writableFinished;
        const now = performance.now();
        logger.log(finished && res.statusCode < 400 ? 'info' : 'warn', 'Workspace tool request completed', {
          route: '/workspace-tools/execute',
          ...target,
          status: finished ? res.statusCode : undefined,
          outcome: finished ? 'completed' : 'disconnected',
          errorCode,
          durationMs: Math.round(now - startedAt),
          dispatchDurationMs: dispatchStartedAt == null ? undefined : Math.round(now - dispatchStartedAt),
          deadlineBudgetMs,
        });
      };
      res.once('finish', logOutcome);
      res.once('close', logOutcome);
      const principal = getPrincipalOrReject(req, res);
      if (!principal) {
        errorCode = 'UNAUTHENTICATED';
        return;
      }
      if ((options.isShuttingDown ?? checkServiceShutDown)()) {
        errorCode = 'SERVICE_SHUTTING_DOWN';
        res.status(503).json({ error: 'Service is shutting down' });
        return;
      }
      if (!isWorkspaceToolRequest(req.body)) {
        errorCode = 'INVALID_WORKSPACE_TOOL_REQUEST';
        res.status(400).json({
          error: 'Invalid workspace tool request',
        });
        return;
      }
      target.operation = req.body.operation;

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
          errorCode = 'WORKER_SELECTION_REJECTED';
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      if (selection == null) {
        errorCode = 'WORKSPACE_BACKEND_UNAVAILABLE';
        res.status(503).json({
          error: 'Workspace tools require the remote-bridge backend',
        });
        return;
      }
      target.workerId = selection.workerId;

      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once('aborted', abort);
      const abortClosedResponse = (): void => {
        if (!res.writableEnded) abort();
      };
      res.once('close', abortClosedResponse);
      try {
        dispatchStartedAt = performance.now();
        const settlement = await options.store.dispatchWorkspaceTool({
          workerId: selection.workerId,
          tenantId: principal.tenantId,
          requireTenantBinding:
            selection.explicit && (options.dynamicWorkers || selection.workerId !== options.configuredWorkerId),
          request: req.body,
          deadlineAtMs: Date.now() + deadlineBudgetMs,
          signal: controller.signal,
        });
        if (settlement.status === 'rejected') {
          errorCode = settlement.errorCode ?? 'WORKSPACE_TOOL_REJECTED';
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
          errorCode = error.code;
          res.status(bridgeStoreStatus(error)).json({
            error: error.message,
            code: error.code,
          });
          return;
        }
        errorCode = 'INTERNAL_ERROR';
        throw error;
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abortClosedResponse);
      }
    }),
  );

  return router;
}
