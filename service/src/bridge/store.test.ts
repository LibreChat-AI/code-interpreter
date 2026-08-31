import { afterEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type * as t from '../types';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis);
const incarnationId = 'incarnation-00000001';

afterEach(async () => {
  await redis.flushall();
});

describe('RedisBridgeStore', () => {
  test('delivers and settles one fenced stateful assignment', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId,
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
    const assignment = await store.lease('vm-1', incarnationId, 1_000);
    expect(assignment).toBeDefined();
    expect(assignment?.runtimeSessionId).toBe('rt-user-1');

    await store.settle('vm-1', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
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
      incarnationId,
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
    const assignment = await store.lease('vm-1', incarnationId, 1_000);

    await expect(
      store.settle('vm-1', assignment?.assignmentId ?? '', {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: 'stale-token-that-is-long-enough-to-pass-validation',
        incarnationId,
        status: 'rejected',
        error: 'unused',
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('fences a replaced worker incarnation', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000002',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });

    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'vm-1',
        incarnationId,
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_FENCED' });
  });

  test('a stale incarnation poll cannot consume replacement work', async () => {
    const replacementIncarnationId = 'incarnation-00000002';
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'restarted-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const stalePoll = store.lease('restarted-worker', incarnationId, 100);
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'restarted-worker',
      incarnationId: replacementIncarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'restarted-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });

    await expect(stalePoll).resolves.toBeUndefined();
    await expect(
      store.lease('restarted-worker', replacementIncarnationId, 1_000),
    ).resolves.toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('keeps assignment state through deadlines longer than ten minutes', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'long-running-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'long-running-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 15 * 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [assignmentKey] = await redis.keys('codeapi:bridge:v1:assignment:*');

    expect(await redis.ttl(assignmentKey)).toBeGreaterThan(10 * 60);
    expect(
      await redis.pttl('codeapi:bridge:v1:worker:long-running-worker:lock'),
    ).toBeGreaterThan(10 * 60_000);
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('releases the worker lock when generation allocation fails', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const originalIncr = redis.incr.bind(redis);
    let failOnce = true;
    redis.incr = (async (...args: Parameters<Redis['incr']>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('incr failed');
      }
      return originalIncr(...args);
    }) as Redis['incr'];
    const controller = new AbortController();
    await expect(
      store.dispatch({
        workerId: 'vm-1',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        deadlineAtMs: Date.now() + 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('incr failed');
    redis.incr = originalIncr as Redis['incr'];

    const completion = store.dispatch({
      workerId: 'vm-1',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 1_000,
      signal: controller.signal,
    });
    const assignment = await store.lease('vm-1', incarnationId, 500);
    expect(assignment).toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('quarantines a workspace when result finalization fails', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId,
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
      runtimeSessionId: 'rt-user-1',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
      finalize: async () => {
        await expect(
          store.dispatch({
            workerId: 'vm-1',
            body: { language: 'bash' } as t.PayloadBody,
            headers: {},
            runtimeSessionId: 'rt-user-1',
            deadlineAtMs: Date.now() + 1_000,
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ code: 'WORKER_BUSY' });
        throw new Error('restore failed');
      },
    });
    const assignment = await store.lease('vm-1', incarnationId, 1_000);
    await store.settle('vm-1', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
      status: 'fulfilled',
      result: {
        language: 'bash',
        version: '5.2.0',
        session_id: 'run-1',
        files: [],
      },
    });

    await expect(completion).rejects.toThrow('restore failed');
    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'vm-1',
        incarnationId,
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_QUARANTINED' });

    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000002',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    await expect(
      store.dispatch({
        workerId: 'vm-1',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        runtimeSessionId: 'rt-user-1',
        deadlineAtMs: Date.now() + 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_QUARANTINED' });
  });
});
