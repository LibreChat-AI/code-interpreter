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
async function register() {
  const generation = await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId,
    incarnationId,
    capabilities: {
      statefulWorkspace: false,
      runtimes: [],
      sandboxProfile: 'native-srt',
      requiresReadyConfirmation: true,
      workspaceLeaseSlots: 2,
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
