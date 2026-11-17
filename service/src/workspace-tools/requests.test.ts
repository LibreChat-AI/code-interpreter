import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import Redis from 'ioredis';
import { RedisBridgeStore } from '../bridge/store';
import { BridgeAdmissionQueue } from '../bridge/admission';
import type { CodeBridgeAssignment } from '../bridge/store';
import { workspaceDetachedCommandKey } from '../../../packages/code/src/protocol';
import type { BridgeRejectedSettlement, WorkspaceToolRequest } from '../../../packages/code/src/protocol';
import { RedisWorkspaceRequests } from './requests';
import { workspaceRequestCoordinationScope } from './coordination';
import type { WorkspaceRequestCoordinationPolicy } from './coordination';

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

async function setup(slots = 1, lanes = false, detached = false): Promise<RedisWorkspaceRequests> {
  const generation = await bridge.register({ protocolVersion: 1, workerId, incarnationId,
    capabilities: {
      sandboxProfile: 'native-srt', statefulWorkspace: false, runtimes: ['bash'],
      ...(slots > 1 ? { workspaceLeaseSlots: slots, requiresReadyConfirmation: true } : {}),
      workspaceTools: { protocolVersion: 1, operations: ['read_file', 'execute_command', 'list_files', 'search_text', 'preview_edit'],
        workspaces: [
          { id: 'primary', ...(lanes ? { workspaceScopes: ['git_linked_worktree' as const] } : {}) },
          { id: 'independent' },
        ],
        ...(detached ? { commandFeatures: ['detached' as const] } : {}) },
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
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  await mutateRecord(record => {
    record.createdAtMs = Number(record.createdAtMs) - 60_000;
    record.queueDeadlineAtMs = Number(record.queueDeadlineAtMs) - 60_000;
  });
  const record = JSON.parse((await redis.hget(key, 'record'))!);
  await redis.hset(key, 'queueDeadlineAtMs', record.queueDeadlineAtMs);
  const restarted = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis));
  await tick(restarted);
  const assignment = await bridge.lease(workerId, incarnationId, 0);
  expect(assignment).toBeDefined();
  expect(assignment!.remainingMs).toBeGreaterThan(29_000);
  // Mock Redis TIME has subsecond clock skew. Execution still receives its full budget.
  expect((await restarted.get(owner, requestId))?.queueWaitMs).toBeGreaterThan(59_000);
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

test.each([1, 2])('restart after capacity reservation refreshes its own reservation without duplicating work (slots=%s)', async slots => {
  const requests = await setup(slots);
  await submit(requests);
  const generation = spyOn(redis, 'incr').mockRejectedValue(new Error('process stopped before enqueue'));
  try { await expect(tick(requests)).rejects.toThrow('process stopped before enqueue'); } finally { generation.mockRestore(); }
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  await redis.pexpire(`codeapi:bridge:v1:worker:${workerId}:lock`, 5000);
  await tick(new RedisWorkspaceRequests(redis, bridge));
  const assignment = await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0);
  expect(assignment).toBeDefined();
  expect(await redis.pttl(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeGreaterThan(30_000);
});

test.each([1, 2])('a stale coordinator cannot acquire capacity or dispatch (slots=%s)', async slots => {
  const requests = await setup(slots); await submit(requests);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const record = JSON.parse((await redis.hget(key, 'record'))!);
  await redis.set(`${key}:claim`, 'new-owner', 'PX', 10000);
  await bridge.advanceDurableWorkspaceTool(record, { key, claimKey: `${key}:claim`, token: 'old-owner' });
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeUndefined();
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeNull();
  expect(await redis.hlen(`codeapi:bridge:v1:worker:${workerId}:workspace-slots`)).toBe(0);
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

test('simultaneous submissions from replicas keep one request identity and one FIFO entry', async () => {
  const requests = await setup();
  const replica = new RedisWorkspaceRequests(redis, bridge);
  const statuses = await Promise.all([submit(requests), submit(replica)]);
  for (const status of statuses) expect(status).toMatchObject({ requestId, state: 'queued', queuePosition: 1 });
  expect(await redis.zcard(queueKey)).toBe(1);
  expect(await redis.zcard(activeKey)).toBe(1);
  await tick(requests);
  expect(await bridge.lease(workerId, incarnationId, 0)).toBeDefined();
});

test.each([false, true])('temporary registration loss preserves FIFO until the original worker reconnects (replacement=%s)', async replacement => {
  const requests = await setup();
  await submit(requests); await submit(requests, 'request-00000000002');
  // Registration/readiness TTL expiry, without losing accepted work.
  const worker = `codeapi:bridge:v1:worker:${workerId}`;
  await redis.del(worker, `${worker}:incarnation`, `${worker}:ready`);
  const restarted = new RedisWorkspaceRequests(redis, bridge);
  await tick(restarted);
  expect(await restarted.get(owner, requestId)).toMatchObject({ state: 'queued', queuePosition: 1 });
  expect(await redis.zcard(activeKey)).toBe(2);
  if (replacement) {
    await bridge.register({ protocolVersion: 1, workerId, incarnationId: 'replacement-00001',
      capabilities: { sandboxProfile: 'native-srt', statefulWorkspace: false, runtimes: [],
        workspaceTools: { protocolVersion: 1, operations: ['read_file'], workspaces: [{ id: 'primary' }] } },
    });
    await tick(restarted);
    expect(await restarted.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'WORKER_FENCED' } });
    expect(await bridge.lease(workerId, 'replacement-00001', 0)).toBeUndefined();
  } else {
    await setup(); await tick(restarted);
    const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
    expect(assignment).toBeDefined();
    await settle(assignment); await tick(restarted);
    expect((await restarted.get(owner, requestId))?.state).toBe('completed');
  }
});

test('an offline worker cannot extend the queue deadline', async () => {
  const requests = await setup(); await submit(requests);
  const worker = `codeapi:bridge:v1:worker:${workerId}`;
  await redis.del(worker, `${worker}:incarnation`, `${worker}:ready`);
  await tick(requests);
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  await mutateRecord(record => { record.queueDeadlineAtMs = Date.now() - 1; });
  await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'WORKSPACE_QUEUE_TIMEOUT' } });
  expect(await redis.zcard(activeKey)).toBe(0);
});

