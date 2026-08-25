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

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _expiryMode: 'EX',
    _ttlSeconds: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    if (this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return 'OK';
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
      async get(): Promise<string | null> {
        reads += 1;
        if (reads === 1) {
          return SESSION_KEY;
        }
        throw new Error('Redis unavailable');
      },
      async set(): Promise<'OK' | null> {
        throw new Error('unexpected set');
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
    };

    const summary = await recoverSessionCache(
      [{ session_id: SESSION_ID, expected_session_key: SESSION_KEY }],
      store,
      { apply: true, ttlSeconds: 86400 },
    );

    expect(summary).toEqual({ input: 1, missing: 1, restored: 0, matching: 0, conflicts: 0 });
  });
});
