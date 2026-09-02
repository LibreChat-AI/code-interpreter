export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const BRIDGE_SANDBOX_PROFILE_MAX_LENGTH = 128;
export const BRIDGE_RUNTIME_MAX_COUNT = 32;
export const BRIDGE_RUNTIME_MAX_LENGTH = 64;

export type BridgeProtocolVersion = typeof BRIDGE_PROTOCOL_VERSION;

export interface BridgeWorkerCapabilities {
  statefulWorkspace: boolean;
  sandboxProfile: string;
  runtimes: string[];
  policyDigest?: string;
  requiresReadyConfirmation?: boolean;
}

export interface BridgeWorkerRegistration {
  protocolVersion: BridgeProtocolVersion;
  workerId: string;
  incarnationId: string;
  capabilities: BridgeWorkerCapabilities;
}

export interface BridgeWorkerRegistrationResponse {
  protocolVersion: BridgeProtocolVersion;
  workerId: string;
  incarnationId: string;
  /** Monotonic per-worker generation allocated when the active incarnation changes. */
  registrationGeneration?: number;
  registeredAt: string;
  leaseTtlMs: number;
}

export interface BridgePairingRedemption {
  protocolVersion: BridgeProtocolVersion;
  workerId: string;
  code: string;
  publicKey: string;
}

export interface BridgeWorkerCredentialResponse {
  protocolVersion: BridgeProtocolVersion;
  workerId: string;
  credential: string;
  expiresAt: string;
}

export interface BridgeSandboxRequest<TBody = object> {
  body: TBody;
  headers: Record<string, string>;
}

export interface BridgeAssignment<TBody = object> {
  protocolVersion: BridgeProtocolVersion;
  assignmentId: string;
  workerId: string;
  incarnationId: string;
  generation: number;
  leaseToken: string;
  expiresAt: string;
  /** Server-calculated execution budget at lease time; avoids VM clock skew. */
  remainingMs?: number;
  runtimeSessionId?: string;
  request: BridgeSandboxRequest<TBody>;
}

export interface BridgeLeaseResponse<TBody = object> {
  protocolVersion: BridgeProtocolVersion;
  /** Time spent handling the lease request on Code API, excluding transit. */
  serverElapsedMs?: number;
  assignment?: BridgeAssignment<TBody>;
}

export interface BridgeFulfilledSettlement<TResult = object> {
  protocolVersion: BridgeProtocolVersion;
  generation: number;
  leaseToken: string;
  incarnationId: string;
  status: 'fulfilled';
  result: TResult;
}

export interface BridgeRejectedSettlement {
  protocolVersion: BridgeProtocolVersion;
  generation: number;
  leaseToken: string;
  incarnationId: string;
  status: 'rejected';
  error: string;
}

export type BridgeSettlement<TResult = object> =
  BridgeFulfilledSettlement<TResult> | BridgeRejectedSettlement;

export interface BridgeSettlementResponse {
  protocolVersion: BridgeProtocolVersion;
  accepted: true;
}

export interface BridgeCancellationResponse {
  protocolVersion: BridgeProtocolVersion;
  cancelled: boolean;
}

export class BridgeProtocolError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

export function bridgeWorkerPath(workerId: string): string {
  return `/bridge/workers/${encodeURIComponent(workerId)}`;
}

export function isValidBridgeWorkerId(workerId: string): boolean {
  return BRIDGE_WORKER_ID_PATTERN.test(workerId);
}

export function isValidBridgeWorkerCapabilities(
  value: unknown,
): value is BridgeWorkerCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Record<string, unknown>;
  return (
    typeof capabilities.statefulWorkspace === 'boolean' &&
    typeof capabilities.sandboxProfile === 'string' &&
    capabilities.sandboxProfile.trim().length > 0 &&
    capabilities.sandboxProfile.length <= BRIDGE_SANDBOX_PROFILE_MAX_LENGTH &&
    Array.isArray(capabilities.runtimes) &&
    capabilities.runtimes.length <= BRIDGE_RUNTIME_MAX_COUNT &&
    capabilities.runtimes.every(
      (runtime) =>
        typeof runtime === 'string' &&
        runtime.length > 0 &&
        runtime.length <= BRIDGE_RUNTIME_MAX_LENGTH,
    ) &&
    (capabilities.policyDigest === undefined ||
      (typeof capabilities.policyDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(capabilities.policyDigest))) &&
    (capabilities.requiresReadyConfirmation === undefined ||
      typeof capabilities.requiresReadyConfirmation === 'boolean')
  );
}
