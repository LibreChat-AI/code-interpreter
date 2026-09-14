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
export const BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES = 100;
export const BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_INPUT_FILES =
    BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES - 2;
export const BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_CONCURRENCY = 4;
export const BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS = 30_000;

/** Reserve a bounded share for all input/output batches, not per-file grants. */
export function programmaticTransferReserveMs(jobTimeoutMs: number): number {
  return Math.max(1, Math.floor(jobTimeoutMs / 3));
}
export const BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_HISTORY_BYTES = 40_000_000;
export const BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** How long Code API drains a clean rejection after Stop cancels a workspace mutation. */
export const BRIDGE_CANCELLED_WORKSPACE_SETTLEMENT_GRACE_MS = 5_000;

/**
 * Artifact names accepted by the hardened egress gateway. Keep this policy in
 * the bridge protocol package so a remote worker can reject unsupported output
 * locally instead of discovering the mismatch only after mutating a workspace.
 */
const BRIDGE_ARTIFACT_EXTENSIONS = new Set([
    '.c',
    '.cs',
    '.cpp',
    '.go',
    '.java',
    '.js',
    '.kt',
    '.kts',
    '.lua',
    '.php',
    '.pl',
    '.ps1',
    '.py',
    '.r',
    '.rb',
    '.rs',
    '.scala',
    '.sh',
    '.sql',
    '.swift',
    '.ts',
    '.jsx',
    '.tsx',
    '.groovy',
    '.css',
    '.htm',
    '.html',
    '.less',
    '.sass',
    '.scss',
    '.svg',
    '.svelte',
    '.vue',
    '.adoc',
    '.asciidoc',
    '.md',
    '.rst',
    '.tex',
    '.txt',
    '.wiki',
    '.csv',
    '.json',
    '.bson',
    '.json5',
    '.jsonl',
    '.parquet',
    '.tsv',
    '.xml',
    '.yaml',
    '.yml',
    '.ics',
    '.ical',
    '.ifb',
    '.icalendar',
    '.conf',
    '.env',
    '.gitignore',
    '.ini',
    '.properties',
    '.toml',
    '.doc',
    '.docx',
    '.pdf',
    '.ppt',
    '.pptx',
    '.xls',
    '.xlsx',
    '.odt',
    '.ods',
    '.odp',
    '.rtf',
    '.avif',
    '.bmp',
    '.gif',
    '.ico',
    '.jpeg',
    '.jpg',
    '.png',
    '.tif',
    '.tiff',
    '.webp',
    '.eot',
    '.ttf',
    '.woff',
    '.woff2',
    '.7z',
    '.bz2',
    '.gz',
    '.gzip',
    '.rar',
    '.tar',
    '.zip',
    '.tf',
    '.tfvars',
    '.tfstate',
    '.hcl',
    '.dockerfile',
    '.Dockerfile',
    '.dockerignore',
    '.helmignore',
    '.helmfile',
    '.jenkinsfile',
    '.vagrantfile',
    '.eslintrc',
    '.prettierrc',
    '.editorconfig',
    '.nomad',
    '.bat',
    '.cmd',
    '.deb',
    '.log',
    '.rpm',
    '.vbs',
]);

function portableBasename(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** Apply the gateway's extension allowlist without importing service code. */
export function isSupportedBridgeArtifactName(name: string): boolean {
  const basename = portableBasename(name);
  if (basename === '.dirkeep') return true;
  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot).toLowerCase() : '';
  const dottedBasename = `.${basename}`;
  return (
    (extension !== '' && BRIDGE_ARTIFACT_EXTENSIONS.has(extension)) ||
    BRIDGE_ARTIFACT_EXTENSIONS.has(basename) ||
    BRIDGE_ARTIFACT_EXTENSIONS.has(basename.toLowerCase()) ||
    (extension === '' &&
      (BRIDGE_ARTIFACT_EXTENSIONS.has(dottedBasename) ||
        BRIDGE_ARTIFACT_EXTENSIONS.has(dottedBasename.toLowerCase())))
  );
}