test('durable reset epochs outlive their receipts and reject late quarantine after reset', async () => {
  const requests = await setup(2); await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  await settle(assignment); await tick(requests);
  const receipt = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:workspace-fence-owner`;
  const fence = `codeapi:bridge:v1:worker:${workerId}:workspace:${createHash('sha256').update('native-workspace:primary').digest('hex')}:quarantined`;
  expect(await redis.pttl(`${fence}:epoch`)).toBeGreaterThanOrEqual(await redis.pttl(receipt) - 50);
  expect(await redis.pttl(`${fence}:epoch`)).toBeGreaterThan(86_000_000);
  // Simulate execution-ownership TTL expiry. The durable receipt and epoch survive.
  await redis.del(`codeapi:bridge:v1:worker:${workerId}:workspace-slots`,
    `codeapi:bridge:v1:worker:${workerId}:lock`, `codeapi:bridge:v1:worker:${workerId}:lock:incarnation`);
  await bridge.resetWorkspace(workerId, incarnationId, 'native-workspace:primary');
  await submit(requests, 'request-00000000002'); await tick(requests);
  const next = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  await expect(bridge.settle(workerId, assignment.assignmentId, {
    protocolVersion: 1, incarnationId, generation: assignment.generation, leaseToken: assignment.leaseToken,
    status: 'rejected', error: 'delayed local cleanup failure',
  }, undefined, undefined, true)).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
  expect(await redis.get(fence)).toBe(next.assignmentId);
  await settle(next); await tick(requests);
  expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('completed');
});

const coordinationPolicy: WorkspaceRequestCoordinationPolicy = {
  bridgeEnabled: true, backend: 'remote-bridge', executionProfile: 'default', authMode: 'paired',
  configuredWorkerId: '', dynamicWorkers: true, maxWorkspaceLeaseSlots: 2, maxCommandTimeoutMs: 30_000,
};

test('disabled bridges do not participate and each scheduling policy has an isolated scope', () => {
  expect(workspaceRequestCoordinationScope({ ...coordinationPolicy, bridgeEnabled: false })).toBeUndefined();
  const scope = workspaceRequestCoordinationScope(coordinationPolicy);
  expect(workspaceRequestCoordinationScope({ ...coordinationPolicy })).toBe(scope);
  const variants: Partial<WorkspaceRequestCoordinationPolicy>[] = [
    { maxWorkspaceLeaseSlots: 1 }, { backend: 'http' }, { executionProfile: 'stateful' },
    { authMode: 'static' }, { configuredWorkerId: 'another' }, { dynamicWorkers: false },
    { maxCommandTimeoutMs: 60_000 },
  ];
  for (const variant of variants) expect(workspaceRequestCoordinationScope({ ...coordinationPolicy, ...variant })).not.toBe(scope);
});

test('a different policy cannot claim or fail work accepted by a two-slot bridge API', async () => {
  await setup(2);
  const scope = workspaceRequestCoordinationScope(coordinationPolicy)!;
  const requests = new RedisWorkspaceRequests(redis, bridge, undefined, scope);
  await submit(requests);
  const foreignScope = workspaceRequestCoordinationScope({ ...coordinationPolicy, maxWorkspaceLeaseSlots: 1 })!;
  const foreign = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis), undefined, foreignScope);
  await foreign.reconcile();
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  expect(await foreign.get(owner, requestId)).toBeUndefined();
  const restarted = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis, 600, 1000, 2), undefined, scope);
  await restarted.reconcile();
  const assignment = await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0);
  expect(assignment).toBeDefined();
});

test('a late FIFO response cannot relock a cancelled request after the coordinator timed out', async () => {
  const requests = await setup(); await submit(requests);
  let release!: () => void;
  let entered!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const drained = new Promise<void>(resolve => { finished = resolve; });
  const originalHead = BridgeAdmissionQueue.prototype.isHead;
  const originalAdvance = bridge.advanceDurableWorkspaceTool.bind(bridge);
  const head = spyOn(BridgeAdmissionQueue.prototype, 'isHead').mockImplementation(async (worker, id) => {
    const result = await originalHead.call(new BridgeAdmissionQueue(redis), worker, id);
    entered(); await gate; return result;
  });
  const advance = spyOn(bridge, 'advanceDurableWorkspaceTool').mockImplementation(async (...args) => {
    try { return await originalAdvance(...args); } finally { finished(); }
  });
  const pending = tick(requests);
  void pending.catch(() => undefined);
  try {
    await started;
    await expect(pending).rejects.toThrow('Durable workspace transition timed out');
    head.mockRestore(); advance.mockRestore();
    const key = (await redis.zrange(activeKey, 0, -1))[0];
    const claimDeadline = Date.now() + 1000;
    while (await redis.get(`${key}:claim`) != null) {
      if (Date.now() >= claimDeadline) throw new Error('Timed-out coordinator did not release its claim');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await requests.cancel(owner, requestId);
    await tick(new RedisWorkspaceRequests(redis, bridge));
    expect((await requests.get(owner, requestId))?.state).toBe('cancelled');
    expect(await redis.zcard(activeKey)).toBe(0);
    release(); await drained;
    expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeNull();
    await submit(requests, 'request-00000000002'); await tick(requests);
    expect(await bridge.lease(workerId, incarnationId, 0)).toBeDefined();
  } finally { release(); head.mockRestore(); advance.mockRestore(); await drained; }
}, 15_000);

test.each([1, 2])('Redis capacity writes delayed past cancellation cannot strand a reservation (slots=%s)', async slots => {
  const requests = await setup(slots); await submit(requests);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = redis.eval.bind(redis);
  let held = false;
  const delay = spyOn(redis, 'eval').mockImplementation((async (...args: Parameters<Redis['eval']>) => {
    const script = String(args[0]);
    if (!held && script.includes('local admissionTime') && !script.includes('local keyCount')) {
      held = true; entered(); await gate;
    }
    return original(...args);
  }) as Redis['eval']);
  const pending = tick(requests);
  void pending.catch(() => undefined);
  try {
    await started;
    const key = (await redis.zrange(activeKey, 0, -1))[0];
    // Expire this claim while its Redis command is still undelivered.
    await redis.del(`${key}:claim`);
    await requests.cancel(owner, requestId);
    await tick(new RedisWorkspaceRequests(redis, bridge));
    expect((await requests.get(owner, requestId))?.state).toBe('cancelled');
    release(); await pending;
    expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeNull();
    expect(await redis.hlen(`codeapi:bridge:v1:worker:${workerId}:workspace-slots`)).toBe(0);
    expect(await redis.zcard(activeKey)).toBe(0);
  } finally { release(); delay.mockRestore(); await pending.catch(() => undefined); }
});

test.each([1, 2])('a durable enqueue refuses lost capacity ownership (slots=%s)', async slots => {
  const requests = await setup(slots); await submit(requests);
  const original = redis.eval.bind(redis);
  const loss = spyOn(redis, 'eval').mockImplementation((async (...args: Parameters<Redis['eval']>) => {
    if (String(args[0]).includes('local keyCount')) {
      await redis.del(`codeapi:bridge:v1:worker:${workerId}:lock`,
        `codeapi:bridge:v1:worker:${workerId}:workspace-slots`);
    }
    return original(...args);
  }) as Redis['eval']);
  try { await tick(requests); } finally { loss.mockRestore(); }
  expect((await requests.get(owner, requestId))?.state).toBe('queued');
  expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0)).toBeUndefined();
  await tick(requests);
  expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0)).toBeDefined();
});

test.each([1, 2])('capacity acquisition rejects terminal, cancelled, expired, and unclaimed requests (slots=%s)', async slots => {
  for (const denial of ['terminal', 'cancelled', 'expired', 'unclaimed']) {
    await redis.flushall();
    const requests = await setup(slots); await submit(requests);
    const key = (await redis.zrange(activeKey, 0, -1))[0];
    const record = JSON.parse((await redis.hget(key, 'record'))!);
    const token = 'current-coordinator';
    await redis.set(`${key}:claim`, token, 'PX', 10000);
    if (denial === 'terminal') await redis.hset(key, 'state', 'cancelled');
    if (denial === 'cancelled') await redis.hset(key, 'cancelRequested', '1');
    if (denial === 'expired') await redis.hset(key, 'queueDeadlineAtMs', Date.now() - 2000);
    if (denial === 'unclaimed') await redis.del(`${key}:claim`);
    await bridge.advanceDurableWorkspaceTool(record, { key, claimKey: `${key}:claim`, token });
    expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeNull();
    expect(await redis.hlen(`codeapi:bridge:v1:worker:${workerId}:workspace-slots`)).toBe(0);
    expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0)).toBeUndefined();
  }
});

test.each([false, true])('quarantine retains the winning durable outcome across two-minute recovery (settled=%s)', async settled => {
  const requests = await setup(2);
  await requests.submit({ owner, requestId, workerId, requireTenantBinding: false,
    request: { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary', command: 'echo ready' },
    queueWaitMs: 300_000, executionTimeoutMs: 30_000,
  });
  await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId, assignment.generation, assignment.leaseToken);
  const firstError = 'Command stopped before local cleanup';
  const quarantineError = 'Workspace cleanup failed before settlement';
  const envelope = { protocolVersion: 1 as const, incarnationId,
    generation: assignment.generation, leaseToken: assignment.leaseToken,
    status: 'rejected' as const,
  };
  if (settled) await bridge.settle(workerId, assignment.assignmentId, { ...envelope, error: firstError });
  await bridge.settle(workerId, assignment.assignmentId, { ...envelope, error: quarantineError }, undefined, undefined, true);
  const resultKey = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:settlement`;
  const receiptKey = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:workspace-fence-owner`;
  const receipt = JSON.parse((await redis.hget(receiptKey, 'metadata'))!);
  expect(receipt.durableRequestKey).toBe((await redis.zrange(activeKey, 0, -1))[0]);
  const remaining = await redis.pttl(resultKey);
  expect(remaining).toBeGreaterThan(86_000_000);
  expect(await redis.get(`codeapi:bridge:v1:assignment:${assignment.assignmentId}`)).toBeNull();
  // Advance retained storage and the coordinator clock without a two-minute sleep.
  await redis.pexpire(resultKey, Math.max(0, remaining - 120_000));
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  const restarted = new RedisWorkspaceRequests(redis, new RedisBridgeStore(redis, 600, 1000, 2));
  try {
    await tick(restarted);
    expect(await restarted.get(owner, requestId)).toMatchObject({
      state: 'failed', error: { code: 'WORKSPACE_TOOL_REJECTED', message: settled ? firstError : quarantineError },
    });
    expect(await redis.pttl(resultKey)).toBeGreaterThan(85_000_000);
    expect(await redis.zcard(activeKey)).toBe(0);
    await submit(restarted, 'request-00000000002'); await tick(restarted);
    expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0)).toBeUndefined();
    expect(await restarted.get(owner, 'request-00000000002')).toMatchObject({
      state: 'failed', error: { code: 'WORKSPACE_QUARANTINED' },
    });
  } finally { clock.mockRestore(); }
});

test('queued durable requests retain FIFO workspace metadata across same-incarnation slot changes', async () => {
  const requests = await setup();
  await submit(requests);
  await submit(requests, 'request-00000000002');
  await submit(requests, 'request-00000000003', 'independent');
  await submit(requests);
  await setup(2);
  await tick(requests); await tick(requests);
  const first = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  const independent = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 1))!;
  expect(first).toBeDefined(); expect(independent).toBeDefined();
  expect(first.request).toMatchObject({ workspaceId: 'primary' });
  expect(independent.request).toMatchObject({ workspaceId: 'independent' });
  expect(await requests.get(owner, 'request-00000000002')).toMatchObject({ state: 'queued', queuePosition: 2 });
  await settle(first); await settle(independent); await tick(requests);
  await bridge.confirmWorkspaceCleanup(workerId, first.assignmentId, {
    protocolVersion: 1, incarnationId, generation: first.generation, leaseToken: first.leaseToken,
    status: 'rejected', error: 'local cleanup confirmed',
  });
  await tick(requests);
  const next = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  expect(next).toBeDefined();
  await settle(next); await tick(requests);
  expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('completed');
});

const readOnlyRequests: WorkspaceToolRequest[] = [
  { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'README.md' },
  { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
  { protocolVersion: 1, operation: 'search_text', workspaceId: 'primary', query: 'needle' },
  { protocolVersion: 1, operation: 'preview_edit', workspaceId: 'primary', path: 'README.md', oldText: 'old', newText: 'new' },
];
const readCancellationCases = readOnlyRequests.flatMap(request => [1, 2].flatMap(slots =>
  ['unleased', 'claimed', 'acknowledged'].map(phase => ({ request, slots, phase })),
));

test.each(readCancellationCases)('durable read cancellation notifies the worker before closing (%j)', async ({ request, slots, phase }) => {
  const requests = await setup(slots);
  await requests.submit({ owner, requestId, workerId, requireTenantBinding: false,
    request, queueWaitMs: 300_000, executionTimeoutMs: 30_000,
  });
  await tick(requests);
  const slot = slots === 1 ? undefined : 0;
  let assignment = phase === 'unleased' ? undefined : await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slot);
  if (phase === 'acknowledged') await bridge.acknowledgeLease(workerId, incarnationId, assignment!.assignmentId,
    assignment!.generation, assignment!.leaseToken);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const stored = JSON.parse((await redis.hget(key, 'assignment'))!);
  await requests.cancel(owner, requestId);
  const cancelling = tick(new RedisWorkspaceRequests(redis, bridge));
  const marker = `codeapi:bridge:v1:assignment:${stored.assignmentId}:cancelled`;
  const limit = Date.now() + 1000;
  try {
    while (await redis.get(marker) !== '1') {
      if (Date.now() >= limit) throw new Error('Read-only worker was never notified');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await requests.get(owner, requestId))?.state).toBe('admitted');
    assignment ??= await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slot);
    expect(assignment).toBeDefined();
    expect(await bridge.cancelled(workerId, incarnationId, assignment!.assignmentId)).toBe(true);
    await settle(assignment!, false);
    await cancelling;
    expect(await requests.get(owner, requestId)).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(await redis.zcard(activeKey)).toBe(0);
  } finally { await cancelling; }
});

test.each([1, 2])('a durable read cancellation remains cancelled without worker settlement (slots=%s)', async slots => {
  const requests = await setup(slots); await submit(requests); await tick(requests);
  const key = (await redis.zrange(activeKey, 0, -1))[0];
  const stored = JSON.parse((await redis.hget(key, 'assignment'))!);
  await requests.cancel(owner, requestId);
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect(await redis.get(`codeapi:bridge:v1:assignment:${stored.assignmentId}:cancelled`)).toBe('1');
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'cancelled', cancelRequested: true });
  expect((await requests.get(owner, requestId))?.error).toBeUndefined();
  expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0)).toBeUndefined();
  expect(await redis.zcard(activeKey)).toBe(0);
  await submit(requests, 'request-00000000002'); await tick(requests);
  expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slots === 1 ? undefined : 0)).toBeDefined();
}, 10_000);

test('fulfillment racing durable read cancellation keeps the winning result', async () => {
  const requests = await setup(); await submit(requests); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await requests.cancel(owner, requestId);
  const cancelling = tick(requests);
  const marker = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:cancelled`;
  const limit = Date.now() + 1000;
  try {
    while (await redis.get(marker) !== '1') {
      if (Date.now() >= limit) throw new Error('Read-only worker was never notified');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await settle(assignment);
    await cancelling;
    expect(await requests.get(owner, requestId)).toMatchObject({ state: 'completed', result: { content: 'hello' } });
  } finally { await cancelling; }
});

test('queued workspace metadata also permits a same-incarnation return to serial admission', async () => {
  const requests = await setup(2); await submit(requests); await setup(); await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  expect(assignment).toBeDefined();
  expect(assignment.workspaceLeaseSlot).toBeUndefined();
  await settle(assignment); await tick(requests);
  expect((await requests.get(owner, requestId))?.state).toBe('completed');
});

test('unconfirmed durable mutation cancellation still reports an unknown outcome and retains its fence', async () => {
  const requests = await setup();
  await requests.submit({ owner, requestId, workerId, requireTenantBinding: false,
    request: { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary', command: 'sleep 30' },
    queueWaitMs: 300_000, executionTimeoutMs: 35_000,
  });
  await tick(requests);
  const assignment = (await bridge.lease(workerId, incarnationId, 0))!;
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId, assignment.generation, assignment.leaseToken);
  await requests.cancel(owner, requestId); await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({
    state: 'failed', cancelRequested: true, error: { code: 'ASSIGNMENT_EXPIRED' },
  });
  const fence = `codeapi:bridge:v1:worker:${workerId}:workspace:${createHash('sha256').update('native-workspace:primary').digest('hex')}:quarantined`;
  expect(await redis.get(fence)).toBe(assignment.assignmentId);
}, 10_000);

const lane = { workspaceId: 'primary', worktree: 'review' };

function fenceKey(fence: string): string {
  return `codeapi:bridge:v1:worker:${workerId}:workspace:${createHash('sha256').update(fence).digest('hex')}:quarantined`;
}

const laneFence = fenceKey('native-workspace:\0linked-worktree\0primary\0review');

function submitLane(requests: RedisWorkspaceRequests, id: string, request: Partial<WorkspaceToolRequest>): ReturnType<RedisWorkspaceRequests['submit']> {
  return requests.submit({ owner, requestId: id, workerId, requireTenantBinding: false,
    request: { protocolVersion: 1, ...lane, ...request } as WorkspaceToolRequest,
    queueWaitMs: 300_000, executionTimeoutMs: 30_000,
  });
}

async function leaseAnySlot(): Promise<CodeBridgeAssignment | undefined> {
  for (const slot of [0, 1]) {
    const assignment = await bridge.lease(workerId, incarnationId, 0, undefined, undefined, slot);
    if (assignment != null) return assignment;
  }
  return undefined;
}

function rejection(assignment: CodeBridgeAssignment, error: string): BridgeRejectedSettlement {
  return { protocolVersion: 1 as const, incarnationId, generation: assignment.generation,
    leaseToken: assignment.leaseToken, status: 'rejected' as const, error };
}

test('a rejected lane releases its fence even when its cleanup acknowledgement is lost', async () => {
  const requests = await setup(2, true);
  await submitLane(requests, requestId, { operation: 'execute_command', command: 'git status' });
  await submitLane(requests, 'request-00000000002', { operation: 'list_files' });
  await tick(requests);
  const refused = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  expect(await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 1)).toBeUndefined();
  await bridge.acknowledgeLease(workerId, incarnationId, refused.assignmentId, refused.generation, refused.leaseToken);
  // The worker refuses a lane that does not exist, then stops before acknowledging local cleanup.
  await bridge.settle(workerId, refused.assignmentId, {
    ...rejection(refused, 'No linked worktree named review in .worktrees'), errorCode: 'INVALID_REQUEST',
  });
  expect(await redis.get(laneFence)).toBeNull();
  await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'failed', error: { code: 'INVALID_REQUEST' } });

  await tick(requests);
  const queued = (await leaseAnySlot())!;
  expect(queued.request).toMatchObject({ operation: 'list_files', worktree: 'review' });
  // A late acknowledgement for the refused assignment never releases the lane's next owner.
  await expect(bridge.confirmWorkspaceCleanup(workerId, refused.assignmentId,
    rejection(refused, 'local cleanup confirmed'))).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
  expect(await redis.get(laneFence)).toBe(queued.assignmentId);
  await settle(queued, false); await tick(requests);
  expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('failed');

  await submit(requests, 'request-00000000003'); await tick(requests);
  const checkout = (await leaseAnySlot())!;
  expect(checkout.request).toMatchObject({ operation: 'read_file', workspaceId: 'primary' });
  expect((checkout.request as WorkspaceToolRequest).worktree).toBeUndefined();
});

