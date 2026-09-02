import { afterEach, describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type * as t from '../types';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';

import type { RegisteredBridgeWorker } from './store';

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
  test('rejects a registration whose authenticated identity was replaced', async () => {
    await redis.set(
      'codeapi:bridge:v1:identity:fenced-worker',
      'replacement-credential-digest',
    );

    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'fenced-worker',
        incarnationId,
        credentialId: 'stale-credential-digest',
        identityId: 'stale-identity',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: ['bash'],
        },
      }, 'stale-credential-digest'),
    ).rejects.toMatchObject({ code: 'WORKER_UNAUTHORIZED' });

    await expect(
      redis.get('codeapi:bridge:v1:worker:fenced-worker'),
    ).resolves.toBeNull();
  });

  test('accepts registration after a same-identity credential rotation', async () => {
    await redis.set(
      'codeapi:bridge:v1:identity:rotating-registration-worker',
      'new-active-credential-digest',
    );
    await redis.set(
      'codeapi:bridge:v1:stable-identity:rotating-registration-worker',
      'stable-worker-identity',
    );

    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'rotating-registration-worker',
        incarnationId,
        credentialId: 'old-authenticated-credential-digest',
        identityId: 'stable-worker-identity',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: ['bash'],
        },
      }, 'old-authenticated-credential-digest'),
    ).resolves.toBe(1);
  });

  test('allocates registration generations only when the active incarnation changes', async () => {
    const registration: RegisteredBridgeWorker = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'generation-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
    };

    await expect(store.register(registration)).resolves.toBe(1);
    await expect(store.register(registration)).resolves.toBe(1);
    await expect(
      store.register({
        ...registration,
        incarnationId: 'incarnation-00000002',
      }),
    ).resolves.toBe(2);
  });

  test('rejects a dynamic worker lease outside its bound tenant', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'tenant-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
      binding: {
        tenantId: 'tenant-1',
        principal: { type: 'user', id: 'user-1' },
      },
    });

    await expect(
      store.dispatch({
        workerId: 'tenant-worker',
        tenantId: 'tenant-2',
        requireTenantBinding: true,
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        deadlineAtMs: Date.now() + 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_UNAUTHORIZED' });
  });

  test('does not lease an assignment to a newly rebound worker identity', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'rebound-worker',
      incarnationId,
      identityId: 'tenant-a-identity',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
      binding: {
        tenantId: 'tenant-a',
        principal: { type: 'user', id: 'user-a' },
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'rebound-worker',
      tenantId: 'tenant-a',
      requireTenantBinding: true,
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });

    await expect(
      store.lease(
        'rebound-worker',
        incarnationId,
        1_000,
        undefined,
        'tenant-b-identity',
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.lease(
        'rebound-worker',
        incarnationId,
        1_000,
        undefined,
        'tenant-a-identity',
      ),
    ).resolves.toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  });

  test('a stale identity poll cannot consume work queued for the replacement identity', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'replacement-worker',
      incarnationId,
      identityId: 'replacement-identity',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
      binding: {
        tenantId: 'tenant-a',
        principal: { type: 'user', id: 'user-a' },
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'replacement-worker',
      tenantId: 'tenant-a',
      requireTenantBinding: true,
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });

    await expect(
      store.lease(
        'replacement-worker',
        incarnationId,
        100,
        undefined,
        'stale-identity',
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.lease(
        'replacement-worker',
        incarnationId,
        1_000,
        undefined,
        'replacement-identity',
      ),
    ).resolves.toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  });

  test('a stale incarnation poll cannot consume replacement incarnation work', async () => {
    const replacementIncarnationId = 'incarnation-00000002';
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'restarted-worker',
      incarnationId: replacementIncarnationId,
      identityId: 'stable-restarted-identity',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
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

    await expect(
      store.lease(
        'restarted-worker',
        incarnationId,
        100,
        undefined,
        'stable-restarted-identity',
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.lease(
        'restarted-worker',
        replacementIncarnationId,
        1_000,
        undefined,
        'stable-restarted-identity',
      ),
    ).resolves.toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  });

  test('leases queued work after credential refresh preserves the paired identity', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'rotating-worker',
      incarnationId,
      identityId: 'stable-paired-identity',
      credentialId: 'credential-before-refresh',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
      binding: {
        tenantId: 'tenant-a',
        principal: { type: 'user', id: 'user-a' },
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'rotating-worker',
      tenantId: 'tenant-a',
      requireTenantBinding: true,
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });

    const assignment = await store.lease(
      'rotating-worker',
      incarnationId,
      1_000,
      undefined,
      'stable-paired-identity',
    );

    expect(assignment).toBeDefined();
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  });

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

  test('redelivers a lease claim until the worker acknowledges it', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'claim-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const completion = store.dispatch({
      workerId: 'claim-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal,
    });
    const first = await store.lease('claim-worker', incarnationId, 1_000);
    const redelivered = await store.lease(
      'claim-worker',
      incarnationId,
      1_000,
    );
    expect(redelivered?.assignmentId).toBe(first?.assignmentId);

    await store.acknowledgeLease(
      'claim-worker',
      incarnationId,
      first?.assignmentId ?? '',
      first?.generation ?? 0,
      first?.leaseToken ?? '',
    );
    await store.settle('claim-worker', first?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: first?.generation ?? 0,
      leaseToken: first?.leaseToken ?? '',
      incarnationId,
      status: 'rejected',
      error: 'test complete',
    });
    await expect(completion).resolves.toMatchObject({ status: 'rejected' });
  });

  test('performs one immediate lease poll when wait is zero', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'nonblocking-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const completion = store.dispatch({
      workerId: 'nonblocking-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        (
          await redis.keys(
            'codeapi:bridge:v1:assignment:*',
          )
        ).length > 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const assignment = await store.lease(
      'nonblocking-worker',
      incarnationId,
      0,
    );
    expect(assignment).toBeDefined();
    await store.settle('nonblocking-worker', assignment?.assignmentId ?? '', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: assignment?.generation ?? 0,
      leaseToken: assignment?.leaseToken ?? '',
      incarnationId,
      status: 'rejected',
      error: 'test complete',
    });
    await expect(completion).resolves.toMatchObject({ status: 'rejected' });
  });

  test('bounds a stalled Redis lease claim', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.eval = (() => new Promise(() => undefined)) as Redis['eval'];

    await expect(
      timedStore.lease('stalled-worker', incarnationId, 0),
    ).rejects.toThrow('Bridge lease claim timed out');
  });

  test('bounds a stalled Redis worker registration', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.eval = (() => new Promise(() => undefined)) as Redis['eval'];

    await expect(
      timedStore.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'stalled-registration-worker',
        incarnationId,
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toThrow('Bridge worker registration timed out');
  });

  test('bounds stalled Redis reads during cancellation polling', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.get = (() => new Promise(() => undefined)) as Redis['get'];

    await expect(
      timedStore.cancelled(
        'stalled-cancellation-worker',
        incarnationId,
        'assignment-stalled-cancellation',
      ),
    ).rejects.toThrow('Bridge cancellation assignment read timed out');
  });

  test('bounds stalled Redis reads during lease acknowledgement', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.get = (() => new Promise(() => undefined)) as Redis['get'];

    await expect(
      timedStore.acknowledgeLease(
        'stalled-ack-worker',
        incarnationId,
        'assignment-stalled-ack',
        1,
        'lease-token-that-is-long-enough-for-testing',
      ),
    ).rejects.toThrow('Bridge acknowledgement assignment read timed out');
  });

  test('bounds stalled Redis reads during settlement', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.get = (() => new Promise(() => undefined)) as Redis['get'];

    await expect(
      timedStore.settle('stalled-settlement-worker', 'assignment-stalled', {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: 1,
        leaseToken: 'lease-token-that-is-long-enough-for-testing',
        incarnationId,
        status: 'rejected',
        error: 'test',
      }),
    ).rejects.toThrow('Bridge settlement existing read timed out');
  });

  test('bounds a stalled Redis workspace reset', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.eval = (() => new Promise(() => undefined)) as Redis['eval'];

    await expect(
      timedStore.resetWorkspace(
        'stalled-reset-worker',
        incarnationId,
        'rt-stalled-reset',
      ),
    ).rejects.toThrow('Bridge workspace reset timed out');
  });

  test('encodes worker IDs so Redis key families cannot collide', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'foo',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'foo',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease('foo', incarnationId, 1_000);

    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'foo:lock',
      incarnationId: 'incarnation-00000002',
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    expect(
      await redis.get('codeapi:bridge:v1:worker:foo:lock'),
    ).toBe(assignment?.assignmentId ?? null);
    expect(
      await redis.get('codeapi:bridge:v1:worker:foo%3Alock'),
    ).not.toBeNull();
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('retains cancellation through the assignment lifetime', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'cancel-ttl-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'cancel-ttl-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 120_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'cancel-ttl-worker',
      incarnationId,
      1_000,
    );
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });

    expect(
      await redis.ttl(
        `codeapi:bridge:v1:assignment:${assignment?.assignmentId}:cancelled`,
      ),
    ).toBeGreaterThan(30);
  });

  test('bounds a stalled quarantine command', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 10);
    redis.eval = (() => new Promise(() => undefined)) as Redis['eval'];

    await expect(
      timedStore.quarantine('stalled-worker', incarnationId, 'rt-user-1'),
    ).rejects.toThrow('Bridge worker quarantine timed out');
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

  test('preserves a workspace fence when an acknowledged lease expires', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'ack-expired-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'ack-expired-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-ack-expired',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'ack-expired-worker',
      incarnationId,
      1_000,
    );
    await store.acknowledgeLease(
      'ack-expired-worker',
      incarnationId,
      assignment?.assignmentId ?? '',
      assignment?.generation ?? 0,
      assignment?.leaseToken ?? '',
    );
    const storedKey = `codeapi:bridge:v1:assignment:${assignment?.assignmentId}`;
    const stored = JSON.parse(
      (await redis.get(storedKey)) ?? '{}',
    ) as Record<string, unknown>;
    stored.expiresAt = new Date(0).toISOString();
    await redis.set(storedKey, JSON.stringify(stored), 'EX', 30);

    await expect(
      store.lease('ack-expired-worker', incarnationId, 0),
    ).resolves.toBeUndefined();
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:ack-expired-worker:workspace:*:quarantined',
      ),
    ).toHaveLength(1);
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('clears a workspace fence when dispatch cancels before lease', async () => {
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
      runtimeSessionId: 'rt-cancelled-queue',
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:vm-1:workspace:*:quarantined',
      ),
    ).toHaveLength(0);
    expect(
      await redis.llen(
        `codeapi:bridge:v1:worker:vm-1:incarnation:${incarnationId}:assignments`,
      ),
    ).toBe(0);
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
    redis.eval = (async (...args: Parameters<Redis['eval']>) => {
      const result = await redisEval(...args);
      if (
        String(args[0]).includes(
          "local claimed = redis.call('GET', KEYS[2])",
        ) &&
        result != null
      ) {
        leaseController.abort();
      }
      return result;
    }) as Redis['eval'];

    await expect(
      store.lease('vm-1', incarnationId, 1_000, leaseController.signal),
    ).resolves.toBeUndefined();
    redis.eval = redisEval as Redis['eval'];

    const recovered = await store.lease('vm-1', incarnationId, 1_000);
    expect(recovered).toBeDefined();
    expect(recovered?.workerId).toBe('vm-1');
    dispatchController.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });
  });

  test('restores queue expiry when returning a lease', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'returned-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const controller = new AbortController();
    const completion = store.dispatch({
      workerId: 'returned-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    });
    const assignment = await store.lease(
      'returned-worker',
      incarnationId,
      1_000,
    );
    await store.returnLease(assignment!);

    expect(
      await redis.ttl(
        `codeapi:bridge:v1:worker:returned-worker:incarnation:${incarnationId}:assignments`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await store.lease('returned-worker', incarnationId, 1_000),
    ).toBeDefined();
    controller.abort();
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
    ).resolves.toBe(2);
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
    ).resolves.toBe(1);

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

  test('bounds a stalled Redis settlement poll command', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 20);
    await timedStore.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'stalled-redis-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    redis.get = ((key: string) => {
      if (key.endsWith(':settlement')) {
        return new Promise<string | null>(() => {});
      }
      return redisGet(key);
    }) as Redis['get'];
    const controller = new AbortController();

    await expect(
      timedStore.dispatch({
        workerId: 'stalled-redis-worker',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        deadlineAtMs: Date.now() + 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Bridge settlement poll timed out');
  });

  test('bounds a stalled Redis dispatch preparation command', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 20);
    await timedStore.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'stalled-preparation-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    redis.get = (() => new Promise<string | null>(() => {})) as Redis['get'];

    await expect(
      timedStore.dispatch({
        workerId: 'stalled-preparation-worker',
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Bridge worker registration read timed out');
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
    let cleanupAttempts = 0;
    redis.eval = (async (...args: Parameters<Redis['eval']>) => {
      if (String(args[0]).includes("local queued = redis.call('LREM'")) {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error('transient cleanup failure');
        }
      }
      return await redisEval(...args);
    }) as Redis['eval'];
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
    redis.eval = redisEval as Redis['eval'];
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

  test('bounds a stalled Redis workspace commit command', async () => {
    const timedStore = new RedisBridgeStore(redis, 60, 20);
    await timedStore.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'stalled-commit-worker',
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
    const completion = timedStore.dispatch({
      workerId: 'stalled-commit-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-stalled-commit',
      deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal,
      finalize: async (settlement) => {
        finalizerStarted();
        await finalizerGate;
        return settlement;
      },
    });
    const assignment = await timedStore.lease(
      'stalled-commit-worker',
      incarnationId,
      1_000,
    );
    await timedStore.acknowledgeLease(
      'stalled-commit-worker',
      incarnationId,
      assignment?.assignmentId ?? '',
      assignment?.generation ?? 0,
      assignment?.leaseToken ?? '',
    );
    await timedStore.settle(
      'stalled-commit-worker',
      assignment?.assignmentId ?? '',
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: assignment?.leaseToken ?? '',
        incarnationId,
        status: 'fulfilled',
        result: {
          language: 'bash',
          version: '5.2.0',
          session_id: 'run-stalled-commit',
          files: [],
        },
      },
    );
    await started;
    redis.eval = ((...args: Parameters<Redis['eval']>) => {
      if (
        Number(args[1]) === 1 &&
        String(args[0]).includes("return redis.call('DEL', KEYS[1])")
      ) {
        return new Promise<never>(() => {});
      }
      return redisEval(...args);
    }) as Redis['eval'];
    releaseFinalizer();

    await expect(completion).rejects.toThrow(
      'Bridge workspace commit timed out',
    );
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
    await store.acknowledgeLease(
      'lost-worker',
      incarnationId,
      assignment?.assignmentId ?? '',
      assignment?.generation ?? 0,
      assignment?.leaseToken ?? '',
    );
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
    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'lost-worker',
        incarnationId: 'incarnation-00000002',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_BUSY' });
    expect(
      await redis.get('codeapi:bridge:v1:worker:lost-worker:lock'),
    ).toBe(assignment?.assignmentId ?? null);
    await redis.del(
      'codeapi:bridge:v1:worker:lost-worker:lock',
      'codeapi:bridge:v1:worker:lost-worker:lock:incarnation',
    );
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

  test('accepts a late clean rejection and recovers its workspace fence', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'late-rejection-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const completion = store.dispatch({
      workerId: 'late-rejection-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-late-rejection',
      deadlineAtMs: Date.now() + 200,
      signal: new AbortController().signal,
    });
    const assignment = await store.lease(
      'late-rejection-worker',
      incarnationId,
      1_000,
    );
    await store.acknowledgeLease(
      'late-rejection-worker',
      incarnationId,
      assignment?.assignmentId ?? '',
      assignment?.generation ?? 0,
      assignment?.leaseToken ?? '',
    );
    await expect(completion).rejects.toMatchObject({
      code: 'ASSIGNMENT_EXPIRED',
    });

    await store.settle(
      'late-rejection-worker',
      assignment?.assignmentId ?? '',
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: assignment?.leaseToken ?? '',
        incarnationId,
        status: 'rejected',
        error: 'syntax_error',
      },
    );
    expect(
      await redis.keys(
        'codeapi:bridge:v1:worker:late-rejection-worker:workspace:*:quarantined',
      ),
    ).toHaveLength(0);
  });

  test('atomically rejects a fulfillment committed after its deadline', async () => {
    await store.register({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'late-fulfillment-worker',
      incarnationId,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: [],
      },
    });
    const deadlineAtMs = Date.now() + 250;
    redis.eval = (async (...args: Parameters<Redis['eval']>) => {
      const script = String(args[0]);
      if (script.includes("redis.call('RPUSH', KEYS[3], ARGV[4])")) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      if (script.includes("local existing = redis.call('GET', KEYS[2])")) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now() + 25)),
        );
      }
      return redisEval(...args);
    }) as Redis['eval'];
    const completion = store.dispatch({
      workerId: 'late-fulfillment-worker',
      body: { language: 'bash' } as t.PayloadBody,
      headers: {},
      runtimeSessionId: 'rt-late-fulfillment',
      deadlineAtMs,
      signal: new AbortController().signal,
    });
    const assignment = await store.lease(
      'late-fulfillment-worker',
      incarnationId,
      1_000,
    );
    await store.acknowledgeLease(
      'late-fulfillment-worker',
      incarnationId,
      assignment?.assignmentId ?? '',
      assignment?.generation ?? 0,
      assignment?.leaseToken ?? '',
    );
    await expect(
      store.settle('late-fulfillment-worker', assignment?.assignmentId ?? '', {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: assignment?.leaseToken ?? '',
        incarnationId,
        status: 'fulfilled',
        result: {
          language: 'bash',
          version: '5.2.0',
          session_id: 'run-late-fulfillment',
          files: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
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
    ).resolves.toBe(1);
  });
});