const BRIDGE_ARTIFACT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.bz2': 'application/x-bzip2',
  '.c': 'text/x-c',
  '.conf': 'text/plain',
  '.cpp': 'text/x-c++src',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
    '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.gzip': 'application/gzip',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar',
  '.ifb': 'text/calendar',
  '.ical': 'text/calendar',
  '.icalendar': 'text/calendar',
  '.ini': 'text/plain',
  '.java': 'text/x-java-source',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.json5': 'application/json5',
  '.jsonl': 'application/x-ndjson',
  '.jsx': 'text/jsx',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.parquet': 'application/vnd.apache.parquet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.rst': 'text/x-rst',
  '.rtf': 'application/rtf',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tex': 'application/x-tex',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.toml': 'application/toml',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
    '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

/** Infer a safe response media type from an already-validated artifact name. */
export function bridgeArtifactMediaType(name: string): string {
  const basename = portableBasename(name).toLowerCase();
  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot) : basename;
  return BRIDGE_ARTIFACT_MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

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
export type WorkspaceListFileFeature = 'after_path';
export type WorkspaceProgrammaticLanguage = 'bash';

export interface BridgeWorkspaceDescriptor {
  id: string;
  name?: string;
  /** Optional per-workspace restriction. Omitted by protocol-v1 readers. */
  operations?: BridgeWorkspaceToolOperation[];
    environment?: {
        fingerprint: string;
        repo?: string;
        ref?: string;
        actions: string[];
    };
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
  /** Omitted by workers that cannot continue a bounded file listing. */
  listFileFeatures?: WorkspaceListFileFeature[];
  /** Languages that can execute PTC replay inside a selected workspace. */
  programmaticLanguages?: WorkspaceProgrammaticLanguage[];
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
  /** Continue strictly after this canonical path from a previous page. */
  afterPath?: string;
}

export interface WorkspaceListFilesResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'list_files';
  workspaceId: string;
  paths: string[];
  truncated: boolean;
  /** Last returned path; pass as afterPath to fetch the next page. */
  nextAfterPath?: string;
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
    environmentAction?: { name: string; fingerprint: string };
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
  'afterPath',
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
    'environmentAction',
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
  'nextAfterPath',
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
const WORKSPACE_SEARCH_MATCH_KEYS = new Set(['path', 'line', 'column', 'text']);

export interface BridgeWorkerCapabilities {
  /** Opt-in protocol: maximum concurrently leased independent workspace roots. */
  workspaceLeaseSlots?: number;
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
  /** Absent on legacy servers. Workers must not parallelize without this receipt. */
  workspaceLeaseSlots?: number;
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
  /** Listing features this Code API can safely route to a capability-aware worker. */
  supportedWorkspaceListFileFeatures?: WorkspaceListFileFeature[];
  /** PTC languages this Code API can safely route into a selected workspace. */
  supportedWorkspaceProgrammaticLanguages?: WorkspaceProgrammaticLanguage[];
}

/** Administrator-visible liveness for a configured worker. Credentials,
 * bindings, host paths, and worker identity material are deliberately omitted. */
