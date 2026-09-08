import type { RequestHandler, Response } from 'express';
import type { WorkspaceToolRequest } from '../../../packages/code/src/protocol';
import logger from '../logger';
import { env } from '../config';
import { hostedAppRequestHostname, hostedAppRuntimeIdFromHostname } from '../hosted-app/preview-access';

interface WorkspaceToolOutcome {
  operation?: WorkspaceToolRequest['operation'];
  workerId?: string;
  errorCode?: string;
  deadlineBudgetMs?: number;
  dispatchDurationMs?: number;
  dispatchPending: boolean;
  flush: () => void;
}

const outcomes = new WeakMap<Response, WorkspaceToolOutcome>();
const earlyErrorCodes: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'AUTHORIZATION_REJECTED',
  413: 'REQUEST_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

export function getWorkspaceToolOutcome(res: Response): WorkspaceToolOutcome {
  const existing = outcomes.get(res);
  if (existing != null) return existing;
  const startedAt = performance.now();
  let responseEndedAt: number | undefined;
  let logged = false;
  const outcome: WorkspaceToolOutcome = {
    dispatchPending: false,
    flush: (): void => {
      if (logged || responseEndedAt == null || outcome.dispatchPending) return;
      logged = true;
      outcomes.delete(res);
      const finished = res.writableFinished;
      logger.log(finished && res.statusCode < 400 ? 'info' : 'warn', 'Workspace tool request completed', {
        route: '/workspace-tools/execute',
        operation: outcome.operation,
        workerId: outcome.workerId,
        status: finished ? res.statusCode : undefined,
        outcome: finished ? 'completed' : 'disconnected',
        errorCode: outcome.errorCode ?? (finished ? earlyErrorCodes[res.statusCode] : undefined),
        durationMs: Math.round(responseEndedAt - startedAt),
        dispatchDurationMs: outcome.dispatchDurationMs,
        deadlineBudgetMs: outcome.deadlineBudgetMs,
      });
    },
  };
  const onResponseEnd = (): void => {
    res.removeListener('finish', onResponseEnd);
    res.removeListener('close', onResponseEnd);
    responseEndedAt = performance.now();
    outcome.flush();
  };
  outcomes.set(res, outcome);
  res.once('finish', onResponseEnd);
  res.once('close', onResponseEnd);
  return outcome;
}

export function recordWorkspaceToolRejection(res: Response, errorCode: string): void {
  const outcome = outcomes.get(res);
  if (outcome != null) outcome.errorCode = errorCode;
}

/** Classify raw Host like the preview gateway without moving the earlier profile guard. */
export const workspaceToolOutcomeLogging: RequestHandler = (req, res, next): void => {
  if (req.method !== 'POST') return next();
  const hostname = hostedAppRequestHostname(req.headers.host);
  if (env.HOSTED_APPS_ENABLED && env.HOSTED_APP_PREVIEW_ORIGIN && hostname != null &&
    hostedAppRuntimeIdFromHostname(hostname, env.HOSTED_APP_PREVIEW_ORIGIN) != null) return next();
  getWorkspaceToolOutcome(res);
  next();
};
