import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Redis from 'ioredis';
import { RedisBridgeStore } from '../bridge/store';
import type { CodeBridgeAssignment } from '../bridge/store';
import { RedisWorkspaceRequests } from './requests';

const testRedisUrl = process.env.BRIDGE_TEST_REDIS_URL;
const redis = testRedisUrl !== undefined && testRedisUrl.length > 0
  ? new Redis(testRedisUrl)
  : new RedisMock() as unknown as Redis;
const bridge = new RedisBridgeStore(redis, 600, 1000, 2);
const owner = { tenantId: 'tenant', userId: 'user' };
const workerId = 'durable-worker';
const incarnationId = 'incarnation-00000001';
const requestId = 'request-00000000001';
const activeKey = 'codeapi:workspace-requests:v1:active';
const queueKey = `codeapi:bridge:v1:worker:${workerId}:admission`;

// Only a disposable test Redis may be supplied.
afterEach(async () => { await redis.flushall(); });

async function setup(slots = 1): Promise<RedisWorkspaceRequests> {
  const generation = await bridge.register({ protocolVersion: 1, workerId, incarnationId,
    capabilities: {
      sandboxProfile: 'native-srt', statefulWorkspace: false, runtimes: ['bash'],
      ...(slots > 1 ? { workspaceLeaseSlots: slots, requiresReadyConfirmation: true } : {}),
      workspaceTools: { protocolVersion: 1, operations: ['read_file', 'execute_command'],
        workspaces: [{ id: 'primary' }, { id: 'independent' }] },
    },
  });
  if (slots > 1) await bridge.confirmReady(workerId, incarnationId, generation);
  return new RedisWorkspaceRequests(redis, bridge);
}

function submit(requests: RedisWorkspaceRequests, id = requestId, workspaceId = 'primary'): ReturnType<RedisWorkspaceRequests['submit']> {
  return requests.submit({ owner, requestId: id, workerId, requireTenantBinding: false,
    request: { protocolVersion: 1, operation: 'read_file', workspaceId, path: 'README.md' },
    queueWaitMs: 300_000, executionTimeoutMs: 30_000,
  });
}

async function tick(requests: RedisWorkspaceRequests): Promise<void> {
  const keys = await redis.zrange(activeKey, 0, -1);
  for (const key of keys) await redis.zadd(activeKey, 0, key);
  await requests.reconcile();
}

async function settle(assignment: CodeBridgeAssignment, fulfilled = true): Promise<void> {
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId,
    assignment.generation, assignment.leaseToken);
  await bridge.settle(workerId, assignment.assignmentId, {
    protocolVersion: 1, incarnationId, generation: assignment.generation,
    leaseToken: assignment.leaseToken,
    ...(fulfilled ? { status: 'fulfilled' as const, result: { protocolVersion: 1, operation: 'read_file', workspaceId: (assignment.request as { workspaceId: string }).workspaceId, path: 'README.md', content: 'hello', startLine: 1, endLine: 1, truncated: false } }
      : { status: 'rejected' as const, error: 'stopped' }),
  });
}

async function mutateRecord(update: (record: Record<string, unknown>) => void): Promise<void> {
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const record = JSON.parse((await redis.hget(key, 'record'))!);
  update(record);
  await redis.hset(key, 'record', JSON.stringify(record));
}

test('submission is idempotent across replicas, scoped by principal, and conflicts do not move FIFO position', async () => {
  const requests = await setup();
  await submit(requests);
  await submit(requests, 'request-00000000002');
  const replica = new RedisWorkspaceRequests(redis, bridge);
  expect((await submit(replica)).queuePosition).toBe(1);
  expect(await redis.zcard(queueKey)).toBe(2);
  await expect(submit(replica, requestId, 'independent')).rejects.toThrow('different work');
  expect(await replica.get({ ...owner, userId: 'someone-else' }, requestId)).toBeUndefined();
  expect(await replica.cancel({ ...owner, tenantId: 'someone-else' }, requestId)).toBeUndefined();
});

