import { posix } from 'path';
import { nanoid } from 'nanoid';

import type * as t from '../types';
import type { GatewayPreparedEgress } from '../egress-gateway-client';
import type { ExecutionManifestClaims } from '../execution-manifest';
import type { SessionOwnershipStore } from '../session-ownership';
import type { WorkspaceImportFileRequest } from '../../../packages/code/src/protocol';

import { isValidId } from '../utils';
import { authorizeSessionOwnership } from '../session-ownership';
import { resolveSessionKey, SessionKeyResolutionError } from '../session-key';
import { buildExecutionManifestClaims } from '../execution-manifest-claims';

/** One download plus one retry of the same object; nothing else is readable. */
const IMPORT_GRANT_MAX_REQUESTS = 2;
/** Clock-skew slack beyond the request's own admission and execution budget. */
const IMPORT_GRANT_TTL_SLACK_SECONDS = 30;

export type WorkspaceImportErrorCode =
  | 'INVALID_WORKSPACE_TOOL_REQUEST'
  | 'IMPORT_SOURCE_UNAUTHORIZED'
  | 'IMPORT_UNAVAILABLE';

export class WorkspaceImportError extends Error {
  constructor(
    readonly status: 400 | 403 | 503,
    readonly code: WorkspaceImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceImportError';
  }
}

/** Redis reads used to prove ownership: the session cache key and the upload record. */
export interface WorkspaceImportSourceStore extends Pick<SessionOwnershipStore, 'get'> {
  exists(key: string): Promise<number>;
}

export type WorkspaceImportGrantFactory = (args: {
  payload: t.PayloadBody;
  claims: ExecutionManifestClaims;
}) => Promise<GatewayPreparedEgress>;

export interface PreparedWorkspaceImport {
  grantId: string;
  request: WorkspaceImportFileRequest & { egressGrant: string };
}

export interface WorkspaceImportService {
  /** Largest file Code API relays, checked before ownership or dispatch. */
  readonly maxBytes: number;
  /** Proves the caller owns `source` and returns the storage session key that owns it. */
  authorize(req: t.AuthenticatedRequest, request: WorkspaceImportFileRequest): Promise<string>;
  /** Mints the one-object grant and rewrites `source` into its opaque handles. */
  prepare(args: {
    req: t.AuthenticatedRequest;
    request: WorkspaceImportFileRequest;
    sessionKey: string;
    ttlSeconds: number;
  }): Promise<PreparedWorkspaceImport>;
  revoke(grantId: string): Promise<void>;
}

const unauthorized = (): WorkspaceImportError =>
  new WorkspaceImportError(403, 'IMPORT_SOURCE_UNAUTHORIZED', 'Unauthorized import source');

/**
 * Applies the `GET /download/:session_id/:fileId` rule for a user-kind object:
 * the live session cache key must name the caller's own storage key, and the
 * object must have been uploaded under that key and session.
 */
export async function authorizeWorkspaceImportSource(args: {
  req: t.AuthenticatedRequest;
  source: WorkspaceImportFileRequest['source'];
  store: WorkspaceImportSourceStore;
}): Promise<string> {
  const { req, source, store } = args;
  if (!isValidId(source.storage_session_id) || !isValidId(source.id)) {
    throw new WorkspaceImportError(400, 'INVALID_WORKSPACE_TOOL_REQUEST', 'Invalid import source');
  }
  const userId = req.codeApiAuthContext?.userId;
  if (!userId) throw unauthorized();
  let sessionKey: string;
  try {
    sessionKey = resolveSessionKey(req, { kind: 'user', id: userId });
  } catch (error) {
    if (error instanceof SessionKeyResolutionError && error.status === 400) throw unauthorized();
    throw error;
  }
  const ownership = await authorizeSessionOwnership(store, {
    session_id: source.storage_session_id,
    expectedSessionKey: sessionKey,
    allowExpiredCache: false,
  });
  if (!ownership.authorized) throw unauthorized();
  const uploaded = await store.exists(`upload:${sessionKey}${source.storage_session_id}${source.id}`);
  if (uploaded !== 1) throw unauthorized();
  return sessionKey;
}

/** Claims for a read-only grant over exactly one object, with no upload capacity. */
export function workspaceImportGrantClaims(args: {
  req: t.AuthenticatedRequest;
  request: WorkspaceImportFileRequest;
  sessionKey: string;
  ttlSeconds: number;
  nowSeconds?: number;
}): { payload: t.PayloadBody; claims: ExecutionManifestClaims } {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: t.PayloadBody = {
    language: 'workspace-import',
    version: '1',
    files: [{
      id: args.request.source.id,
      storage_session_id: args.request.source.storage_session_id,
      name: posix.basename(args.request.path),
    }],
  };
  const claims = buildExecutionManifestClaims({
    req: args.req,
    executionId: `import_${nanoid()}`,
    userId: args.req.codeApiAuthContext?.userId ?? '',
    sessionKey: args.sessionKey,
    outputSessionId: `import_${nanoid()}`,
    payload,
    nowSeconds: now,
  });
  return {
    payload,
    claims: {
      ...claims,
      max_upload_bytes: 0,
      max_output_files: 0,
      max_requests: IMPORT_GRANT_MAX_REQUESTS,
      tool_call_socket: false,
      exp: now + Math.max(1, Math.ceil(args.ttlSeconds)) + IMPORT_GRANT_TTL_SLACK_SECONDS,
    },
  };
}

function isPayloadFileRef(file: t.PayloadBody['files'][number] | undefined): file is t.PayloadFileRef {
  return file != null && 'id' in file && typeof file.id === 'string' &&
    typeof file.storage_session_id === 'string';
}

export function createWorkspaceImportService(options: {
  maxBytes: number;
  store: WorkspaceImportSourceStore;
  createGrant: WorkspaceImportGrantFactory;
  revokeGrant: (grantId: string) => Promise<void>;
}): WorkspaceImportService {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError('Workspace import file limit must be a positive safe integer');
  }
  return {
    maxBytes: options.maxBytes,
    authorize: (req, request) => authorizeWorkspaceImportSource({ req, source: request.source, store: options.store }),
    async prepare({ req, request, sessionKey, ttlSeconds }) {
      let prepared: GatewayPreparedEgress;
      try {
        prepared = await options.createGrant(workspaceImportGrantClaims({ req, request, sessionKey, ttlSeconds }));
      } catch {
        throw new WorkspaceImportError(503, 'IMPORT_UNAVAILABLE', 'Import source grant could not be issued');
      }
      const [file] = prepared.payload.files;
      if (!isPayloadFileRef(file) || prepared.payload.files.length !== 1 || !prepared.egressGrantToken) {
        throw new WorkspaceImportError(503, 'IMPORT_UNAVAILABLE', 'Import source grant is invalid');
      }
      return {
        grantId: prepared.grant_id,
        request: {
          ...request,
          source: { storage_session_id: file.storage_session_id, id: file.id },
          egressGrant: prepared.egressGrantToken,
        },
      };
    },
    revoke: options.revokeGrant,
  };
}
