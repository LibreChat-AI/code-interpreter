import { env } from './config';

/**
 * Ownership of a session's stored objects is recorded twice.
 *
 * `session:<session_id>` is the hot path: `sessionAuth` compares it on
 * every download, metadata fetch and execution input, and its
 * `SESSION_CACHE_TTL` (24h by default) is deliberately short — it bounds
 * how long a sandbox invocation's outputs stay reachable.
 *
 * That bound is wrong for deletion. A file is deletable only while
 * someone can still prove they own it, so with one key the window in
 * which an object can be removed closes a day after upload and the
 * object is stranded for the life of the deployment: unreadable,
 * unusable as an execution input, and undeletable through every route.
 * Clients sweeping their own retention window are typically far outside
 * 24h when they get there (LibreChat's default retention is 30 days), so
 * in practice every swept object failed to delete and the bucket only
 * ever grew.
 *
 * `session-owner:<session_id>` is the durable half: same value, TTL
 * `SESSION_OWNER_TTL`, consulted only when the cache key has expired and
 * only for deletes. Read access keeps the original 24h bound.
 */

/** The subset of the Redis client these helpers need — narrow enough to
 *  fake in tests without standing up a connection. */
export interface SessionOwnershipStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export const sessionCacheKey = (session_id: string): string => `session:${session_id}`;
export const sessionOwnerKey = (session_id: string): string => `session-owner:${session_id}`;

export interface SessionOwnershipTtls {
  cacheTtl?: number;
  ownerTtl?: number;
}

/**
 * Register `sessionKey` as the owner of `session_id`, writing both the
 * cache key and the durable owner record. Replaces the bare
 * `connection.set('session:…')` at every site that opens a session, so
 * the two can never drift apart.
 */
export function recordSessionOwnership(
  store: SessionOwnershipStore,
  session_id: string,
  sessionKey: string,
  ttls: SessionOwnershipTtls = {},
): Promise<unknown> {
  const cacheTtl = ttls.cacheTtl ?? env.SESSION_CACHE_TTL;
  const ownerTtl = ttls.ownerTtl ?? env.SESSION_OWNER_TTL;
  return Promise.all([
    store.set(sessionCacheKey(session_id), sessionKey, 'EX', cacheTtl),
    store.set(sessionOwnerKey(session_id), sessionKey, 'EX', ownerTtl),
  ]);
}

/**
 * Roll back a registration, dropping both records. Used where a request
 * is rejected after opening a session — leaving the durable half behind
 * would keep an owner record alive for `SESSION_OWNER_TTL` on a session
 * that never stored anything.
 */
export function clearSessionOwnership(
  store: SessionOwnershipStore,
  session_id: string,
): Promise<unknown> {
  return store.del(sessionCacheKey(session_id), sessionOwnerKey(session_id));
}

export type SessionOwnershipSource = 'session' | 'owner';

/** `expired`: nothing live, and the durable record was not consulted or
 *  had also lapsed. `unknown`: the session predates the owner record, so
 *  ownership can no longer be established (recoverable with
 *  `scripts/rehydrate-session-cache.ts`). `mismatch`: a recorded owner
 *  exists and it is somebody else. */
export type SessionOwnershipDenial = 'expired' | 'unknown' | 'mismatch';

export type SessionOwnershipResult =
  | { authorized: true; source: SessionOwnershipSource }
  | { authorized: false; reason: SessionOwnershipDenial; cachedSessionKey: string | null };

/**
 * Decide whether `expectedSessionKey` owns `session_id`.
 *
 * A live cache key is always authoritative — when one exists and names a
 * different owner the answer is no, and the durable record is not
 * consulted. The fallback only covers the case where the cache key is
 * simply gone.
 */
export async function authorizeSessionOwnership(
  store: SessionOwnershipStore,
  args: {
    session_id: string;
    expectedSessionKey: string;
    /** Enable the durable fallback. Deletes pass true; reads keep the
     *  `SESSION_CACHE_TTL` window they have always had. */
    allowExpiredCache: boolean;
  },
): Promise<SessionOwnershipResult> {
  const { session_id, expectedSessionKey, allowExpiredCache } = args;
  const cachedSessionKey = await store.get(sessionCacheKey(session_id));
  if (cachedSessionKey === expectedSessionKey) {
    return { authorized: true, source: 'session' };
  }
  if (cachedSessionKey !== null) {
    return { authorized: false, reason: 'mismatch', cachedSessionKey };
  }
  if (!allowExpiredCache) {
    return { authorized: false, reason: 'expired', cachedSessionKey };
  }

  const recordedOwner = await store.get(sessionOwnerKey(session_id));
  if (recordedOwner === expectedSessionKey) {
    return { authorized: true, source: 'owner' };
  }
  if (recordedOwner === null) {
    return { authorized: false, reason: 'unknown', cachedSessionKey };
  }
  return { authorized: false, reason: 'mismatch', cachedSessionKey: recordedOwner };
}
