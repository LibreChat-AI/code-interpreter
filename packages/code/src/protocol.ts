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
export const BRIDGE_WORKSPACE_WRITE_MAX_BYTES = 1024 * 1024;
export const BRIDGE_WORKSPACE_EDIT_MAX_EDITS = 100;
export const BRIDGE_WORKSPACE_READ_MAX_LINES = 500;
export const BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS = 200;
export const BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH = 2000;
export const BRIDGE_WORKSPACE_LIST_MAX_RESULTS = 500;
export const BRIDGE_WORKSPACE_COMMAND_MAX_BYTES = 32 * 1024;
export const BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;
export const BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS = 5 * 60_000;
export const BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES = 256 * 1024;
export const BRIDGE_WORKSPACE_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
export const BRIDGE_WORKSPACE_COMMAND_SIGNAL_MAX_LENGTH = 32;

export type BridgeProtocolVersion = typeof BRIDGE_PROTOCOL_VERSION;

export type BridgeWorkspaceToolOperation =
  | 'read_file'
  | 'search_text'
  | 'list_files'
  | 'write_file'
  | 'preview_edit'
  | 'edit_file'
  | 'execute_command';

export type WorkspaceWriteFileMode = 'replace' | 'create';
export type WorkspaceEditFileMode = 'single' | 'batch';
export type WorkspaceEditFileFeature = 'expected_base_sha256';

export interface BridgeWorkspaceDescriptor {
  id: string;
  name?: string;
  /** Optional per-workspace restriction. Omitted by protocol-v1 readers. */
  operations?: BridgeWorkspaceToolOperation[];
}

export interface BridgeWorkspaceToolCapabilities {
  protocolVersion: BridgeProtocolVersion;
  operations: BridgeWorkspaceToolOperation[];
  workspaces: BridgeWorkspaceDescriptor[];
  /** Omitted by legacy workers, which only accept replacement writes. */
  writeFileModes?: WorkspaceWriteFileMode[];
  /** Omitted by legacy workers, which only accept single exact replacements. */
  editFileModes?: WorkspaceEditFileMode[];
  /** Omitted by workers that cannot fence edits against a preview revision. */
  editFileFeatures?: WorkspaceEditFileFeature[];
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

export interface WorkspaceListFilesRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'list_files';
  workspaceId: string;
  path?: string;
  maxResults?: number;
}

export interface WorkspaceListFilesResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'list_files';
  workspaceId: string;
  paths: string[];
  truncated: boolean;
}

export interface WorkspaceWriteFileRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'write_file';
  workspaceId: string;
  path: string;
  content: string;
  /** False requires an atomic create and refuses to replace an existing file. */
  overwrite?: boolean;
}

export interface WorkspaceWriteFileResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'write_file';
  workspaceId: string;
  path: string;
  created: boolean;
  bytesWritten: number;
}

interface WorkspaceEditFileRequestBase {
  protocolVersion: BridgeProtocolVersion;
  operation: 'edit_file';
  workspaceId: string;
  path: string;
  /** Refuses the mutation unless current file bytes match this preview revision. */
  expectedBaseSha256?: string;
}

export interface WorkspaceSingleEditFileRequest
  extends WorkspaceEditFileRequestBase {
  /** Legacy single-edit form. */
  oldText: string;
  /** Legacy single-edit form. */
  newText: string;
  edits?: never;
}

export interface WorkspaceBatchEditFileRequest
  extends WorkspaceEditFileRequestBase {
  /** Ordered exact replacements applied atomically as one file mutation. */
  edits: WorkspaceTextEdit[];
  oldText?: never;
  newText?: never;
}

export type WorkspaceEditFileRequest =
  | WorkspaceSingleEditFileRequest
  | WorkspaceBatchEditFileRequest;

export interface WorkspaceTextEdit {
  oldText: string;
  newText: string;
}

export interface WorkspaceEditFileResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'edit_file';
  workspaceId: string;
  path: string;
  replacements: number;
  bytesWritten: number;
}

interface WorkspacePreviewEditRequestBase {
  protocolVersion: BridgeProtocolVersion;
  operation: 'preview_edit';
  workspaceId: string;
  path: string;
}

export interface WorkspaceSinglePreviewEditRequest
  extends WorkspacePreviewEditRequestBase {
  oldText: string;
  newText: string;
  edits?: never;
}

export interface WorkspaceBatchPreviewEditRequest
  extends WorkspacePreviewEditRequestBase {
  edits: WorkspaceTextEdit[];
  oldText?: never;
  newText?: never;
}

