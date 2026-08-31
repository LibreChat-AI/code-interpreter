import { afterEach, describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type * as t from '../types';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis);
const incarnationId = 'incarnation-00000001';
const redisEval = redis.eval.bind(redis);
const redisDel = redis.del.bind(redis);
const redisLpop = redis.lpop.bind(redis);
const redisGet = redis.get.bind(redis);

afterEach(async () => {
  redis.eval = redisEval as Redis['eval'];
  redis.del = redisDel as Redis['del'];
  redis.lpop = redisLpop as Redis['lpop'];
  redis.get = redisGet as Redis['get'];
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
    expect(assignment?.remainingMs).toBeGreaterThan(0);
    expect(assignment?.remainingMs).toBeLessThanOrEqual(5_000);

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

  test('does not fence a workspace when dispatch is already aborted', async () => {
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
    controller.abort();
    await expect(
      store.dispatch({
        workerId: 'vm-1',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        runtimeSessionId: 'rt-aborted',
        deadlineAtMs: Date.now() + 5_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:vm-1:workspace:*:quarantined',
      ),
    ).toHaveLength(0);
  });

  test('does not fence a workspace when dispatch aborts during lock acquisition', async () => {
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
    redis.eval = (async (...args: Parameters<Redis['eval']>) => {
      const result = await redisEval(...args);
      if (String(args[0]).includes("EXISTS', KEYS[1]) == 1")) {
        controller.abort();
      }
      return result;
    }) as Redis['eval'];

    await expect(
      store.dispatch({
        workerId: 'vm-1',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        runtimeSessionId: 'rt-aborted-lock',
        deadlineAtMs: Date.now() + 5_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:vm-1:workspace:*:quarantined',
      ),
    ).toHaveLength(0);
    expect(await redis.exists('codeapi:bridge:v1:worker:vm-1:lock')).toBe(0);
  });

  test('clears a workspace fence when a queued assignment expires undelivered', async () => {
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
      runtimeSessionId: 'rt-expired-queue',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queue =
      'codeapi:bridge:v1:worker:vm-1:incarnation:' +
      `${incarnationId}:assignments`;
    const assignmentId = await redis.lindex(queue, 0);
    const assignmentKey = `codeapi:bridge:v1:assignment:${assignmentId}`;
    const rawAssignment = await redis.get(assignmentKey);
    const assignment = JSON.parse(rawAssignment ?? '{}') as Record<
      string,
      unknown
    >;
    assignment.expiresAt = new Date(0).toISOString();
    await redis.set(assignmentKey, JSON.stringify(assignment), 'EX', 30);

    await expect(
      store.lease('vm-1', incarnationId, 100),
    ).resolves.toBeUndefined();
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:vm-1:workspace:*:quarantined',
      ),
    ).toHaveLength(0);
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('returns a popped assignment when its lease request is aborted', async () => {
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
    const dispatchController = new AbortController();
    const completion = store.dispatch({
      workerId: 'vm-1',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: dispatchController.signal,
    });
    const leaseController = new AbortController();
    redis.lpop = (async (...args: Parameters<Redis['lpop']>) => {
      const assignmentId = await redisLpop(...args);
      if (assignmentId != null) leaseController.abort();
      return assignmentId;
    }) as Redis['lpop'];

    await expect(
      store.lease('vm-1', incarnationId, 1_000, leaseController.signal),
    ).resolves.toBeUndefined();
    redis.lpop = redisLpop as Redis['lpop'];

    const recovered = await store.lease('vm-1', incarnationId, 1_000);
    expect(recovered).toBeDefined();
    expect(recovered?.workerId).toBe('vm-1');
    dispatchController.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('returns a popped assignment after a transient Redis read failure', async () => {
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
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'vm-1',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    let failAssignmentRead = true;
    redis.get = (async (key: string) => {
      if (
        failAssignmentRead &&
        key.includes(':assignment:') &&
        !key.endsWith(':settlement')
      ) {
        failAssignmentRead = false;
        throw new Error('redis read failed');
      }
      return await redisGet(key);
    }) as Redis['get'];

    await expect(store.lease('vm-1', incarnationId, 1_000)).rejects.toThrow(
      'redis read failed',
    );
    redis.get = redisGet as Redis['get'];
    const recovered = await store.lease('vm-1', incarnationId, 1_000);
    expect(recovered).toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
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

  test('dispatch retries atomically against a replacement incarnation', async () => {
    const workerId = 'racing-worker';
    const replacementIncarnationId = 'incarnation-00000002';
    const capabilities = {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: [] as string[],
    };
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId,
      incarnationId,
      capabilities,
    });
    const originalEval = redis.eval.bind(redis);
    let replaced = false;
    redis.eval = (async (...args: Parameters<Redis['eval']>) => {
      if (!replaced && String(args[0]).includes("redis.call('RPUSH'")) {
        replaced = true;
        const replacement = {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          workerId,
          incarnationId: replacementIncarnationId,
          capabilities,
        };
        await redis.set(
          `codeapi:bridge:v1:worker:${workerId}`,
          JSON.stringify(replacement),
          'EX',
          60,
        );
        await redis.set(
          `codeapi:bridge:v1:worker:${workerId}:incarnation`,
          replacementIncarnationId,
          'EX',
          60,
        );
      }
      return originalEval(...args);
    }) as Redis['eval'];
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId,
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });

    const assignment = await store.lease(
      workerId,
      replacementIncarnationId,
      1_000,
    );
    expect(assignment?.incarnationId).toBe(replacementIncarnationId);
    redis.eval = originalEval as Redis['eval'];
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('defers worker replacement while an assignment is active', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'busy-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'busy-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease('busy-worker', incarnationId, 1_000);
    expect(assignment).toBeDefined();

    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'busy-worker',
        incarnationId: 'incarnation-00000002',
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_BUSY' });

    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'busy-worker',
        incarnationId: 'incarnation-00000002',
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).resolves.toBeUndefined();
  });

  test('recovers only the assignment owner after registration expiry', async () => {
    const workerId = 'expired-registration-worker';
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId,
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId,
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(workerId, incarnationId, 1_000);
    expect(assignment).toBeDefined();
    await redis.del(
      `codeapi:bridge:v1:worker:${workerId}`,
      `codeapi:bridge:v1:worker:${workerId}:incarnation`,
    );

    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId,
        incarnationId: 'incarnation-00000002',
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_BUSY' });
    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId,
        incarnationId,
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).resolves.toBeUndefined();

    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('removes abort listeners after each settlement poll delay', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'listener-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'listener-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 350,
      signal: controller.signal,
    });

    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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

  test('observes a settlement accepted during the final poll delay', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'deadline-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + 500;
    const completion = store.dispatch({
      workerId: 'deadline-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-deadline',
      deadlineAtMs,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'deadline-worker',
      incarnationId,
      1_000,
    );
    expect(assignment).toBeDefined();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now() - 30)),
    );
    await store.settle('deadline-worker', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
      status: 'fulfilled',
      result: {
        language: 'bash',
        version: '5.2.0',
        session_id: 'run-deadline',
        files: [],
      },
    });

    await expect(completion).resolves.toMatchObject({
      status: 'fulfilled',
      result: { session_id: 'run-deadline' },
    });
  });

  test('preserves a committed result across transient cleanup failures', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'cleanup-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'cleanup-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-cleanup',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'cleanup-worker',
      incarnationId,
      1_000,
    );
    const originalDel = redis.del.bind(redis);
    let cleanupAttempts = 0;
    redis.del = (async (...args: Parameters<Redis['del']>) => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error('transient cleanup failure');
      return originalDel(...args);
    }) as Redis['del'];
    await store.settle('cleanup-worker', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
      status: 'fulfilled',
      result: {
        language: 'bash',
        version: '5.2.0',
        session_id: 'run-cleanup',
        files: [],
      },
    });

    await expect(completion).resolves.toMatchObject({
      status: 'fulfilled',
      result: { session_id: 'run-cleanup' },
    });
    expect(cleanupAttempts).toBeGreaterThanOrEqual(2);
    redis.del = originalDel as Redis['del'];
  });

  test('holds a durable workspace marker until finalization commits', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'commit-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    let releaseFinalizer!: () => void;
    const finalizerGate = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    let finalizerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizerStarted = resolve;
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'commit-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-commit',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
      finalize: async (settlement) => {
        finalizerStarted();
        await finalizerGate;
        return settlement;
      },
    });
    const assignment = await store.lease(
      'commit-worker',
      incarnationId,
      1_000,
    );
    const settlement = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
      status: 'fulfilled' as const,
      result: {
        language: 'bash',
        version: '5.2.0',
        session_id: 'run-commit',
        files: [],
      },
    };
    await store.settle(
      'commit-worker',
      assignment?.assignmentId ?? '',
      settlement,
    );
    await started;
    const [pendingMarker] = await redis.keys(
      'codeapi:bridge:v1:worker:commit-worker:workspace:*:quarantined',
    );
    expect(pendingMarker).toBeDefined();
    expect(await redis.get(pendingMarker)).toBe(
      assignment?.assignmentId ?? null,
    );

    releaseFinalizer();
    await expect(completion).resolves.toMatchObject({ status: 'fulfilled' });
    expect(await redis.exists(pendingMarker)).toBe(0);
    await expect(
      store.settle(
        'commit-worker',
        assignment?.assignmentId ?? '',
        settlement,
      ),
    ).resolves.toBeUndefined();
    expect(await redis.exists(pendingMarker)).toBe(0);
  });

  test('keeps an in-flight workspace fenced when execution never settles', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'lost-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'lost-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-lost',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'lost-worker',
      incarnationId,
      1_000,
    );
    expect(assignment).toBeDefined();
    const [marker] = await redis.keys(
      'codeapi:bridge:v1:worker:lost-worker:workspace:*:quarantined',
    );
    expect(await redis.get(marker)).toBe(assignment?.assignmentId ?? null);
    await expect(
      store.resetWorkspace('lost-worker', incarnationId, 'rt-lost'),
    ).rejects.toMatchObject({ code: 'WORKER_BUSY' });

    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'lost-worker',
      incarnationId: 'incarnation-00000002',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    await expect(
      store.dispatch({
        workerId: 'lost-worker',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        runtimeSessionId: 'rt-lost',
        deadlineAtMs: Date.now() + 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_QUARANTINED' });

    await store.resetWorkspace(
      'lost-worker',
      'incarnation-00000002',
      'rt-lost',
    );
    const recoveredController = new AbortController();
    const recoveredCompletion = store.dispatch({
      workerId: 'lost-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-lost',
      deadlineAtMs: Date.now() + 5_000,
      signal: recoveredController.signal,
    });
    const recoveredAssignment = await store.lease(
      'lost-worker',
      'incarnation-00000002',
      1_000,
    );
    expect(recoveredAssignment).toBeDefined();
    recoveredController.abort();
    await expect(recoveredCompletion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('clears an in-flight workspace marker after a definite rejection', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'rejected-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'rejected-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-rejected',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'rejected-worker',
      incarnationId,
      1_000,
    );
    const [marker] = await redis.keys(
      'codeapi:bridge:v1:worker:rejected-worker:workspace:*:quarantined',
    );
    expect(await redis.get(marker)).toBe(assignment?.assignmentId ?? null);
    await store.settle(
      'rejected-worker',
      assignment?.assignmentId ?? '',
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: assignment?.leaseToken ?? '',
        incarnationId,
        status: 'rejected',
        error: 'sandbox rejected before execution',
      },
    );

    await expect(completion).resolves.toMatchObject({ status: 'rejected' });
    expect(await redis.exists(marker)).toBe(0);
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
        ).rejects.toMatchObject({ code: 'WORKSPACE_QUARANTINED' });
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

  test('does not quarantine a stateless worker when finalization fails', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'stateless-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'stateless-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
      finalize: async () => {
        throw new Error('restore failed');
      },
    });
    const assignment = await store.lease(
      'stateless-worker',
      incarnationId,
      1_000,
    );
    await store.settle('stateless-worker', assignment?.assignmentId ?? '', {
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
        workerId: 'stateless-worker',
        incarnationId,
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).resolves.toBeUndefined();
  });
});
