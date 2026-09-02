export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const BRIDGE_SANDBOX_PROFILE_MAX_LENGTH = 128;
export const BRIDGE_RUNTIME_MAX_COUNT = 32;
export const BRIDGE_RUNTIME_MAX_LENGTH = 64;
export const BRIDGE_WORKSPACE_MAX_COUNT = 32;
export const BRIDGE_WORKSPACE_NAME_MAX_LENGTH = 128;
export const BRIDGE_WORKSPACE_PATH_MAX_LENGTH = 4096;
export const BRIDGE_WORKSPACE_QUERY_MAX_LENGTH = 4096;
export const BRIDGE_WORKSPACE_READ_MAX_BYTES = 1024 * 1024;
export const BRIDGE_WORKSPACE_READ_MAX_LINES = 500;
export const BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS = 200;
export const BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH = 2000;

export type BridgeProtocolVersion = typeof BRIDGE_PROTOCOL_VERSION;

export type BridgeWorkspaceToolOperation = 'read_file' | 'search_text';

export interface BridgeWorkspaceDescriptor {
  id: string;
  name?: string;
}

export interface BridgeWorkspaceToolCapabilities {
  protocolVersion: BridgeProtocolVersion;
  operations: BridgeWorkspaceToolOperation[];
  workspaces: BridgeWorkspaceDescriptor[];
}

export interface WorkspaceReadFileRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'read_file';
  workspaceId: string;
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface WorkspaceReadFileResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'read_file';
  workspaceId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextStartLine?: number;
}

export interface WorkspaceSearchTextRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'search_text';
  workspaceId: string;
  query: string;
  path?: string;
  maxResults?: number;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceSearchTextResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'search_text';
  workspaceId: string;
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

export type WorkspaceToolRequest =
  | WorkspaceReadFileRequest
  | WorkspaceSearchTextRequest;
export type WorkspaceToolResult =
  | WorkspaceReadFileResult
  | WorkspaceSearchTextResult;

const WORKSPACE_READ_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'startLine',
  'maxLines',
]);
const WORKSPACE_SEARCH_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'query',
  'path',
  'maxResults',
]);
const WORKSPACE_READ_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'content',
  'startLine',
  'endLine',
  'truncated',
  'nextStartLine',
]);
const WORKSPACE_SEARCH_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'matches',
  'truncated',
]);
const WORKSPACE_SEARCH_MATCH_KEYS = new Set([
  'path',
  'line',
  'column',
  'text',
]);

export interface BridgeWorkerCapabilities {
  statefulWorkspace: boolean;
  sandboxProfile: string;
  runtimes: string[];
  policyDigest?: string;
  requiresReadyConfirmation?: boolean;
  workspaceTools?: BridgeWorkspaceToolCapabilities;
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
  executionKind?: 'sandbox' | 'workspace_tool';
  request: BridgeSandboxRequest<TBody> | WorkspaceToolRequest;
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

function isSafePortableRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > BRIDGE_WORKSPACE_PATH_MAX_LENGTH ||
    Buffer.from(value).toString('utf8') !== value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '..');
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isWorkspaceToolRequest(
  value: unknown,
): value is WorkspaceToolRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (
    request.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    typeof request.workspaceId !== 'string' ||
    !isValidBridgeWorkerId(request.workspaceId)
  ) {
    return false;
  }
  if (request.operation === 'read_file') {
    return (
      hasOnlyKeys(request, WORKSPACE_READ_REQUEST_KEYS) &&
      isSafePortableRelativePath(request.path) &&
      (request.startLine === undefined ||
        (Number.isSafeInteger(request.startLine) &&
          Number(request.startLine) >= 1)) &&
      (request.maxLines === undefined ||
        (Number.isSafeInteger(request.maxLines) &&
          Number(request.maxLines) >= 1 &&
          Number(request.maxLines) <= BRIDGE_WORKSPACE_READ_MAX_LINES))
    );
  }
  if (request.operation === 'search_text') {
    return (
      hasOnlyKeys(request, WORKSPACE_SEARCH_REQUEST_KEYS) &&
      typeof request.query === 'string' &&
      request.query.length > 0 &&
      request.query.length <= BRIDGE_WORKSPACE_QUERY_MAX_LENGTH &&
      Buffer.from(request.query).toString('utf8') === request.query &&
      new TextEncoder().encode(request.query).byteLength <=
        BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH &&
      !request.query.includes('\0') &&
      !request.query.includes('\n') &&
      !request.query.includes('\r') &&
      (request.path === undefined ||
        isSafePortableRelativePath(request.path)) &&
      (request.maxResults === undefined ||
        (Number.isSafeInteger(request.maxResults) &&
          Number(request.maxResults) >= 1 &&
          Number(request.maxResults) <= BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS))
    );
  }
  return false;
}