export interface BridgeWorkerStatusResponse {
  protocolVersion: BridgeProtocolVersion;
  workerId: string;
  online: boolean;
  ready: boolean;
  leaseExpiresInMs?: number;
  capabilities?: BridgeWorkerCapabilities;
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

export type BridgeProgrammaticPayloadFile =
  | { name: string; content: string }
  | {
      name: string;
      id: string;
      storage_session_id: string;
      input_cache_key?: string;
    };

export interface BridgeWorkspaceProgrammaticBody {
  language: 'bash';
  version: string;
    /** Stable identity shared by every replay iteration of one execution. */
    execution_id?: string;
    /** Declared replay tools; zero allows the worker to skip the probe pass. */
    replay_tool_count?: number;
  run_timeout?: number;
  transfer_timeout_ms?: number;
    /** Manifest-bound upload ceiling negotiated by Code API. */
    max_output_files?: number;
    /** Effective per-file upload ceiling negotiated by Code API. */
    max_output_file_bytes?: number;
  files: BridgeProgrammaticPayloadFile[];
  session_id: string;
  output_session_id?: string;
  egress_grant?: string;
}

export type BridgeWorkspaceProgrammaticRequest =
  BridgeSandboxRequest<BridgeWorkspaceProgrammaticBody>;

export interface BridgeAssignment<TBody = object> {
  workspaceLeaseSlot?: number;
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
  executionKind?: 'sandbox' | 'workspace_tool' | 'workspace_programmatic';
  /** Selected workspace for workspace-scoped programmatic execution. */
  workspaceId?: string;
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
    | BridgeFulfilledSettlement<TResult>
    | BridgeRejectedSettlement;

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

export function isBridgeWorkspaceProgrammaticRequest(
  value: unknown,
): value is BridgeWorkspaceProgrammaticRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (
    typeof request.headers !== 'object' ||
    request.headers === null ||
        !Object.values(request.headers).every(
            entry => typeof entry === 'string',
        ) ||
    typeof request.body !== 'object' ||
    request.body === null
  ) {
    return false;
  }
  const body = request.body as Record<string, unknown>;
  if (
    body.language !== 'bash' ||
    typeof body.version !== 'string' ||
    body.version.length === 0 ||
    body.version.length > BRIDGE_RUNTIME_MAX_LENGTH ||
        (body.execution_id !== undefined &&
            (typeof body.execution_id !== 'string' ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(body.execution_id))) ||
        (body.replay_tool_count !== undefined &&
            (!Number.isSafeInteger(body.replay_tool_count) ||
                Number(body.replay_tool_count) < 0 ||
                Number(body.replay_tool_count) > 256)) ||
        (body.max_output_files !== undefined &&
            (!Number.isSafeInteger(body.max_output_files) ||
                Number(body.max_output_files) < 0 ||
                Number(body.max_output_files) >
                    BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES)) ||
        (body.max_output_file_bytes !== undefined &&
            (!Number.isSafeInteger(body.max_output_file_bytes) ||
                Number(body.max_output_file_bytes) < 1 ||
                Number(body.max_output_file_bytes) >
                    BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES)) ||
    typeof body.session_id !== 'string' ||
    body.session_id.length === 0 ||
    body.session_id.length > 32_768 ||
    /[\0\r\n]/.test(body.session_id) ||
    (body.output_session_id !== undefined &&
      (typeof body.output_session_id !== 'string' ||
        body.output_session_id.length === 0 ||
        body.output_session_id.length > 32_768 ||
        /[\0\r\n]/.test(body.output_session_id))) ||
    (body.egress_grant !== undefined &&
      (typeof body.egress_grant !== 'string' ||
        body.egress_grant.length === 0 ||
        body.egress_grant.length > 256 * 1024)) ||
    (body.transfer_timeout_ms !== undefined &&
      (!Number.isSafeInteger(body.transfer_timeout_ms) ||
        Number(body.transfer_timeout_ms) < 1 ||
                Number(body.transfer_timeout_ms) >
                    BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS)) ||
    (body.run_timeout !== undefined &&
      (!Number.isSafeInteger(body.run_timeout) ||
        Number(body.run_timeout) < 1 ||
                Number(body.run_timeout) >
                    BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS)) ||
    !Array.isArray(body.files) ||
    body.files.length < 1 ||
    body.files.length > BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES
  ) {
    return false;
  }
  let inlineBytes = 0;
  const names = new Set<string>();
  for (const rawFile of body.files) {
    if (typeof rawFile !== 'object' || rawFile === null) return false;
    const file = rawFile as Record<string, unknown>;
    if (
      !isSafePortableRelativePath(file.name) ||
      file.name === '.' ||
            portableBasename(file.name).toLowerCase() ===
                '_ptc_pending_result.json' ||
      normalizePortableRelativePath(file.name) !== file.name ||
      names.has(file.name)
    ) {
      return false;
    }
    names.add(file.name);
    if (typeof file.content === 'string') {
      inlineBytes += Buffer.byteLength(file.content);
      if (
                Object.keys(file).some(
                    key => key !== 'name' && key !== 'content',
                ) ||
                Buffer.byteLength(file.content) >
                    (file.name === '_ptc_history.json'
                        ? BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_HISTORY_BYTES
                        : BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILE_BYTES)
      ) {
        return false;
      }
      continue;
    }
    if (
      typeof file.id !== 'string' ||
      file.id.length === 0 ||
      file.id.length > 32_768 ||
      /[\0\r\n]/.test(file.id) ||
      typeof file.storage_session_id !== 'string' ||
      file.storage_session_id.length === 0 ||
      file.storage_session_id.length > 32_768 ||
      /[\0\r\n]/.test(file.storage_session_id) ||
      Object.keys(file).some(
                key =>
          key !== 'name' &&
          key !== 'id' &&
          key !== 'storage_session_id' &&
          key !== 'input_cache_key',
      ) ||
      (file.input_cache_key !== undefined &&
        (typeof file.input_cache_key !== 'string' ||
          !/^[a-f0-9]{64}$/.test(file.input_cache_key)))
    ) {
      return false;
    }
  }
  for (const name of names) {
    const segments = name.split('/');
    let ancestor = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
            ancestor = ancestor
                ? `${ancestor}/${segments[index]}`
                : segments[index]!;
      if (names.has(ancestor)) return false;
    }
  }
  return (
    names.has('main.sh') &&
    inlineBytes <= BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_TOTAL_BYTES
  );
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
    return value.split('/').every(segment => segment !== '..');
}

