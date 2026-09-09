import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisBridgeStore } from './store';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import type { CodeBridgeAssignment } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis, 60, 1000, 2);
const workerId = 'concurrent-worker';
const incarnationId = 'concurrent-incarnation';
afterEach(async () => {
  await redis.flushall();
});
async function register(workspaceLeaseSlots = 2) {
  const generation = await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId,
    incarnationId,
    capabilities: {
      statefulWorkspace: false,
      runtimes: [],
      sandboxProfile: 'native-srt',
      requiresReadyConfirmation: true,
      workspaceLeaseSlots,
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file'],
        workspaces: [{ id: 'a' }, { id: 'b' }],
      },
    },
  });
  await store.confirmReady(workerId, incarnationId, generation);
}
function dispatch(workspaceId: string, signal = new AbortController().signal) {
  const promise = store.dispatchWorkspaceTool({
    workerId,
    signal,
    deadlineAtMs: Date.now() + 3000,
    request: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId,
      path: 'file.txt',
    },
  });
  void promise.catch(() => undefined);
  return promise;
}
async function settle(assignment: CodeBridgeAssignment) {
  await store.acknowledgeLease(
    workerId,
    incarnationId,
    assignment.assignmentId,
    assignment.generation,
    assignment.leaseToken,
  );
  await store.settle(workerId, assignment.assignmentId, {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    incarnationId,
    generation: assignment.generation,
    leaseToken: assignment.leaseToken,
    status: 'rejected',
    error: 'fixture clean rejection',
  });
}
test('store routes simultaneous roots through separate acknowledged slots', async () => {
  await register();
  const a = dispatch('a');
  const b = dispatch('b');
  const first = await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  );
  const second = await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    1,
  );
  expect(first?.workspaceLeaseSlot).toBe(0);
  expect(second?.workspaceLeaseSlot).toBe(1);
  expect(first?.assignmentId).not.toBe(second?.assignmentId);
  await settle(first!);
  await settle(second!);
  await expect(a).resolves.toMatchObject({ status: 'rejected' });
  await expect(b).resolves.toMatchObject({ status: 'rejected' });
  expect(
    await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`),
  ).toBeNull();
});

test('a replica never dispatches above its own configured ceiling', async () => {
  await register();
  const serialReplica = new RedisBridgeStore(redis, 60, 1000, 1);
  await expect(
    serialReplica.dispatchWorkspaceTool({
      workerId,
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1000,
      request: {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'a',
        path: 'file.txt',
      },
    }),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  await expect(
    serialReplica.lease(workerId, incarnationId, 0, undefined, undefined, 1),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(
    await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`),
  ).toBeNull();
});

test('capacity changes require the active slots to drain', async () => {
  await register();
  const pending = dispatch('a');
  const assignment = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  await expect(register(1)).rejects.toMatchObject({ code: 'WORKER_BUSY' });
  await settle(assignment);
  await pending;
  await register(1);
  expect(
    (await store.workerStatus(workerId)).capabilities?.workspaceLeaseSlots,
  ).toBe(1);
});

test('same-root work waits while another root progresses', async () => {
  await register();
  const a = dispatch('a');
  const first = await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  );
  const nextA = dispatch('a');
  const b = dispatch('b');
  const second = await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    1,
  );
  expect(second?.request).toMatchObject({ workspaceId: 'b' });
  await settle(first!);
  await a;
  const third = await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  );
  expect(third?.request).toMatchObject({ workspaceId: 'a' });
  await settle(second!);
  await settle(third!);
  await Promise.all([nextA, b]);
});

test('queued cancellation never leases and does not block another root', async () => {
  await register();
  const a = dispatch('a');
  const first = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  const controller = new AbortController();
  const cancelled = dispatch('a', controller.signal);
  const queue = `codeapi:bridge:v1:worker:${workerId}:admission`;
  for (let i = 0; i < 100 && (await redis.zcard(queue)) < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await redis.zcard(queue)).toBe(2);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  const b = dispatch('b');
  const second = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    1,
  ))!;
  expect(second.request).toMatchObject({ workspaceId: 'b' });
  await settle(first);
  await settle(second);
  await Promise.all([a, b]);
  expect(
    await store.lease(workerId, incarnationId, 0, undefined, undefined, 0),
  ).toBeUndefined();
});

test('late quarantine releases its slot after caller cancellation and retains only its root fence', async () => {
  await register();
  const controller = new AbortController();
  const a = dispatch('a', controller.signal);
  const first = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  await store.acknowledgeLease(
    workerId,
    incarnationId,
    first.assignmentId,
    first.generation,
    first.leaseToken,
  );
  controller.abort();
  await expect(a).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  await store.settle(
    workerId,
    first.assignmentId,
    {
      protocolVersion: 1,
      incarnationId,
      generation: first.generation,
      leaseToken: first.leaseToken,
      status: 'rejected',
      error: 'uncertain mutation',
    },
    undefined,
    undefined,
    true,
  );
  expect(
    await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`),
  ).toBeNull();
  const b = dispatch('b');
  const next = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  expect(next.request).toMatchObject({ workspaceId: 'b' });
  await settle(next);
  await b;
  await expect(dispatch('a')).rejects.toMatchObject({
    code: 'WORKSPACE_QUARANTINED',
  });
});

test('post-settlement fences are authenticated, idempotent, and invalidated by reset', async () => {
  await register();
  const pending = dispatch('a');
  const assignment = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  await settle(assignment);
  await pending; // Normal dispatch cleanup has removed the full assignment.
  const receiptKey = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:workspace-fence-owner`;
  expect(await redis.ttl(receiptKey)).toBeGreaterThan(0);
  expect(
    JSON.parse((await redis.hget(receiptKey, 'metadata'))!),
  ).not.toHaveProperty('request');
  const resultKey = `codeapi:bridge:v1:assignment:${assignment.assignmentId}:settlement`;
  const originalResult = await redis.get(resultKey);
  const intent = {
    protocolVersion: 1 as const,
    incarnationId,
    generation: assignment.generation,
    leaseToken: assignment.leaseToken,
    status: 'rejected' as const,
    error: 'local cleanup failed after commit',
  };
  await expect(
    store.settle(
      workerId,
      assignment.assignmentId,
      { ...intent, leaseToken: 'forged' },
      undefined,
      undefined,
      true,
    ),
  ).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
  await expect(
    store.settle(
      workerId,
      assignment.assignmentId,
      intent,
      undefined,
      'different-principal',
      true,
    ),
  ).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
  await store.settle(
    workerId,
    assignment.assignmentId,
    intent,
    undefined,
    undefined,
    true,
  );
  await store.settle(
    workerId,
    assignment.assignmentId,
    intent,
    undefined,
    undefined,
    true,
  );
  expect(await redis.get(resultKey)).toBe(originalResult);
  await expect(dispatch('a')).rejects.toMatchObject({
    code: 'WORKSPACE_QUARANTINED',
  });
  await store.resetWorkspace(workerId, incarnationId, 'native-workspace:a');
  await expect(
    store.settle(
      workerId,
      assignment.assignmentId,
      intent,
      undefined,
      undefined,
      true,
    ),
  ).rejects.toMatchObject({ code: 'ASSIGNMENT_FENCED' });
  const next = dispatch('a');
  const nextAssignment = (await store.lease(
    workerId,
    incarnationId,
    1000,
    undefined,
    undefined,
    0,
  ))!;
  await settle(nextAssignment);
  await next;
});