export function isWorkspaceToolResult(
  request: WorkspaceToolRequest,
  value: unknown,
): value is WorkspaceToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (
    result.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    result.operation !== request.operation ||
    result.workspaceId !== request.workspaceId ||
    typeof result.truncated !== 'boolean'
  ) {
    return false;
  }

  if (request.operation === 'read_file') {
    const startLine = request.startLine ?? 1;
    const maxLines = request.maxLines ?? 200;
    const content = typeof result.content === 'string' ? result.content : null;
    const reportedLineCount =
      Number.isSafeInteger(result.endLine) && Number(result.endLine) >= startLine - 1
        ? Number(result.endLine) - startLine + 1
        : -1;
    const actualLineCount =
      content === null ? -1 : content.length === 0 ? reportedLineCount : content.split('\n').length;
    return (
      hasOnlyKeys(result, WORKSPACE_READ_RESULT_KEYS) &&
      result.path === request.path &&
      isSafePortableRelativePath(result.path) &&
      content !== null &&
      new TextEncoder().encode(content).byteLength <=
        BRIDGE_WORKSPACE_READ_MAX_BYTES &&
      result.startLine === startLine &&
      Number.isSafeInteger(result.endLine) &&
      Number(result.endLine) >= startLine - 1 &&
      Number(result.endLine) < startLine + maxLines &&
      reportedLineCount >= 0 &&
      reportedLineCount <= maxLines &&
      (content.length !== 0 || reportedLineCount <= 1) &&
      actualLineCount === reportedLineCount &&
      (result.truncated === true
        ? Number.isSafeInteger(result.nextStartLine) &&
          Number(result.nextStartLine) === Number(result.endLine) + 1
        : result.nextStartLine === undefined)
    );
  }

  if (!Array.isArray(result.matches)) return false;
  const maxResults = request.maxResults ?? 50;
  return (
    hasOnlyKeys(result, WORKSPACE_SEARCH_RESULT_KEYS) &&
    result.matches.length <= maxResults &&
    result.matches.every((match) => {
      if (typeof match !== 'object' || match === null) return false;
      const candidate = match as Record<string, unknown>;
      return (
        hasOnlyKeys(candidate, WORKSPACE_SEARCH_MATCH_KEYS) &&
        isSafePortableRelativePath(candidate.path) &&
        Number.isSafeInteger(candidate.line) &&
        Number(candidate.line) >= 1 &&
        Number.isSafeInteger(candidate.column) &&
        Number(candidate.column) >= 1 &&
        typeof candidate.text === 'string' &&
        candidate.text.length <= BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH
      );
    })
  );
}

export function isValidBridgeWorkspaceToolCapabilities(
  value: unknown,
): value is BridgeWorkspaceToolCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Record<string, unknown>;
  if (
    capabilities.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    !Array.isArray(capabilities.operations) ||
    capabilities.operations.length < 1 ||
    capabilities.operations.length > 2 ||
    !capabilities.operations.every(
      (operation) => operation === 'read_file' || operation === 'search_text',
    ) ||
    new Set(capabilities.operations).size !== capabilities.operations.length ||
    !Array.isArray(capabilities.workspaces) ||
    capabilities.workspaces.length < 1 ||
    capabilities.workspaces.length > BRIDGE_WORKSPACE_MAX_COUNT
  ) {
    return false;
  }

  const workspaceIds = new Set<string>();
  return capabilities.workspaces.every((workspace) => {
    if (typeof workspace !== 'object' || workspace === null) return false;
    const descriptor = workspace as Record<string, unknown>;
    if (
      Object.keys(descriptor).some((key) => key !== 'id' && key !== 'name') ||
      typeof descriptor.id !== 'string' ||
      !isValidBridgeWorkerId(descriptor.id) ||
      workspaceIds.has(descriptor.id) ||
      (descriptor.name !== undefined &&
        (typeof descriptor.name !== 'string' ||
          descriptor.name.trim().length === 0 ||
          descriptor.name.length > BRIDGE_WORKSPACE_NAME_MAX_LENGTH))
    ) {
      return false;
    }
    workspaceIds.add(descriptor.id);
    return true;
  });
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
      typeof capabilities.requiresReadyConfirmation === 'boolean') &&
    (capabilities.workspaceTools === undefined ||
      isValidBridgeWorkspaceToolCapabilities(capabilities.workspaceTools))
  );
}