export type WorkspacePreviewEditRequest =
  | WorkspaceSinglePreviewEditRequest
  | WorkspaceBatchPreviewEditRequest;

export interface WorkspacePreviewEditResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'preview_edit';
  workspaceId: string;
  path: string;
  content: string;
  hasUtf8Bom: boolean;
  baseSha256: string;
  replacements: number;
  bytesWritten: number;
}

export interface WorkspaceExecuteCommandRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'execute_command';
  workspaceId: string;
  /** Shell source evaluated only inside the selected sandbox runtime. */
  command: string;
  /** Portable path relative to the workspace root; defaults to '.'. */
  cwd?: string;
  timeoutMs?: number;
  /** Aggregate UTF-8 stdout and stderr budget. */
  maxOutputBytes?: number;
}

export interface WorkspaceExecuteCommandResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'execute_command';
  workspaceId: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export type WorkspaceToolRequest =
  | WorkspaceReadFileRequest
  | WorkspaceSearchTextRequest
  | WorkspaceListFilesRequest
  | WorkspaceWriteFileRequest
  | WorkspacePreviewEditRequest
  | WorkspaceEditFileRequest
  | WorkspaceExecuteCommandRequest;
export type WorkspaceToolResult =
  | WorkspaceReadFileResult
  | WorkspaceSearchTextResult
  | WorkspaceListFilesResult
  | WorkspaceWriteFileResult
  | WorkspacePreviewEditResult
  | WorkspaceEditFileResult
  | WorkspaceExecuteCommandResult;

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
const WORKSPACE_LIST_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'maxResults',
]);
const WORKSPACE_WRITE_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'content',
  'overwrite',
]);
const WORKSPACE_EDIT_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'oldText',
  'newText',
  'edits',
  'expectedBaseSha256',
]);
const WORKSPACE_PREVIEW_EDIT_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'oldText',
  'newText',
  'edits',
]);
const WORKSPACE_TEXT_EDIT_KEYS = new Set(['oldText', 'newText']);
const WORKSPACE_COMMAND_REQUEST_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'command',
  'cwd',
  'timeoutMs',
  'maxOutputBytes',
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
const WORKSPACE_LIST_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'paths',
  'truncated',
]);
const WORKSPACE_WRITE_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'created',
  'bytesWritten',
]);
const WORKSPACE_EDIT_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'replacements',
  'bytesWritten',
]);
const WORKSPACE_PREVIEW_EDIT_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'path',
  'content',
  'hasUtf8Bom',
  'baseSha256',
  'replacements',
  'bytesWritten',
]);
const WORKSPACE_COMMAND_RESULT_KEYS = new Set([
  'protocolVersion',
  'operation',
  'workspaceId',
  'exitCode',
  'signal',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
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
  /** Operations this Code API can dispatch after the worker advertises them. */
  supportedWorkspaceToolOperations?: BridgeWorkspaceToolOperation[];
  /** Write modes this Code API can safely route to a capability-aware worker. */
  supportedWorkspaceWriteFileModes?: WorkspaceWriteFileMode[];
  /** Edit modes this Code API can safely route to a capability-aware worker. */
  supportedWorkspaceEditFileModes?: WorkspaceEditFileMode[];
  /** Edit features this Code API can safely route to a capability-aware worker. */
  supportedWorkspaceEditFileFeatures?: WorkspaceEditFileFeature[];
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
  errorCode?: WorkspaceToolErrorCode;
}

export type WorkspaceToolErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_REQUEST'
  | 'READ_LIMIT_EXCEEDED'
  | 'WRITE_LIMIT_EXCEEDED'
  | 'WRITE_DISABLED'
  | 'WRITE_UNAVAILABLE'
  | 'EDIT_CONFLICT'
  | 'REGISTRATION_INVALID'
  | 'EXECUTION_ABORTED'
  | 'LIST_TIMEOUT'
  | 'LIST_UNAVAILABLE'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_UNAVAILABLE'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_UNAVAILABLE'
  | 'COMMAND_DISABLED';

const WORKSPACE_TOOL_ERROR_CODES = new Set<WorkspaceToolErrorCode>([
  'INVALID_PATH',
  'INVALID_REQUEST',
  'READ_LIMIT_EXCEEDED',
  'WRITE_LIMIT_EXCEEDED',
  'WRITE_DISABLED',
  'WRITE_UNAVAILABLE',
  'EDIT_CONFLICT',
  'REGISTRATION_INVALID',
  'EXECUTION_ABORTED',
  'LIST_TIMEOUT',
  'LIST_UNAVAILABLE',
  'SEARCH_TIMEOUT',
  'SEARCH_UNAVAILABLE',
  'COMMAND_TIMEOUT',
  'COMMAND_UNAVAILABLE',
  'COMMAND_DISABLED',
]);

export function isWorkspaceToolErrorCode(
  value: unknown,
): value is WorkspaceToolErrorCode {
  return (
    typeof value === 'string' &&
    WORKSPACE_TOOL_ERROR_CODES.has(value as WorkspaceToolErrorCode)
  );
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

export function isSafePortableRelativePath(value: unknown): value is string {
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

function normalizePortableRelativePath(value: string): string {
  return (
    value
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.')
      .join('/') || '.'
  );
}

function isWithinRequestedPath(candidate: string, requested?: string): boolean {
  if (requested == null) return true;
  const normalizedCandidate = normalizePortableRelativePath(candidate);
  const normalizedRequested = normalizePortableRelativePath(requested);
  return (
    normalizedRequested === '.' ||
    normalizedCandidate === normalizedRequested ||
    normalizedCandidate.startsWith(`${normalizedRequested}/`)
  );
}

function isValidWorkspaceEditRequest(request: Record<string, unknown>): boolean {
  const hasBatch = request.edits !== undefined;
  if (hasBatch && (request.oldText !== undefined || request.newText !== undefined)) {
    return false;
  }
  const edits = hasBatch
    ? request.edits
    : [{ oldText: request.oldText, newText: request.newText }];
  if (
    !Array.isArray(edits) ||
    edits.length < 1 ||
    edits.length > BRIDGE_WORKSPACE_EDIT_MAX_EDITS
  ) {
    return false;
  }
  let totalBytes = 0;
  for (const edit of edits) {
    if (
      typeof edit !== 'object' ||
      edit === null ||
      !hasOnlyKeys(edit as Record<string, unknown>, WORKSPACE_TEXT_EDIT_KEYS)
    ) {
      return false;
    }
    const candidate = edit as Record<string, unknown>;
    if (
      typeof candidate.oldText !== 'string' ||
      candidate.oldText.length === 0 ||
      Buffer.from(candidate.oldText).toString('utf8') !== candidate.oldText ||
      typeof candidate.newText !== 'string' ||
      Buffer.from(candidate.newText).toString('utf8') !== candidate.newText
    ) {
      return false;
    }
    const oldBytes = new TextEncoder().encode(candidate.oldText).byteLength;
    const newBytes = new TextEncoder().encode(candidate.newText).byteLength;
    totalBytes += oldBytes + newBytes;
    if (
      (hasBatch && totalBytes > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) ||
      (!hasBatch &&
        (oldBytes > BRIDGE_WORKSPACE_WRITE_MAX_BYTES ||
          newBytes > BRIDGE_WORKSPACE_WRITE_MAX_BYTES))
    ) {
      return false;
    }
  }
  return true;
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
  if (request.operation === 'list_files') {
    return (
      hasOnlyKeys(request, WORKSPACE_LIST_REQUEST_KEYS) &&
      (request.path === undefined ||
        isSafePortableRelativePath(request.path)) &&
      (request.maxResults === undefined ||
        (Number.isSafeInteger(request.maxResults) &&
          Number(request.maxResults) >= 1 &&
          Number(request.maxResults) <= BRIDGE_WORKSPACE_LIST_MAX_RESULTS))
    );
  }
  if (request.operation === 'write_file') {
    return (
      hasOnlyKeys(request, WORKSPACE_WRITE_REQUEST_KEYS) &&
      isSafePortableRelativePath(request.path) &&
      typeof request.content === 'string' &&
      Buffer.from(request.content).toString('utf8') === request.content &&
      new TextEncoder().encode(request.content).byteLength <=
        BRIDGE_WORKSPACE_WRITE_MAX_BYTES &&
      (request.overwrite === undefined ||
        typeof request.overwrite === 'boolean')
    );
  }
  if (request.operation === 'preview_edit') {
    return (
      hasOnlyKeys(request, WORKSPACE_PREVIEW_EDIT_REQUEST_KEYS) &&
      isSafePortableRelativePath(request.path) &&
      isValidWorkspaceEditRequest(request)
    );
  }
  if (request.operation === 'edit_file') {
    return (
      hasOnlyKeys(request, WORKSPACE_EDIT_REQUEST_KEYS) &&
      isSafePortableRelativePath(request.path) &&
      (request.expectedBaseSha256 === undefined ||
        (typeof request.expectedBaseSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(request.expectedBaseSha256))) &&
      isValidWorkspaceEditRequest(request)
    );
  }
  if (request.operation === 'execute_command') {
    return (
      hasOnlyKeys(request, WORKSPACE_COMMAND_REQUEST_KEYS) &&
      typeof request.command === 'string' &&
      request.command.trim().length > 0 &&
      Buffer.from(request.command).toString('utf8') === request.command &&
      !request.command.includes('\0') &&
      new TextEncoder().encode(request.command).byteLength <=
        BRIDGE_WORKSPACE_COMMAND_MAX_BYTES &&
      (request.cwd === undefined || isSafePortableRelativePath(request.cwd)) &&
      (request.timeoutMs === undefined ||
        (Number.isSafeInteger(request.timeoutMs) &&
          Number(request.timeoutMs) >= 1 &&
          Number(request.timeoutMs) <=
            BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS)) &&
      (request.maxOutputBytes === undefined ||
        (Number.isSafeInteger(request.maxOutputBytes) &&
          Number(request.maxOutputBytes) >= 1 &&
          Number(request.maxOutputBytes) <=
            BRIDGE_WORKSPACE_COMMAND_MAX_OUTPUT_BYTES))
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
    (request.operation === 'read_file' ||
    request.operation === 'search_text' ||
    request.operation === 'list_files'
      ? typeof result.truncated !== 'boolean'
      : false)
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
          Number(result.nextStartLine) === Number(result.endLine) + 1 &&
          Number(result.nextStartLine) > startLine
        : result.nextStartLine === undefined)
    );
  }

  if (request.operation === 'list_files') {
    const maxResults = request.maxResults ?? 100;
    if (
      !hasOnlyKeys(result, WORKSPACE_LIST_RESULT_KEYS) ||
      !Array.isArray(result.paths) ||
      result.paths.length > maxResults
    ) {
      return false;
    }
    const normalizedPaths = new Set<string>();
    for (const path of result.paths) {
      if (
        !isSafePortableRelativePath(path) ||
        !isWithinRequestedPath(path, request.path)
      ) {
        return false;
      }
      const normalizedPath = normalizePortableRelativePath(path);
      if (normalizedPaths.has(normalizedPath)) return false;
      normalizedPaths.add(normalizedPath);
    }
    return true;
  }

  if (request.operation === 'write_file') {
    return (
      hasOnlyKeys(result, WORKSPACE_WRITE_RESULT_KEYS) &&
      result.path === request.path &&
      typeof result.created === 'boolean' &&
      (request.overwrite !== false || result.created === true) &&
      Number.isSafeInteger(result.bytesWritten) &&
      Number(result.bytesWritten) ===
        new TextEncoder().encode(request.content).byteLength
    );
  }

  if (request.operation === 'edit_file') {
    const replacements = request.edits?.length ?? 1;
    return (
      hasOnlyKeys(result, WORKSPACE_EDIT_RESULT_KEYS) &&
      result.path === request.path &&
      result.replacements === replacements &&
      Number.isSafeInteger(result.bytesWritten) &&
      Number(result.bytesWritten) >= 0 &&
      Number(result.bytesWritten) <= BRIDGE_WORKSPACE_WRITE_MAX_BYTES
    );
  }

  if (request.operation === 'preview_edit') {
    const replacements = request.edits?.length ?? 1;
    const content = typeof result.content === 'string' ? result.content : null;
    return (
      hasOnlyKeys(result, WORKSPACE_PREVIEW_EDIT_RESULT_KEYS) &&
      result.path === request.path &&
      content !== null &&
      Buffer.from(content).toString('utf8') === content &&
      typeof result.hasUtf8Bom === 'boolean' &&
      typeof result.baseSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(result.baseSha256) &&
      result.replacements === replacements &&
      Number.isSafeInteger(result.bytesWritten) &&
      Number(result.bytesWritten) ===
        new TextEncoder().encode(content).byteLength +
          (result.hasUtf8Bom ? 3 : 0) &&
      Number(result.bytesWritten) <= BRIDGE_WORKSPACE_WRITE_MAX_BYTES
    );
  }

  if (request.operation === 'execute_command') {
    const stdout = typeof result.stdout === 'string' ? result.stdout : null;
    const stderr = typeof result.stderr === 'string' ? result.stderr : null;
    const outputLimit =
      request.maxOutputBytes ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES;
    return (
      hasOnlyKeys(result, WORKSPACE_COMMAND_RESULT_KEYS) &&
      stdout !== null &&
      stderr !== null &&
      Buffer.from(stdout).toString('utf8') === stdout &&
      Buffer.from(stderr).toString('utf8') === stderr &&
      new TextEncoder().encode(stdout).byteLength +
        new TextEncoder().encode(stderr).byteLength <=
        outputLimit &&
      (result.exitCode === null ||
        (Number.isSafeInteger(result.exitCode) &&
          Number(result.exitCode) >= 0 &&
          Number(result.exitCode) <= 255)) &&
      (result.signal === undefined ||
        (typeof result.signal === 'string' &&
          result.signal.length <= BRIDGE_WORKSPACE_COMMAND_SIGNAL_MAX_LENGTH &&
          /^SIG[A-Z0-9]+$/.test(result.signal))) &&
      typeof result.truncated === 'boolean' &&
      typeof result.timedOut === 'boolean' &&
      (result.exitCode === null
        ? result.timedOut === true || result.signal !== undefined
        : result.timedOut === false && result.signal === undefined)
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
        isWithinRequestedPath(candidate.path, request.path) &&
        Number.isSafeInteger(candidate.line) &&
        Number(candidate.line) >= 1 &&
        Number.isSafeInteger(candidate.column) &&
        Number(candidate.column) >= 1 &&
        typeof candidate.text === 'string' &&
        candidate.text.length <= BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH &&
        candidate.text.includes(request.query)
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
    capabilities.operations.length > 7 ||
    !capabilities.operations.every(
      (operation) =>
        operation === 'read_file' ||
        operation === 'search_text' ||
        operation === 'list_files' ||
        operation === 'write_file' ||
        operation === 'preview_edit' ||
        operation === 'edit_file' ||
        operation === 'execute_command',
    ) ||
    new Set(capabilities.operations).size !== capabilities.operations.length ||
    !Array.isArray(capabilities.workspaces) ||
    capabilities.workspaces.length < 1 ||
    capabilities.workspaces.length > BRIDGE_WORKSPACE_MAX_COUNT
  ) {
    return false;
  }

  if (
    capabilities.writeFileModes !== undefined &&
    (!Array.isArray(capabilities.writeFileModes) ||
      capabilities.writeFileModes.length < 1 ||
      capabilities.writeFileModes.length > 2 ||
      !capabilities.operations.includes('write_file') ||
      !capabilities.writeFileModes.every(
        (mode) => mode === 'replace' || mode === 'create',
      ) ||
      new Set(capabilities.writeFileModes).size !==
        capabilities.writeFileModes.length)
  ) {
    return false;
  }

  if (
    capabilities.editFileModes !== undefined &&
    (!Array.isArray(capabilities.editFileModes) ||
      capabilities.editFileModes.length < 1 ||
      capabilities.editFileModes.length > 2 ||
      (!capabilities.operations.includes('edit_file') &&
        !capabilities.operations.includes('preview_edit')) ||
      !capabilities.editFileModes.every(
        (mode) => mode === 'single' || mode === 'batch',
      ) ||
      new Set(capabilities.editFileModes).size !==
        capabilities.editFileModes.length)
  ) {
    return false;
  }

  if (
    capabilities.editFileFeatures !== undefined &&
    (!Array.isArray(capabilities.editFileFeatures) ||
      capabilities.editFileFeatures.length !== 1 ||
      !capabilities.operations.includes('edit_file') ||
      capabilities.editFileFeatures[0] !== 'expected_base_sha256')
  ) {
    return false;
  }

  const workspaceIds = new Set<string>();
  return capabilities.workspaces.every((workspace) => {
    if (typeof workspace !== 'object' || workspace === null) return false;
    const descriptor = workspace as Record<string, unknown>;
    if (
      Object.keys(descriptor).some(
        (key) => key !== 'id' && key !== 'name' && key !== 'operations',
      ) ||
      typeof descriptor.id !== 'string' ||
      !isValidBridgeWorkerId(descriptor.id) ||
      workspaceIds.has(descriptor.id) ||
      (descriptor.name !== undefined &&
        (typeof descriptor.name !== 'string' ||
          descriptor.name.trim().length === 0 ||
          descriptor.name.length > BRIDGE_WORKSPACE_NAME_MAX_LENGTH)) ||
      (descriptor.operations !== undefined &&
        (!Array.isArray(descriptor.operations) ||
          descriptor.operations.length < 1 ||
          descriptor.operations.length >
            (capabilities.operations as unknown[]).length ||
          descriptor.operations.some(
            (operation) =>
              !(capabilities.operations as unknown[]).includes(operation),
          ) ||
          new Set(descriptor.operations).size !== descriptor.operations.length))
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