test.each(['quarantined after rejection', 'interrupted'])('an uncertain lane outcome still fences the lane and its checkout (%s)', async outcome => {
  const requests = await setup(2, true);
  await submitLane(requests, requestId, { operation: 'execute_command', command: 'git status' });
  await tick(requests);
  const assignment = (await leaseAnySlot())!;
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId, assignment.generation, assignment.leaseToken);
  if (outcome === 'interrupted') {
    const key = (await redis.zrange(activeKey, 0, -1))[0];
    const stored = JSON.parse((await redis.hget(key, 'assignment'))!);
    stored.expiresAt = new Date(Date.now() - 1).toISOString();
    await redis.hset(key, 'assignment', JSON.stringify(stored));
  } else {
    // The settlement commits, but the worker cannot clear its local guard and reports the lane instead.
    await bridge.settle(workerId, assignment.assignmentId, rejection(assignment, 'Command failed atomically'));
    await bridge.settle(workerId, assignment.assignmentId, rejection(assignment, 'Workspace requires inspection before reset.'),
      undefined, undefined, true);
  }
  await tick(new RedisWorkspaceRequests(redis, bridge));
  expect((await requests.get(owner, requestId))?.state).toBe('failed');
  expect(await redis.get(laneFence)).toBe(
    outcome === 'interrupted' ? assignment.assignmentId : `quarantined:${assignment.assignmentId}`,
  );

  // Simulate execution-ownership TTL expiry. The lane fence outlives the reservation.
  await redis.del(`codeapi:bridge:v1:worker:${workerId}:workspace-slots`,
    `codeapi:bridge:v1:worker:${workerId}:lock`, `codeapi:bridge:v1:worker:${workerId}:lock:incarnation`);
  await submit(requests, 'request-00000000002'); await tick(requests);
  expect(await requests.get(owner, 'request-00000000002')).toMatchObject({
    state: 'failed', error: { code: 'WORKSPACE_QUARANTINED' },
  });
});

