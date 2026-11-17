import { sessionCacheKey } from './session-ownership';

/**
 * The file server's half of upload authorization.
 *
 * The API registers `session:<session_id>` before it forwards any bytes, and
 * later authorizes a download, an execution input or a workspace import only
 * when `upload:<sessionKey><session_id><fileId>` exists under that same
 * session key. The file server writes that record, so it has to read the
 * session from the Redis the API wrote it to.
 *
 * A session this file server cannot see therefore has no usable record to
 * write: the only key available is `upload:null…`, which no reader ever asks
 * for. The object would be stored and stay unreachable through every route,
 * with nothing reporting a failure. Refusing the upload instead surfaces the
 * fault to the caller at the moment it happens.
 */

/** The Redis commands these helpers need. */
export interface UploadRecordStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export const UPLOAD_SESSION_UNKNOWN = 'UPLOAD_SESSION_UNKNOWN';

export interface UploadSessionUnknownBody {
  error: string;
  code: typeof UPLOAD_SESSION_UNKNOWN;
}

export class UploadSessionUnknownError extends Error {
  readonly status = 409;
  readonly code = UPLOAD_SESSION_UNKNOWN;

  constructor(readonly session_id: string) {
    super(
      'Refusing upload: its session is not registered in this file server\'s Redis. ' +
      'The API that opened the session must use the same Redis as this file server ' +
      '(REDIS_HOST/REDIS_PORT); a session older than SESSION_CACHE_TTL is the other cause.',
    );
    this.name = 'UploadSessionUnknownError';
  }

  /** What the caller is told. The operator-facing cause stays in the log. */
  get body(): UploadSessionUnknownBody {
    return { error: 'Upload session is not registered with this file server', code: this.code };
  }
}

export const uploadRecordKey = (sessionKey: string, session_id: string, fileId: string): string =>
  `upload:${sessionKey}${session_id}${fileId}`;

/** The session key the API registered for `session_id`; throws when this store has none. */
export async function resolveUploadSessionKey(
  store: Pick<UploadRecordStore, 'get'>,
  session_id: string,
): Promise<string> {
  const sessionKey = await store.get(sessionCacheKey(session_id));
  if (sessionKey == null || sessionKey === '') throw new UploadSessionUnknownError(session_id);
  return sessionKey;
}

export function recordUpload(
  store: Pick<UploadRecordStore, 'set'>,
  upload: { sessionKey: string; session_id: string; fileId: string },
  ttlSeconds: number,
): Promise<unknown> {
  return store.set(
    uploadRecordKey(upload.sessionKey, upload.session_id, upload.fileId),
    'true',
    'EX',
    ttlSeconds,
  );
}
