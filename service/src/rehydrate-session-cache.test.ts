import { describe, expect, it } from 'bun:test';
import {
  parseOptions,
  parseRecoveryManifest,
  recoverSessionCache,
  RecoveryInterruptedError,
  type RecoverySource,
  type RecoveryStore,
} from '../scripts/rehydrate-session-cache';

const SESSION_ID = 'ABCDEFGHIJKLMNOPQRSTU';
const OTHER_SESSION_ID = 'ZYXWVUTSRQPONMLKJIHGF';
const SESSION_KEY = 'example-tenant:user:example-user';
const SCOPE = {
  environment: 'example',
  region: 'region-1',
  namespace: 'codeapi',
};
const SOURCE = {
  type: 'source',
  ...SCOPE,
  query_start_utc: '2026-01-01T00:00:00Z',
  query_end_utc: '2026-01-02T00:00:00Z',
} as const satisfies RecoverySource;

class MemoryStore implements RecoveryStore {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _expiryMode: 'EX',
    ttlSeconds: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    if (this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    this.ttls.set(key, ttlSeconds);
    return 'OK';
  }

  async ttl(key: string): Promise<number> {
    if (!this.values.has(key)) {
      return -2;
    }
    return this.ttls.get(key) ?? -1;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    if (!this.values.has(key)) {
      return 0;
    }
    this.ttls.set(key, ttlSeconds);
    return 1;
  }

  async del(key: string): Promise<number> {
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
}

/** Loses every `SET NX` on the durable owner key, optionally planting a
 *  different owner for the follow-up read to find. */
class RacingOwnerStore extends MemoryStore {
  constructor(private readonly ownerAfterRace: string | null) {
    super();
  }

  async set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null> {
    if (!key.startsWith('session-owner:')) {
      return super.set(key, value, expiryMode, ttlSeconds, condition);
    }
    if (this.ownerAfterRace !== null) {
      this.values.set(key, this.ownerAfterRace);
    }
    return null;
  }
}

describe('rehydrate-session-cache', () => {
  it('parses, validates, and deduplicates JSONL records', () => {
    const input = [
      '# trusted recovery source',
      JSON.stringify(SOURCE),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: SESSION_KEY }),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: SESSION_KEY }),
      '',
    ].join('\n');