test('restart before dispatch preserves the queue and starts a full execution budget after sixty seconds waiting', async () => {
  const requests = await setup();
  await submit(requests);
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  const restarted = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis));
  let assignment: CodeBridgeAssignment | undefined;
  try {
    await tick(restarted);
    assignment = await bridge.lease(workerId, incarnationId, 0);
    expect(assignment).toBeDefined();
    expect(assignment!.remainingMs).toBeGreaterThan(29_000);
    expect((await restarted.get(owner, requestId))?.queueWaitMs).toBeGreaterThanOrEqual(60_000);
  } finally { clock.mockRestore(); }
  await settle(assignment!);
  await tick(restarted);
  expect(await restarted.get(owner, requestId)).toMatchObject({ state: 'completed', result: { content: 'hello' } });
});

test.each([false, true])('restart around admission acknowledgement never enqueues another assignment (ack=%s)', async acknowledged => {
  const requests = await setup();
  await submit(requests);
  await tick(requests);
  const assignment = await bridge.lease(workerId, incarnationId, 0);
  if (acknowledged) await bridge.acknowledgeLease(workerId, incarnationId, assignment!.assignmentId,
    assignment!.generation, assignment!.leaseToken);
  const restarted = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis));
  await tick(restarted);
  await submit(restarted);
  expect((await bridge.lease(workerId, incarnationId, 0))?.assignmentId).toBe(assignment!.assignmentId);
  expect(await redis.llen(`codeapi:bridge:v1:worker:${workerId}:incarnation:${incarnationId}:assignments`)).toBe(0);
  await settle(assignment!);
  await tick(restarted);
  expect((await restarted.get(owner, requestId))?.state).toBe('completed');
});

test('a lost enqueue acknowledgement is reconciled rather than replayed', async () => {
  const requests = await setup();
  await submit(requests);
  const original = redis.eval.bind(redis);
  const failure = spyOn(redis, 'eval').mockImplementation((async (...args: Parameters<Redis['eval']>) => {
    const result = await original(...args);
    if (String(args[0]).includes('\'state\', \'admitted\', \'assignment\'')) throw new Error('lost acknowledgement');
    return result;
  }) as Redis['eval']);
  try { await expect(tick(requests)).rejects.toThrow('lost acknowledgement'); } finally { failure.mockRestore(); }
  const assignment = await bridge.lease(workerId, incarnationId, 0);
  expect(assignment).toBeDefined();
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect((await requests.get(owner, requestId))?.state).toBe('admitted');
  await settle(assignment!);
  await tick(requests);
  expect((await requests.get(owner, requestId))?.state).toBe('completed');
});

test('cancel before admission is durable and does not dispatch', async () => {
  const requests = await setup();
  await submit(requests);
  await requests.cancel(owner, requestId);
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect((await requests.get(owner, requestId))?.state).toBe('cancelled');
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
  expect(await redis.zcard(queueKey)).toBe(0);
});

test('cancel racing a persisted fulfillment returns the winning result without consuming it', async () => {
  const requests = await setup();
  await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await settle(assignment);
  await requests.cancel(owner, requestId);
  await tick(new RedisWorkspaceRequests(redis, bridge));
  const statuses = await Promise.all([requests.get(owner, requestId), requests.get(owner, requestId), requests.cancel(owner, requestId)]);
  for (const status of statuses) expect(status).toMatchObject({ state: 'completed', result: { content: 'hello' } });
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
});

test('restart after result persistence repeats only idempotent cleanup', async () => {
  const requests = await setup();
  await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await settle(assignment);
  const cleanup = spyOn(bridge, 'finishDurableWorkspaceTool').mockRejectedValue(new Error('process stopped'));
  try { await expect(tick(requests)).rejects.toThrow('process stopped'); } finally { cleanup.mockRestore(); }
  expect((await requests.get(owner, requestId))?.state).toBe('completed');
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect(await redis.zcard(activeKey)).toBe(0);
  await submit(requests);
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
});

test('pending work rejects a replacement worker incarnation and never transfers to it', async () => {
  const requests = await setup();
  await submit(requests);
  await bridge.register({ protocolVersion: 1, workerId, incarnationId: 'replacement-00001',
    capabilities: { sandboxProfile: 'native-srt', statefulWorkspace: false, runtimes: [],
      workspaceTools: { protocolVersion: 1, operations: ['read_file'], workspaces: [{ id: 'primary' }] } },
  });
  await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'WORKER_FENCED' } });
});

