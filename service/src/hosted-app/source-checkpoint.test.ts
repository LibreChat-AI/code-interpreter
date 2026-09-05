import { describe, expect, test } from 'bun:test';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import { captureHostedAppSourceCheckpoint } from './source-checkpoint';

const owner = { tenantId: 'tenant-1', canonicalUserId: 'user-1' };

function record(state: RuntimeSessionRecord['state']): RuntimeSessionRecord {
  return {
    runtime_session_id: 'rt_source',
    tenant_id: owner.tenantId,
    canonical_user_id: owner.canonicalUserId,
    state,
    generation: 1,
    launched_at: 1,
    last_seen_at: 1,
    workspace_checkpoint: 'rtsx-checkpoints/rt_source/0001.tar.gz',
    ...(state === 'RUNNING'
      ? { microvm_id: 'vm-source', endpoint: 'https://vm-source.test' }
      : {}),
  };
}

function fixture(source: RuntimeSessionRecord | null) {
  let current = source;
  const calls: string[] = [];
  return {
    calls,
    deps: {
      waitForLock: async () => { calls.push('lock'); return 'source-lock'; },
      releaseLock: async () => { calls.push('release'); },
      read: async () => { calls.push('read'); return current; },
      checkpoint: async () => {
        calls.push('checkpoint');
        current = current ? {
          ...current,
          workspace_checkpoint: 'rtsx-checkpoints/rt_source/0002.tar.gz',
        } : null;
        return 'stored' as const;
      },
    },
  };
}

describe('hosted app source checkpoint capture', () => {
  test('holds one lock across a fresh live checkpoint and its committed pointer read', async () => {
    const f = fixture(record('RUNNING'));
    const key = await captureHostedAppSourceCheckpoint({
      runtimeSessionId: 'rt_source', owner, signal: new AbortController().signal,
      lockWaitMs: 100, deps: f.deps,
    });
    expect(key).toBe('rtsx-checkpoints/rt_source/0002.tar.gz');
    expect(f.calls).toEqual(['lock', 'read', 'checkpoint', 'read', 'release']);
  });

  test('reuses a stopped workspace checkpoint without requiring a live source VM', async () => {
    const f = fixture(record('TERMINATED'));
    const key = await captureHostedAppSourceCheckpoint({
      runtimeSessionId: 'rt_source', owner, signal: new AbortController().signal,
      lockWaitMs: 100, deps: f.deps,
    });
    expect(key).toBe('rtsx-checkpoints/rt_source/0001.tar.gz');
    expect(f.calls).toEqual(['lock', 'read', 'release']);
  });

  test('fails closed on owner mismatch and still releases the source lock', async () => {
    const f = fixture({ ...record('TERMINATED'), canonical_user_id: 'user-2' });
    const error = await captureHostedAppSourceCheckpoint({
      runtimeSessionId: 'rt_source', owner, signal: new AbortController().signal,
      lockWaitMs: 100, deps: f.deps,
    }).catch(value => value);
    expect(error.code).toBe('hosted_app_source_not_found');
    expect(f.calls).toEqual(['lock', 'read', 'release']);
  });
});
