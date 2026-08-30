import { afterEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type * as t from '../types';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis);

afterEach(async () => {
  await redis.flushall();
});

describe('RedisBridgeStore', () => {
  test('delivers and settles one fenced stateful assignment', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'vm-1',
      body: { language: 'bash' } as t.PayloadBody,
      headers: { 'X-Execution-Manifest': 'signed' },
      runtimeSessionId: 'rt-user-1',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease('vm-1', 1_000);
    expect(assignment).toBeDefined();
    expect(assignment?.runtimeSessionId).toBe('rt-user-1');

    await store.settle('vm-1', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      status: 'fulfilled',
      result: {
        language: 'bash',
        version: '5.2.0',
        session_id: 'run-1',
        files: [],
      },
    });

    await expect(completion).resolves.toMatchObject({
      status: 'fulfilled',
      result: { session_id: 'run-1' },
    });
  });

  test('rejects dispatch to an offline worker', async () => {
    const controller = new AbortController();
    await expect(
      store.dispatch({
        workerId: 'offline',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        deadlineAtMs: Date.now() + 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_OFFLINE' });
  });

  test('rejects a stale lease token', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'vm-1',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease('vm-1', 1_000);

    await expect(
      store.settle('vm-1', assignment?.assignmentId ?? '', {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: 'stale-token-that-is-long-enough-to-pass-validation',
        status: 'rejected',
        error: 'unused',
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });
});