    expect(parseRecoveryManifest(input, SCOPE)).toEqual({
      source: SOURCE,
      records: [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
    });
  });

  it('rejects a manifest outside the configured recovery scope', () => {
    const input = [
      JSON.stringify(SOURCE),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: SESSION_KEY }),
    ].join('\n');

    expect(() => parseRecoveryManifest(input, { ...SCOPE, region: 'region-2' })).toThrow(
      'Recovery source must match example/region-2/codeapi',
    );
  });

  it('rejects invalid recovery context values', () => {
    expect(() => parseOptions([
      '--environment', 'example',
      '--region', 'region with spaces',
      '--namespace', 'codeapi',
    ], {})).toThrow('Recovery region');
  });

  it('rejects conflicting owners before connecting to Redis', () => {
    const input = [
      JSON.stringify(SOURCE),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: SESSION_KEY }),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: 'tenant-id:user:other' }),
    ].join('\n');

    expect(() => parseRecoveryManifest(input, SCOPE)).toThrow('conflicting owners');
  });

  it('accepts a composite session key longer than one resource id', () => {
    const longSessionKey = `${'t'.repeat(128)}:skill:${'s'.repeat(128)}:v:1`;
    const input = [
      JSON.stringify(SOURCE),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: longSessionKey }),
    ].join('\n');

    expect(parseRecoveryManifest(input, SCOPE).records).toEqual([
      { session_id: SESSION_ID, expected_session_key: longSessionKey },
    ]);
  });

  it('accepts session keys containing identity punctuation and Unicode', () => {
    const emittedSessionKey = 'tenant+東京@example.com/user:user+東京@example.com';
    const input = [
      JSON.stringify(SOURCE),
      JSON.stringify({ session_id: SESSION_ID, expected_session_key: emittedSessionKey }),
    ].join('\n');

    expect(parseRecoveryManifest(input, SCOPE).records).toEqual([
      { session_id: SESSION_ID, expected_session_key: emittedSessionKey },
    ]);
  });

  it('rejects empty session keys and control characters', () => {
    for (const expectedSessionKey of ['', 'tenant:user:user\nid']) {
      const input = [
        JSON.stringify(SOURCE),
        JSON.stringify({ session_id: SESSION_ID, expected_session_key: expectedSessionKey }),
      ].join('\n');

      expect(() => parseRecoveryManifest(input, SCOPE)).toThrow(
        'must contain a valid session_id and expected_session_key',
      );
    }
  });

  it('accepts recovery scope from arguments or configuration', () => {
    expect(parseOptions([
      '--environment', 'argument-env',
      '--region', 'argument-region',
      '--namespace', 'argument-namespace',
      '--ttl-seconds', '7200',
    ], {})).toMatchObject({
      environment: 'argument-env',
      region: 'argument-region',
      namespace: 'argument-namespace',
      ttlSeconds: 7200,
    });
    expect(parseOptions([], {
      SESSION_RECOVERY_ENVIRONMENT: 'configured-env',
      SESSION_RECOVERY_REGION: 'configured-region',
      SESSION_RECOVERY_NAMESPACE: 'configured-namespace',
      SESSION_CACHE_TTL: '86400',
    })).toMatchObject({
      environment: 'configured-env',
      region: 'configured-region',
      namespace: 'configured-namespace',
      ttlSeconds: 86400,
    });
  });

  it('requires the recovery scope', () => {
    expect(() => parseOptions([], {})).toThrow('Recovery environment');
  });

  it('defaults the owner TTL past the cache TTL and never below it', () => {
    expect(parseOptions([], {
      SESSION_RECOVERY_ENVIRONMENT: 'configured-env',
      SESSION_RECOVERY_REGION: 'configured-region',
      SESSION_RECOVERY_NAMESPACE: 'configured-namespace',
    })).toMatchObject({ ttlSeconds: 86400, ownerTtlSeconds: 90 * 86400 });

    expect(parseOptions(['--owner-ttl-seconds', '604800'], {
      SESSION_RECOVERY_ENVIRONMENT: 'configured-env',
      SESSION_RECOVERY_REGION: 'configured-region',
      SESSION_RECOVERY_NAMESPACE: 'configured-namespace',
    })).toMatchObject({ ownerTtlSeconds: 604800 });

    /* A shorter owner TTL would re-strand the session it just recovered. */
    expect(parseOptions([
      '--ttl-seconds', '86400',
      '--owner-ttl-seconds', '600',
    ], {
      SESSION_RECOVERY_ENVIRONMENT: 'configured-env',
      SESSION_RECOVERY_REGION: 'configured-region',
      SESSION_RECOVERY_NAMESPACE: 'configured-namespace',
    })).toMatchObject({ ttlSeconds: 86400, ownerTtlSeconds: 86400 });
  });

  it('restores the durable owner record alongside the cache key', async () => {
    const store = new MemoryStore();

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toMatchObject({ restored: 1, conflicts: 0 });
    expect(store.values.get(`session:${SESSION_ID}`)).toBe(SESSION_KEY);
    expect(store.ttls.get(`session:${SESSION_ID}`)).toBe(86400);
    expect(store.values.get(`session-owner:${SESSION_ID}`)).toBe(SESSION_KEY);
    expect(store.ttls.get(`session-owner:${SESSION_ID}`)).toBe(7776000);
  });

  it('backfills the owner record for a session whose cache key is still live', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toMatchObject({ matching: 1, restored: 0, conflicts: 0 });
    expect(store.values.get(`session-owner:${SESSION_ID}`)).toBe(SESSION_KEY);
  });

  it('reports a conflicting owner record and restores nothing for that session', async () => {
    const store = new MemoryStore();
    store.values.set(`session-owner:${SESSION_ID}`, 'tenant-id:user:someone-else');

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 0, conflicts: 1 });
    expect(store.values.get(`session-owner:${SESSION_ID}`)).toBe('tenant-id:user:someone-else');
    /* The manifest's claimant must not get a day of access the service
     * never granted it. */
    expect(store.values.has(`session:${SESSION_ID}`)).toBe(false);
  });

  it('creates no durable owner record when the live cache key names another owner', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, 'tenant-id:user:someone-else');

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 0, conflicts: 1 });
    /* A durable record written here would outlive the cache key that
     * contradicts it, and `sessionAuth` would then authorize the manifest
     * owner to delete the real owner's files. */
    expect(store.values.has(`session-owner:${SESSION_ID}`)).toBe(false);
  });

  it('rolls back a restored cache key when the owner record turns out to be another owner', async () => {
    const store = new RacingOwnerStore('tenant-id:user:someone-else');

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 0, conflicts: 1 });
    /* Left in place, the grant would authorize the manifest owner for a
     * full ttlSeconds against a session the durable record says is not
     * theirs. */
    expect(store.values.has(`session:${SESSION_ID}`)).toBe(false);
  });

  it('reports an owner record that cannot be created as missing', async () => {
    const store = new RacingOwnerStore(null);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    /* `missing` during an apply is what drives the nonzero exit — the run
     * must not look like a completed recovery. */
    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
    expect(store.values.has(`session-owner:${SESSION_ID}`)).toBe(false);
    /* The cache key stays: no durable record is where this session already
     * was, and removing it would leave the operator with nothing. */
    expect(store.values.get(`session:${SESSION_ID}`)).toBe(SESSION_KEY);
  });

  it('reports pending owner work during a dry run', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: false, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    /* Counting this as `matching` would tell an operator the session is
     * fully in place and invite them to skip the apply that creates its
     * durable record. */
    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
    expect(store.values.has(`session-owner:${SESSION_ID}`)).toBe(false);
  });

  it('reports a short-lived owner record as pending work during a dry run', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 600);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: false, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
    expect(store.ttls.get(`session-owner:${SESSION_ID}`)).toBe(600);
  });

  it('counts a fully in-place session as matching during a dry run', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 7776000);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: false, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 1, conflicts: 0 });
  });

  it('creates the owner record when it expires between inspection and refresh', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 600);
    const realTtl = store.ttl.bind(store);
    let ttlReads = 0;
    store.ttl = async (key: string): Promise<number> => {
      ttlReads += 1;
      if (ttlReads === 1) {
        /* Lapses in the window between the inspection read and the
         * extension it was about to perform. */
        store.values.delete(`session-owner:${SESSION_ID}`);
        store.ttls.delete(`session-owner:${SESSION_ID}`);
        return -2;
      }
      return realTtl(key);
    };

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 1, conflicts: 0 });
    expect(store.values.get(`session-owner:${SESSION_ID}`)).toBe(SESSION_KEY);
    expect(store.ttls.get(`session-owner:${SESSION_ID}`)).toBe(7776000);
  });

  it('reports an owner record replaced during the refresh as a conflict', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${SESSION_ID}`, SESSION_KEY);
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 600);
    const realExpire = store.expire.bind(store);
    store.expire = async (key: string, ttlSeconds: number): Promise<number> => {
      const result = await realExpire(key, ttlSeconds);
      store.values.set(`session-owner:${SESSION_ID}`, 'tenant-id:user:someone-else');
      return result;
    };

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    /* The extension itself is harmless — it prolongs a claim the service
     * wrote — but the session must not be reported as recovered. */
    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 0, conflicts: 1 });
  });

  it('surfaces a conflicting owner record during a dry run', async () => {
    const store = new MemoryStore();
    store.values.set(`session-owner:${SESSION_ID}`, 'tenant-id:user:someone-else');

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: false, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toEqual({ input: 1, missing: 0, restored: 0, matching: 0, conflicts: 1 });
    expect(store.values.size).toBe(1);
  });

  it('extends a matching owner record that would expire before the restored cache key', async () => {
    const store = new MemoryStore();
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 600);

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(summary).toMatchObject({ restored: 1, conflicts: 0 });
    expect(store.ttls.get(`session-owner:${SESSION_ID}`)).toBe(7776000);
  });

  it('leaves a longer-lived owner record alone', async () => {
    const store = new MemoryStore();
    store.values.set(`session-owner:${SESSION_ID}`, SESSION_KEY);
    store.ttls.set(`session-owner:${SESSION_ID}`, 9999999);

    await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400, ownerTtlSeconds: 7776000 },
    );

    expect(store.ttls.get(`session-owner:${SESSION_ID}`)).toBe(9999999);
  });

  it('does not write during a dry run', async () => {
    const store = new MemoryStore();
    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: false, ttlSeconds: 86400 },
    );

    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
    expect(store.values.size).toBe(0);
  });

  it('restores only absent keys and reports existing owners', async () => {
    const store = new MemoryStore();
    store.values.set(`session:${OTHER_SESSION_ID}`, 'tenant-id:user:someone-else');

    const summary = await recoverSessionCache(
      [
        { session_id: SESSION_ID, expected_session_key: SESSION_KEY },
        { session_id: OTHER_SESSION_ID, expected_session_key: SESSION_KEY },
      ],
      store,
      { apply: true, ttlSeconds: 86400 },
    );

    expect(summary).toEqual({ input: 2, missing: 0, restored: 1, matching: 0, conflicts: 1 });
    expect(store.values.get(`session:${SESSION_ID}`)).toBe(SESSION_KEY);
    expect(store.values.get(`session:${OTHER_SESSION_ID}`)).toBe('tenant-id:user:someone-else');
  });

  it('preserves partial counts when a Redis operation fails', async () => {
    let reads = 0;
    const store: RecoveryStore = {
      /* Three reads to settle the first record: the durable owner, the
       * cache key, then the owner re-read that confirms the refresh. The
       * second record fails on its first read. */
      async get(): Promise<string | null> {
        reads += 1;
        if (reads <= 3) {
          return SESSION_KEY;
        }
        throw new Error('Redis unavailable');
      },
      async set(): Promise<'OK' | null> {
        throw new Error('unexpected set');
      },
      async ttl(): Promise<number> {
        return 7776000;
      },
      async expire(): Promise<number> {
        throw new Error('unexpected expire');
      },
      async del(): Promise<number> {
        throw new Error('unexpected del');
      },
    };

    try {
      await recoverSessionCache(
        [
          { session_id: SESSION_ID, expected_session_key: SESSION_KEY },
          { session_id: OTHER_SESSION_ID, expected_session_key: SESSION_KEY },
        ],
        store,
        { apply: true, ttlSeconds: 86400 },
      );
      throw new Error('expected recovery to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryInterruptedError);
      expect((error as RecoveryInterruptedError).summary).toEqual({
        input: 2,
        missing: 0,
        restored: 0,
        matching: 1,
        conflicts: 0,
      });
    }
  });

  it('reports a key that disappears during an apply race as missing', async () => {
    const store: RecoveryStore = {
      async get(): Promise<null> {
        return null;
      },
      async set(): Promise<null> {
        return null;
      },
      async ttl(): Promise<number> {
        return -2;
      },
      async expire(): Promise<number> {
        return 0;
      },
      async del(): Promise<number> {
        return 0;
      },
    };

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400 },
    );

    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
  });
});
