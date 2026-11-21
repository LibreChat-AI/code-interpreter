import type { RequestHandler, Response } from 'express';
import type { BridgeCommandFailure, WorkspaceToolRequest } from '../../../packages/code/src/protocol';
import type { StoredWorkspaceRequest } from './requests';
import logger from '../logger';
import { env } from '../config';
import { hostedAppRequestHostname, hostedAppRuntimeIdFromHostname } from '../hosted-app/preview-access';

interface WorkspaceToolOutcome {
  operation?: WorkspaceToolRequest['operation'];
  workerId?: string;
  errorCode?: string;
  commandFailure?: BridgeCommandFailure;
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
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

export function getWorkspaceToolOutcome(res: Response, route = '/workspace-tools/execute'): WorkspaceToolOutcome {
  const existing = outcomes.get(res);
  if (existing != null) return existing;
  const startedAt = performance.now();
  let responseEndedAt: number | undefined;
  let responseFinished = false;
  let logged = false;
  const outcome: WorkspaceToolOutcome = {
    dispatchPending: false,
    flush: (): void => {
      if (logged || responseEndedAt == null || outcome.dispatchPending) return;
      logged = true;
      outcomes.delete(res);
      const finished = responseFinished;
      logger.log(finished && res.statusCode < 400 ? 'info' : 'warn', 'Workspace tool request completed', {
        route,
        operation: outcome.operation,
        workerId: outcome.workerId,
        status: finished ? res.statusCode : undefined,
        outcome: finished ? 'completed' : 'disconnected',
        errorCode: outcome.errorCode ?? (finished ? earlyErrorCodes[res.statusCode] : undefined),
        commandFailure: outcome.commandFailure,
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
    // Late dispatch settlement can write to a closed response. Preserve its state at close.
    responseFinished = res.writableFinished;
    outcome.flush();
  };
  outcomes.set(res, outcome);
  res.once('finish', onResponseEnd);
  res.once('close', onResponseEnd);
  return outcome;
}

type AdmissionAttribute = string | number | boolean;

function commandFailureAttributes(failure?: BridgeCommandFailure): Record<string, string> {
  if (failure === undefined) return {};
  return {
    'codeapi.command_failure.stage': failure.stage,
    'codeapi.command_failure.reason': failure.reason,
    ...(failure.osCode !== undefined ? { 'codeapi.command_failure.os_code': failure.osCode } : {}),
    ...(failure.nodeCode !== undefined ? { 'codeapi.command_failure.node_code': failure.nodeCode } : {}),
    ...(failure.errorName !== undefined ? { 'codeapi.command_failure.error_name': failure.errorName } : {}),
  };
}

/** Flat log and span attributes for one durable workspace request state change. */
export function admissionTransitionAttributes(record: StoredWorkspaceRequest): Record<string, AdmissionAttribute> {
  return {
    'codeapi.request.id': record.id,
    'codeapi.admission.state': record.state,
    'codeapi.worker.id': record.workerId,
    'codeapi.workspace.id': record.request.workspaceId,
    'codeapi.workspace.instance_id': record.request.workspaceInstanceId ?? '',
    'codeapi.workspace.worktree': record.request.worktree ?? '',
    ...(record.request.operation === 'execute_command' && record.request.detached === true
      ? { 'codeapi.workspace.detached': true }
      : {}),
    'codeapi.admission.wait_ms': Math.max(0, (record.admittedAtMs ?? Math.min(record.finishedAtMs ?? Date.now(), record.queueDeadlineAtMs)) - record.createdAtMs),
    'codeapi.admission.error_code': record.error?.code ?? '',
    ...commandFailureAttributes(record.error?.commandFailure),
  };
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
