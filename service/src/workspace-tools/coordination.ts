import { createHash } from 'crypto';

export interface WorkspaceRequestCoordinationPolicy {
  bridgeEnabled: boolean;
  backend: string;
  executionProfile: string;
  authMode: string;
  configuredWorkerId: string;
  dynamicWorkers: boolean;
  maxWorkspaceLeaseSlots: number;
  maxCommandTimeoutMs: number;
}

/** Only replicas with the same bridge policy may reconcile accepted work. */
export function workspaceRequestCoordinationScope(policy: WorkspaceRequestCoordinationPolicy): string | undefined {
  if (!policy.bridgeEnabled) return undefined;
  return createHash('sha256').update(JSON.stringify([
    policy.backend, policy.executionProfile, policy.authMode, policy.configuredWorkerId,
    policy.dynamicWorkers, policy.maxWorkspaceLeaseSlots, policy.maxCommandTimeoutMs,
  ])).digest('hex');
}
