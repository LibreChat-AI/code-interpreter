import { Router } from 'express';

import type { RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import type { RedisBridgeStore } from '../bridge/store';

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
      const principal = getPrincipalOrReject(req, res);
      if (!principal) return;
      if ((options.isShuttingDown ?? checkServiceShutDown)()) {
        res.status(503).json({ error: 'Service is shutting down' });
        return;
      }
      if (!isWorkspaceToolRequest(req.body)) {
        res.status(400).json({
          error: 'Invalid workspace tool request',
        });
        return;
      }

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
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      if (selection == null) {
        res.status(503).json({
          error: 'Workspace tools require the remote-bridge backend',
        });
        return;
      }

      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      const abortClosedResponse = () => {
        if (!res.writableEnded) abort();
      };
      res.once('close', abortClosedResponse);
      try {
        const settlement = await options.store.dispatchWorkspaceTool({
          workerId: selection.workerId,
          tenantId: principal.tenantId,
          requireTenantBinding:
            selection.explicit && (options.dynamicWorkers || selection.workerId !== options.configuredWorkerId),
          request: req.body,
          deadlineAtMs: Date.now() + Math.max(1, options.timeoutMs ?? 30_000),
          signal: controller.signal,
        });
        if (settlement.status === 'rejected') {
          let status = 422;
          if (settlement.errorCode === 'SEARCH_TIMEOUT') status = 504;
          if (settlement.errorCode === 'SEARCH_UNAVAILABLE') status = 503;
          res.status(status).json({
            error: settlement.error,
            code: settlement.errorCode ?? 'WORKSPACE_TOOL_REJECTED',
          });
          return;
        }
        res.status(200).json(settlement.result);
      } catch (error) {
        if (error instanceof BridgeStoreError) {
          res.status(bridgeStoreStatus(error)).json({
            error: error.message,
            code: error.code,
          });
          return;
        }
        throw error;
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abortClosedResponse);
      }
    }),
  );

  return router;
}
