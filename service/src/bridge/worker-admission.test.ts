import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';
import type { CodeBridgeAssignment } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis);
const workerId = 'admission-worker';
const incarnationId = 'incarnation-00000001';
afterEach(async () => {
  await redis.flushall();
});

async function register(
  operations: Array<'read_file' | 'list_files'> = ['read_file'],
): Promise<void> {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId,
    incarnationId,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'native-srt',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations,
        workspaces: [{ id: 'primary', name: 'Workspace' }],
      },
    },
  });
}

function dispatch(
  path: string,
  controller = new AbortController(),
  budgetMs = 5000,
  executionTimeoutMs?: number,
): ReturnType<RedisBridgeStore['dispatchWorkspaceTool']> {
  return store.dispatchWorkspaceTool({
    workerId,
    signal: controller.signal,
    deadlineAtMs: Date.now() + budgetMs,
    executionTimeoutMs,
    request: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId: 'primary',
      path,
    },
  });
}

async function settle(
  assignment: CodeBridgeAssignment | undefined,
): Promise<void> {
  expect(assignment).toBeDefined();
  await store.settle(workerId, assignment!.assignmentId, {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    incarnationId,
    generation: assignment!.generation,
    leaseToken: assignment!.leaseToken,
    status: 'rejected',
    error: 'File not found',
  });
}

test('a second workspace call waits until the first settles instead of returning WORKER_BUSY', async () => {
  await register();
  const first = dispatch('first');
  const assignment = await store.lease(workerId, incarnationId, 1000);
  const second = dispatch('second');
  await settle(assignment);
  await first;
  const next = await store.lease(workerId, incarnationId, 1000);
  expect(next?.request).toMatchObject({ path: 'second' });
  await settle(next);
  await expect(second).resolves.toMatchObject({
    status: 'rejected',
    error: 'File not found',
  });
});

test('cancelling a waiting caller does not release or cancel the active assignment', async () => {
  await register();
  const first = dispatch('first');
  const assignment = await store.lease(workerId, incarnationId, 1000);
  const controller = new AbortController();
  const second = dispatch('second', controller);
  void second.catch(() => undefined);
  const waitDeadline = Date.now() + 1000;
  while (
    (await redis.zcard(`codeapi:bridge:v1:worker:${workerId}:admission`)) < 2
  ) {
    if (Date.now() >= waitDeadline)
      throw new Error('Second caller never entered admission');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await expect(second).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  expect(await redis.get(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBe(
    assignment!.assignmentId,
  );
  await settle(assignment);
  await first;
  expect(await store.lease(workerId, incarnationId, 50)).toBeUndefined();
});

test('an expired queued call never reaches the worker and does not strand later calls', async () => {
  await register();
  const first = dispatch('first');
  const assignment = await store.lease(workerId, incarnationId, 1000);
  await expect(
    dispatch('expired', new AbortController(), 25, 1000),
  ).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
  const third = dispatch('third');
  await settle(assignment);
  await first;
  const next = await store.lease(workerId, incarnationId, 1000);
  expect(next?.request).toMatchObject({ path: 'third' });
  await settle(next);
  await third;
});

test('a queued request is rejected if the worker withdraws its capability', async () => {
  await register();
  const first = dispatch('first');
  const assignment = await store.lease(workerId, incarnationId, 1000);
  const second = dispatch('second');
  void second.catch(() => undefined);
  const deadline = Date.now() + 1000;
  while (
    (await redis.zcard(`codeapi:bridge:v1:worker:${workerId}:admission`)) < 2
  ) {
    if (Date.now() > deadline)
      throw new Error('Second caller did not enter admission');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await register(['list_files']);
  await settle(assignment);
  await first;
  await expect(second).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await store.lease(workerId, incarnationId, 50)).toBeUndefined();
});

test('execution receives a fresh budget after waiting and the lock covers long commands', async () => {
  await register();
  const first = dispatch('first');
  const active = await store.lease(workerId, incarnationId, 1000);
  const second = dispatch('second', new AbortController(), 1000, 305_000);
  await new Promise(resolve => setTimeout(resolve, 150));
  await settle(active);
  await first;
  const next = await store.lease(workerId, incarnationId, 1000);
  expect(next).toBeDefined();
  expect(Date.parse(next!.expiresAt) - Date.now()).toBeGreaterThan(304_000);
  expect(await redis.pttl(`codeapi:bridge:v1:worker:${workerId}:lock`)).toBeGreaterThan(305_000);
  await settle(next);
  await second;
});

test('execution expires independently of an unused queue allowance', async () => {
  await register();
  const completion = dispatch('short', new AbortController(), 5000, 150);
  void completion.catch(() => undefined);
  const assignment = await store.lease(workerId, incarnationId, 1000);
  expect(assignment).toBeDefined();
  expect(Date.parse(assignment!.expiresAt) - Date.now()).toBeLessThanOrEqual(150);
  await expect(completion).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
});
