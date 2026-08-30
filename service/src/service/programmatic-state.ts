import type * as t from '../types';
import type { LCTool } from '../preamble';
import type { ExecutionState } from './replay-state';
import { buildExecutionIdentity, type ExecutionIdentity } from '../execution-identity';

export interface BuildReplayExecutionStateParams {
  executionId: string;
  sessionId: string;
  sessionKey: string;
  userId: string;
  apiKeyId: string;
  authContext?: t.CodeApiAuthContext;
  identity?: ExecutionIdentity;
  code: string;
  tools: LCTool[];
  files?: t.RequestFile[];
  isPyPlot: boolean;
  timeout: number;
  language: 'python' | 'bash';
  bridgeWorkerId?: string;
  now?: number;
}

export function buildReplayExecutionState(
  params: BuildReplayExecutionStateParams,
): ExecutionState {
  const now = params.now ?? Date.now();
  const identity = params.identity ?? buildExecutionIdentity({
    userId: params.userId,
    authContext: params.authContext,
  });
  return {
    execution_id: params.executionId,
    session_id: params.sessionId,
    sessionKey: params.sessionKey,
    userId: params.userId,
    tenantId: identity.storageNamespace,
    canonicalUserId: identity.canonicalUserId,
    orgId: identity.orgId,
    serviceId: identity.serviceId,
    externalUserId: identity.externalUserId,
    principalSource: identity.principalSource,
    authContextHash: identity.authContextHash,
    apiKeyId: params.apiKeyId,
    bridgeWorkerId: params.bridgeWorkerId,
    startTime: now,
    lastActivity: now,
    mode: 'replay',
    userCode: params.code,
    tools: params.tools,
    files: params.files,
    isPyPlot: params.isPyPlot,
    timeout: params.timeout,
    callCount: 0,
    language: params.language,
  };
}