async function completeCommand(assignment: CodeBridgeAssignment): Promise<void> {
  await bridge.acknowledgeLease(workerId, incarnationId, assignment.assignmentId,
    assignment.generation, assignment.leaseToken);
  await bridge.settle(workerId, assignment.assignmentId, {
    protocolVersion: 1, incarnationId, generation: assignment.generation, leaseToken: assignment.leaseToken,
    status: 'fulfilled', result: { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary',
      exitCode: 0, stdout: assignment.assignmentId, stderr: '', truncated: false, timedOut: false },
  });
  await bridge.confirmWorkspaceCleanup(workerId, assignment.assignmentId, rejection(assignment, 'local cleanup confirmed'));
}

test('a durable detached command runs beside its lane and settles independently', async () => {
  const requests = await setup(2, true, true);
  await submitLane(requests, requestId, { operation: 'execute_command', command: 'git status' });
  await submitLane(requests, 'request-00000000002', { operation: 'execute_command', command: 'npm test', detached: true });
  await submitLane(requests, 'request-00000000003', { operation: 'list_files' });
  await tick(requests); await tick(requests);
  const ordinary = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  const background = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 1))!;
  expect(ordinary.request).toMatchObject({ command: 'git status', worktree: 'review' });
  expect(background.request).toMatchObject({ command: 'npm test', worktree: 'review', detached: true });
  expect(background.assignmentId.startsWith('durable-')).toBe(true);
  expect((await requests.get(owner, 'request-00000000003'))?.state).toBe('queued');

  const detachedFence = fenceKey(`native-workspace:${workspaceDetachedCommandKey(background.assignmentId)}`);
  expect(await redis.get(laneFence)).toBe(ordinary.assignmentId);
  expect(await redis.get(detachedFence)).toBe(background.assignmentId);
  expect(await redis.ttl(laneFence)).toBe(-1);
  const fenceTtl = await redis.ttl(detachedFence);
  expect(fenceTtl).toBeGreaterThan(23 * 60 * 60);
  expect(fenceTtl).toBeLessThanOrEqual(24 * 60 * 60);

  await completeCommand(ordinary); await tick(requests);
  expect(await requests.get(owner, requestId)).toMatchObject({ state: 'completed', result: { stdout: ordinary.assignmentId } });
  expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('admitted');
  await tick(requests);
  const queued = (await bridge.lease(workerId, incarnationId, 0, undefined, undefined, 0))!;
  expect(queued.request).toMatchObject({ operation: 'list_files', worktree: 'review' });
  expect(await redis.get(laneFence)).toBe(queued.assignmentId);
  expect(await redis.get(detachedFence)).toBe(background.assignmentId);

  await completeCommand(background); await tick(requests);
  expect(await requests.get(owner, 'request-00000000002')).toMatchObject({ state: 'completed', result: { stdout: background.assignmentId } });
  expect(await redis.exists(detachedFence)).toBe(0);
  expect(await redis.get(laneFence)).toBe(queued.assignmentId);
});

