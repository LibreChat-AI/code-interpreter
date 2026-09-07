import { describe, expect, test } from 'bun:test';

import {
  authorizeSessionOwnership,
  clearSessionOwnership,
  recordSessionOwnership,
  sessionCacheKey,
  sessionOwnerKey,
  type SessionOwnershipStore,
} from './session-ownership';

interface Written {
  value: string;
  ttl: number;
}

function createStore(seed: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  const writes: Record<string, Written> = {};
  const store: SessionOwnershipStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, _expiryMode, ttlSeconds) => {
      values.set(key, value);
      writes[key] = { value, ttl: ttlSeconds };
      return 'OK';
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) {
        if (values.delete(key)) removed += 1;
      }
      return removed;
    },
  };
  return { store, writes, values };
}

const SESSION_ID = 'session-1';
const OWNER = 'tenant-1:user:user-1';

describe('recordSessionOwnership', () => {
  test('writes the cache key and the durable owner record together', async () => {
    const { store, writes } = createStore();

    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 100, ownerTtl: 9000 });

    expect(writes[sessionCacheKey(SESSION_ID)]).toEqual({ value: OWNER, ttl: 100 });
    expect(writes[sessionOwnerKey(SESSION_ID)]).toEqual({ value: OWNER, ttl: 9000 });
  });
});

describe('clearSessionOwnership', () => {
  test('rolls back both records', async () => {
    const { store, values } = createStore();
    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 100, ownerTtl: 9000 });

    await clearSessionOwnership(store, SESSION_ID);

    expect(values.has(sessionCacheKey(SESSION_ID))).toBe(false);
    expect(values.has(sessionOwnerKey(SESSION_ID))).toBe(false);
  });
});

describe('authorizeSessionOwnership', () => {
  test('authorizes from the cache key while it is live', async () => {
    const { store } = createStore({ [sessionCacheKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: false,
    });

    expect(result).toEqual({ authorized: true, source: 'session' });
  });

  test('denies a read once the cache key has expired, even with an owner record', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: false,
    });

    expect(result).toEqual({ authorized: false, reason: 'expired', cachedSessionKey: null });
  });

  test('authorizes a delete from the owner record once the cache key has expired', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({ authorized: true, source: 'owner' });
  });

  test('a live cache key naming another owner is authoritative and blocks the fallback', async () => {
    const { store } = createStore({
      [sessionCacheKey(SESSION_ID)]: 'tenant-1:user:someone-else',
      /* Stale owner record that would otherwise match — a re-registered
       * session must not be deletable by its previous owner. */
      [sessionOwnerKey(SESSION_ID)]: OWNER,
    });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({
      authorized: false,
      reason: 'mismatch',
      cachedSessionKey: 'tenant-1:user:someone-else',
    });
  });

  test('denies a delete when the owner record names someone else', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: 'tenant-2:user:user-2' });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({
      authorized: false,
      reason: 'mismatch',
      cachedSessionKey: 'tenant-2:user:user-2',
    });
  });

  test('reports sessions that predate the owner record as unknown', async () => {
    const { store } = createStore();

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({ authorized: false, reason: 'unknown', cachedSessionKey: null });
  });

  test('a session registered through recordSessionOwnership stays deletable past the cache TTL', async () => {
    const { store, values } = createStore();
    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 1, ownerTtl: 9000 });

    /* Simulate the cache key aging out while the owner record lives on. */
    values.delete(sessionCacheKey(SESSION_ID));

    expect(
      await authorizeSessionOwnership(store, {
        session_id: SESSION_ID,
        expectedSessionKey: OWNER,
        allowExpiredCache: true,
      }),
    ).toEqual({ authorized: true, source: 'owner' });
  });
});