test('durable requests preserve negotiated independent-root concurrency', async () => {
  const requests = await setup(2);
  await submit(requests); await submit(requests, 'request-00000000002', 'independent');
  await tick(requests); await tick(requests);
  const first = await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0);
  const second = await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 1);
  expect(first).toBeDefined(); expect(second).toBeDefined();
  await settle(first!); await settle(second!); await tick(requests);
  expect((await requests.get(owner, requestId))?.state).toBe('completed');
  expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('completed');
});

test('restart after capacity reservation but before enqueue refreshes its own reservation without duplicating work', async () => {
  const requests = await setup();
  await submit(requests);
  const generation = spyOn(redis, 'incr').mockRejectedValue(new Error('process stopped before enqueue'));
  try { await expect(tick(requests)).rejects.toThrow('process stopped before enqueue'); } finally { generation.mockRestore(); }
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  await redis.pexpire(`codeapi:bridge:v1:worker:${workerId}:lock`, 5000);
  await tick(new RedisWorkspaceRequests(redis, bridge));
  const assignment = await bridge.lease(workerId, incarnationId, 0);
  expect(assignment).toBeDefined();
  expect(await redis.pttl(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeGreaterThan(30_000);
});

test('a stale coordinator cannot dispatch or overwrite a newer claim', async () => {
  const requests = await setup(); await submit(requests);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const record = JSON.parse((await redis.hget(key, 'record'))!);
  await redis.set(`${key}:claim`, 'new-owner', 'PX', 10000);
  await bridge.advanceDurableWorkspaceTool(record, { key, claimKey: `${key}:claim`, token: 'old-owner' });
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
});

test('a queued deadline expires as definitely unstarted work', async () => {
  const requests = await setup(); await submit(requests);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  await mutateRecord(record => { record.queueDeadlineAtMs = Date.now() - 1; });
  await redis.hset(key, 'queueDeadlineAtMs', Date.now() - 1);
  await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'WORKSPACE_QUEUE_TIMEOUT' } });
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
});

test('an expired acknowledged command is unknown, remains fenced, and is not re-enqueued on restart', async () => {
  const requests = await setup(); await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId, assignment.generation, assignment.leaseToken);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const stored = JSON.parse((await redis.hget(key, 'assignment'))!);
  stored.expiresAt = new Date(Date.now() - 1).toISOString();
  await redis.hset(key, 'assignment', JSON.stringify(stored));
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'ASSIGNMENT_EXPIRED' } });
  await submit(requests);
  expect(await redis.llen(`codeapi:bridge:v1:worker:${workerId}:incarnation:${incarnationId}:assignments`)).toBe(0);
  expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:workspace:${createHash('sha256').update('native-workspace:primary').digest('hex')}:quarantined`)).toBe(assignment.assignmentId);
});

test('cancel during command execution waits for clean rejection and does not replay', async () => {
  const requests = await setup();
  await requests.submit({ owner, requestId, workerId, requireTenantBinding: false,
    request: { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary', command: 'sleep 30' },
    queueWaitMs: 300_000, executionTimeoutMs: 35_000,
  });
  await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId, assignment.generation, assignment.leaseToken);
  await requests.cancel(owner, requestId);
  const cancelling = tick(requests);
  const deadline = Date.now() + 1000;
  while (!await bridge.cancelled(workerId, incarnationId, assignment.assignmentId)) {
    if (Date.now() >= deadline) throw new Error('Worker never received cancellation');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await settle(assignment, false);
  await cancelling;
  expect((await requests.get(owner, requestId))?.state).toBe('cancelled');
});

test('restart between workspace commit and cleanup preserves the result and releases the same assignment', async () => {
  const requests = await setup(); await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!; await settle(assignment);
  const original = redis.eval.bind(redis);
  let failed = false;
  const failure = spyOn(redis, 'eval').mockImplementation((async (...args: Parameters<Redis['eval']>) => {
    if (!failed && String(args[0]).includes('local queued = redis.call(\'LREM\'')) {
      failed = true; throw new Error('process stopped after commit');
    }
    return original(...args);
  }) as Redis['eval']);
  try { await expect(tick(requests)).rejects.toThrow('process stopped after commit'); } finally { failure.mockRestore(); }
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect((await requests.get(owner, requestId))?.state).toBe('completed');
  expect(await redis.zcard(activeKey)).toBe(0);
});