test('a durable detached command is refused for a worker that does not advertise the feature', async () => {
  const requests = await setup(2, true);
  await expect(submitLane(requests, requestId, { operation: 'execute_command', command: 'npm test', detached: true }))
    .rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await redis.zcard(queueKey)).toBe(0);
});

test.each(['active', 'completed', 'quarantined'].flatMap(state =>
  [false, true].map(legacyReceipt => [state, legacyReceipt] as const),
))(
  'late quarantine from a rejected lane cannot replace its %s successor (legacy receipt=%s)', async (state, legacyReceipt) => {
    const requests = await setup(2, true);
    await submitLane(requests, requestId, { operation: 'execute_command', command: 'git status' });
    await submitLane(requests, 'request-00000000002', { operation: 'list_files' });
    await tick(requests);
    const refused = (await leaseAnySlot())!;
    await bridge.acknowledgeLease(workerId, incarnationId, refused.assignmentId, refused.generation, refused.leaseToken);
    await bridge.settle(workerId, refused.assignmentId, rejection(refused, 'No linked worktree'));
    if (legacyReceipt) {
      // Receipts from before per-assignment epochs must also lose authority.
      await redis.hset(`codeapi:bridge:v1:assignment:${refused.assignmentId}:workspace-fence-owner`, 'epoch', '0');
      await redis.set(`${laneFence}:epoch`, '0', 'PX', await redis.pttl(`${laneFence}:epoch`));
    }
    await tick(requests); await tick(requests);
    const successor = (await leaseAnySlot())!;
    expect(await redis.get(laneFence)).toBe(successor.assignmentId);
    if (state === 'completed') {
      await settle(successor, false); await tick(requests);
    } else if (state === 'quarantined') {
      await bridge.settle(workerId, successor.assignmentId, rejection(successor, 'Workspace requires inspection'),
        undefined, undefined, true);
    }
    const fence = await redis.get(laneFence);
    expect(fence).toBe(state === 'completed' ? null : state === 'quarantined'
      ? `quarantined:${successor.assignmentId}` : successor.assignmentId);
    await expect(bridge.settle(workerId, refused.assignmentId, rejection(refused, 'Late quarantine'),
      undefined, undefined, true)).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
    expect(await redis.get(laneFence)).toBe(fence);
    await expect(bridge.confirmWorkspaceCleanup(workerId, refused.assignmentId,
      rejection(refused, 'Late cleanup'))).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
    expect(await redis.get(laneFence)).toBe(fence);
    if (state === 'active') {
      await settle(successor, false); await tick(requests);
      expect((await requests.get(owner, 'request-00000000002'))?.state).toBe('failed');
    }
  },
);