function normalizePortableRelativePath(value: string): string {
  return (
    value
      .split('/')
            .filter(segment => segment.length > 0 && segment !== '.')
      .join('/') || '.'
  );
}

/** Compare path segments in ripgrep's sorted, depth-first traversal order. */
export function comparePortableRelativePaths(
    left: string,
    right: string,
): number {
  const encoder = new TextEncoder();
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const segmentCount = Math.min(leftSegments.length, rightSegments.length);
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const leftBytes = encoder.encode(leftSegments[segmentIndex]);
    const rightBytes = encoder.encode(rightSegments[segmentIndex]);
    const byteCount = Math.min(leftBytes.length, rightBytes.length);
    for (let byteIndex = 0; byteIndex < byteCount; byteIndex += 1) {
      const difference = leftBytes[byteIndex] - rightBytes[byteIndex];
      if (difference !== 0) return difference;
    }
    const lengthDifference = leftBytes.length - rightBytes.length;
    if (lengthDifference !== 0) return lengthDifference;
  }
  return leftSegments.length - rightSegments.length;
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

function isValidWorkspaceEditRequest(
    request: Record<string, unknown>,
): boolean {
  const hasBatch = request.edits !== undefined;
    if (
        hasBatch &&
        (request.oldText !== undefined || request.newText !== undefined)
    ) {
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
            !hasOnlyKeys(
                edit as Record<string, unknown>,
                WORKSPACE_TEXT_EDIT_KEYS,
            )
    ) {
      return false;
    }
    const candidate = edit as Record<string, unknown>;
    if (
      typeof candidate.oldText !== 'string' ||
      candidate.oldText.length === 0 ||
            Buffer.from(candidate.oldText).toString('utf8') !==
                candidate.oldText ||
      typeof candidate.newText !== 'string' ||
            Buffer.from(candidate.newText).toString('utf8') !==
                candidate.newText
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
    return Object.keys(value).every(key => allowed.has(key));
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
                    Number(request.maxLines) <=
                        BRIDGE_WORKSPACE_READ_MAX_LINES))
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
                    Number(request.maxResults) <=
                        BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS))
    );
  }
  if (request.operation === 'list_files') {
    return (
      hasOnlyKeys(request, WORKSPACE_LIST_REQUEST_KEYS) &&
      (request.path === undefined ||
        isSafePortableRelativePath(request.path)) &&
      (request.afterPath === undefined ||
        (isSafePortableRelativePath(request.afterPath) &&
                    normalizePortableRelativePath(request.afterPath) ===
                        request.afterPath &&
          isWithinRequestedPath(request.afterPath, request.path))) &&
      (request.maxResults === undefined ||
        (Number.isSafeInteger(request.maxResults) &&
          Number(request.maxResults) >= 1 &&
                    Number(request.maxResults) <=
                        BRIDGE_WORKSPACE_LIST_MAX_RESULTS))
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
            (request.environmentAction === undefined ||
                (typeof request.environmentAction === 'object' &&
                    request.environmentAction !== null &&
                    Object.keys(request.environmentAction).length === 2 &&
                    typeof (request.environmentAction as { name?: unknown })
                        .name === 'string' &&
                    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(
                        (request.environmentAction as { name: string }).name,
                    ) &&
                    typeof (
                        request.environmentAction as { fingerprint?: unknown }
                    ).fingerprint === 'string' &&
                    /^[a-f0-9]{64}$/.test(
                        (request.environmentAction as { fingerprint: string })
                            .fingerprint,
                    ))) &&
      hasOnlyKeys(request, WORKSPACE_COMMAND_REQUEST_KEYS) &&
      typeof request.command === 'string' &&
      request.command.trim().length > 0 &&
      Buffer.from(request.command).toString('utf8') === request.command &&
      !request.command.includes('\0') &&
      new TextEncoder().encode(request.command).byteLength <=
        BRIDGE_WORKSPACE_COMMAND_MAX_BYTES &&
            (request.cwd === undefined ||
                isSafePortableRelativePath(request.cwd)) &&
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
  capabilities?: Pick<BridgeWorkspaceToolCapabilities, 'listFileFeatures'>,
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
        const content =
            typeof result.content === 'string' ? result.content : null;
    const reportedLineCount =
            Number.isSafeInteger(result.endLine) &&
            Number(result.endLine) >= startLine - 1
        ? Number(result.endLine) - startLine + 1
        : -1;
    const actualLineCount =
            content === null
                ? -1
                : content.length === 0
                  ? reportedLineCount
                  : content.split('\n').length;
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
    const normalizedAfterPath =
      request.afterPath === undefined
        ? undefined
        : normalizePortableRelativePath(request.afterPath);
    const enforcesPaginationContract =
      capabilities === undefined ||
      capabilities.listFileFeatures?.includes('after_path') === true;
    let previousPath = normalizedAfterPath;
    for (const path of result.paths) {
      if (
        !isSafePortableRelativePath(path) ||
        !isWithinRequestedPath(path, request.path)
      ) {
        return false;
      }
      const normalizedPath = normalizePortableRelativePath(path);
      if (
        normalizedPaths.has(normalizedPath) ||
        (enforcesPaginationContract &&
          (normalizedPath !== path ||
            (previousPath !== undefined &&
                            comparePortableRelativePaths(
                                normalizedPath,
                                previousPath,
                            ) <= 0)))
      ) {
        return false;
      }
      normalizedPaths.add(normalizedPath);
      previousPath = normalizedPath;
    }
    if (!enforcesPaginationContract) {
      return result.nextAfterPath === undefined;
    }
        if (result.truncated !== true)
            return result.nextAfterPath === undefined;
    return (
      result.paths.length > 0 &&
      result.nextAfterPath === result.paths[result.paths.length - 1]
    );
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
        const content =
            typeof result.content === 'string' ? result.content : null;
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
            request.maxOutputBytes ??
            BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES;
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
                    result.signal.length <=
                        BRIDGE_WORKSPACE_COMMAND_SIGNAL_MAX_LENGTH &&
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
        result.matches.every(match => {
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
                candidate.text.length <=
                    BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH &&
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
            operation =>
        operation === 'read_file' ||
        operation === 'search_text' ||
        operation === 'list_files' ||
        operation === 'write_file' ||
        operation === 'preview_edit' ||
        operation === 'edit_file' ||
        operation === 'execute_command',
    ) ||
        new Set(capabilities.operations).size !==
            capabilities.operations.length ||
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
                mode => mode === 'replace' || mode === 'create',
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
                mode => mode === 'single' || mode === 'batch',
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

  if (
    capabilities.listFileFeatures !== undefined &&
    (!Array.isArray(capabilities.listFileFeatures) ||
      capabilities.listFileFeatures.length !== 1 ||
      !capabilities.operations.includes('list_files') ||
      capabilities.listFileFeatures[0] !== 'after_path')
  ) {
    return false;
  }

  if (
    capabilities.programmaticLanguages !== undefined &&
    (!Array.isArray(capabilities.programmaticLanguages) ||
      capabilities.programmaticLanguages.length !== 1 ||
      !capabilities.operations.includes('execute_command') ||
      capabilities.programmaticLanguages[0] !== 'bash')
  ) {
    return false;
  }

  const workspaceIds = new Set<string>();
    return capabilities.workspaces.every(workspace => {
    if (typeof workspace !== 'object' || workspace === null) return false;
    const descriptor = workspace as Record<string, unknown>;
    if (
      Object.keys(descriptor).some(
                key =>
                    key !== 'id' &&
                    key !== 'name' &&
                    key !== 'operations' &&
                    key !== 'environment',
      ) ||
      typeof descriptor.id !== 'string' ||
      !isValidBridgeWorkerId(descriptor.id) ||
      workspaceIds.has(descriptor.id) ||
            (descriptor.environment !== undefined &&
                !isValidCodeEnvironmentDescriptor(descriptor.environment)) ||
      (descriptor.name !== undefined &&
        (typeof descriptor.name !== 'string' ||
          descriptor.name.trim().length === 0 ||
                    descriptor.name.length >
                        BRIDGE_WORKSPACE_NAME_MAX_LENGTH)) ||
      (descriptor.operations !== undefined &&
        (!Array.isArray(descriptor.operations) ||
          descriptor.operations.length < 1 ||
          descriptor.operations.length >
            (capabilities.operations as unknown[]).length ||
          descriptor.operations.some(
                        operation =>
                            !(capabilities.operations as unknown[]).includes(
                                operation,
                            ),
          ) ||
                    new Set(descriptor.operations).size !==
                        descriptor.operations.length))
    ) {
      return false;
    }
    workspaceIds.add(descriptor.id);
    return true;
  });
}

export function isValidCodeEnvironmentDescriptor(
    value: unknown,
): value is NonNullable<BridgeWorkspaceDescriptor['environment']> {
    if (typeof value !== 'object' || value === null) return false;
    const environment = value as Record<string, unknown>;
    return (
        Object.keys(environment).every(key =>
            ['fingerprint', 'repo', 'ref', 'actions'].includes(key),
        ) &&
        typeof environment.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(environment.fingerprint) &&
        (environment.repo === undefined ||
            (typeof environment.repo === 'string' &&
                environment.repo.length <= 256 &&
                /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.repo))) &&
        (environment.ref === undefined ||
            (typeof environment.ref === 'string' &&
                environment.ref.trim().length > 0 &&
                environment.ref.length <= 256 &&
                !/[\0\r\n]/.test(environment.ref))) &&
        Array.isArray(environment.actions) &&
        environment.actions.length <= 32 &&
        environment.actions.every(
            name =>
                typeof name === 'string' &&
                /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name),
        ) &&
        new Set(environment.actions).size === environment.actions.length
    );
}

export function isValidBridgeWorkerCapabilities(
  value: unknown,
): value is BridgeWorkerCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Record<string, unknown>;
  return (
    (capabilities.workspaceLeaseSlots === undefined ||
      (Number.isSafeInteger(capabilities.workspaceLeaseSlots) &&
        Number(capabilities.workspaceLeaseSlots) >= 1 &&
        Number(capabilities.workspaceLeaseSlots) <= 8)) &&
    typeof capabilities.statefulWorkspace === 'boolean' &&
    typeof capabilities.sandboxProfile === 'string' &&
    capabilities.sandboxProfile.trim().length > 0 &&
        capabilities.sandboxProfile.length <=
            BRIDGE_SANDBOX_PROFILE_MAX_LENGTH &&
    Array.isArray(capabilities.runtimes) &&
    capabilities.runtimes.length <= BRIDGE_RUNTIME_MAX_COUNT &&
    capabilities.runtimes.every(
            runtime =>
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
