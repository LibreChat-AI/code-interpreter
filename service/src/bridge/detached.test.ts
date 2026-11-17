import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import Redis from 'ioredis';
import { RedisBridgeStore } from './store';
import {
  BRIDGE_PROTOCOL_VERSION,
  workspaceDetachedCommandKey,
  workspaceIsolationKey,
} from '../../../packages/code/src/protocol';
import type { CodeBridgeAssignment } from './store';
import type {
  BridgeRejectedSettlement,
  WorkspaceCommandFeature,
  WorkspaceExecuteCommandRequest,
  WorkspaceToolRequest,
} from '../../../packages/code/src/protocol';

const testRedisUrl = process.env.BRIDGE_TEST_REDIS_URL;
const redis = testRedisUrl !== undefined && testRedisUrl.length > 0
  ? new Redis(testRedisUrl)
  : new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis, 60, 1000, 3);
const workerId = 'detached-worker';
const incarnationId = 'detached-incarnation';
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];

// Only a disposable test Redis may be supplied.
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(pending.splice(0));
  await redis.flushall();
});

async function register(
  commandFeatures: WorkspaceCommandFeature[] = ['detached'],
  bridge = store,
  workspaceLeaseSlots = 3,
): Promise<void> {
  const generation = await bridge.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId,
    incarnationId,
    capabilities: {
      statefulWorkspace: false,
      runtimes: [],
      sandboxProfile: 'native-srt',
      ...(workspaceLeaseSlots > 1 ? { requiresReadyConfirmation: true, workspaceLeaseSlots } : {}),
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file', 'execute_command'],
        workspaces: [{ id: 'repo', workspaceScopes: ['git_linked_worktree'] }],
        ...(commandFeatures.length === 0 ? {} : { commandFeatures }),
      },
    },
  });
  if (workspaceLeaseSlots > 1) await bridge.confirmReady(workerId, incarnationId, generation);
}

const command = (
  request: Partial<WorkspaceExecuteCommandRequest> = {},
): WorkspaceExecuteCommandRequest => ({
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  operation: 'execute_command',
  workspaceId: 'repo',
  worktree: 'task-a',
  command: 'npm test',
  ...request,
});

function dispatch(request: WorkspaceToolRequest, bridge = store): Promise<unknown> {
  const controller = new AbortController();
  controllers.push(controller);
  const result = bridge.dispatchWorkspaceTool({
    workerId,
    signal: controller.signal,
    deadlineAtMs: Date.now() + 3000,
    executionTimeoutMs: 5000,
    request,
  });
  void result.catch(() => undefined);
  pending.push(result);
  return result;
}

async function lease(slot: number, waitMs = 2000): Promise<CodeBridgeAssignment | undefined> {
  const assignment = await store.lease(workerId, incarnationId, waitMs, undefined, undefined, slot);
  if (assignment != null) {
    await store.acknowledgeLease(
      workerId,
      incarnationId,
      assignment.assignmentId,
      assignment.generation,
      assignment.leaseToken,
    );
  }
  return assignment;
}

function rejection(assignment: CodeBridgeAssignment, error: string): BridgeRejectedSettlement {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    incarnationId,
    generation: assignment.generation,
    leaseToken: assignment.leaseToken,
    status: 'rejected',
    error,
  };
}

async function fulfil(assignment: CodeBridgeAssignment): Promise<void> {
  await store.settle(workerId, assignment.assignmentId, {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    incarnationId,
    generation: assignment.generation,
    leaseToken: assignment.leaseToken,
    status: 'fulfilled',
    result: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'execute_command',
      workspaceId: 'repo',
      exitCode: 0,
      stdout: assignment.assignmentId,
      stderr: '',
      truncated: false,
      timedOut: false,
    },
  });
}

const confirmCleanup = (assignment: CodeBridgeAssignment): Promise<void> =>
  store.confirmWorkspaceCleanup(
    workerId,
    assignment.assignmentId,
    rejection(assignment, 'local cleanup confirmed'),
  );

function fenceKey(isolationKey: string): string {
  const hash = createHash('sha256').update(`native-workspace:${isolationKey}`).digest('hex');
  return `codeapi:bridge:v1:worker:${workerId}:workspace:${hash}:quarantined`;
}

const laneFence = fenceKey(workspaceIsolationKey('repo', undefined, 'task-a'));
const checkoutFence = fenceKey('repo');
const detachedFence = (assignment: CodeBridgeAssignment): string =>
  fenceKey(workspaceDetachedCommandKey(assignment.assignmentId));
const isDetached = (assignment: CodeBridgeAssignment | undefined): boolean =>
  (assignment?.request as WorkspaceExecuteCommandRequest | undefined)?.detached === true;

for (const detachedFirst of [true, false]) {
  test(`a detached command and its lane's ordinary work overlap and settle independently (detached ${detachedFirst ? 'first' : 'second'})`, async () => {
    await register();
    const requests = [command({ detached: true }), command({ command: 'git status' })];
    const [first, second] = detachedFirst ? requests : [...requests].reverse();
    const firstResult = dispatch(first);
    const firstAssignment = (await lease(0))!;
    const secondResult = dispatch(second);
    const secondAssignment = (await lease(1))!;
    expect(isDetached(firstAssignment)).toBe(detachedFirst);
    expect(isDetached(secondAssignment)).toBe(!detachedFirst);
    const background = detachedFirst ? firstAssignment : secondAssignment;
    const ordinary = detachedFirst ? secondAssignment : firstAssignment;

    expect(await redis.get(laneFence)).toBe(ordinary.assignmentId);
    expect(await redis.get(detachedFence(background))).toBe(background.assignmentId);
    expect(await redis.ttl(laneFence)).toBe(-1);
    const fenceTtl = await redis.ttl(detachedFence(background));
    expect(fenceTtl).toBeGreaterThan(0);
    expect(fenceTtl).toBeLessThanOrEqual(35);

    await fulfil(ordinary);
    await confirmCleanup(ordinary);
    await expect(detachedFirst ? secondResult : firstResult).resolves.toMatchObject({
      status: 'fulfilled',
      result: { stdout: ordinary.assignmentId },
    });
    expect(await redis.get(detachedFence(background))).toBe(background.assignmentId);

    const queued = dispatch(command({ command: 'git diff' }));
    const next = (await lease(detachedFirst ? 1 : 0))!;
    expect(isDetached(next)).toBe(false);
    expect(await redis.get(laneFence)).toBe(next.assignmentId);

    await fulfil(background);
    await confirmCleanup(background);
    await expect(detachedFirst ? firstResult : secondResult).resolves.toMatchObject({
      status: 'fulfilled',
      result: { stdout: background.assignmentId },
    });
    expect(await redis.exists(detachedFence(background))).toBe(0);
    expect(await redis.get(laneFence)).toBe(next.assignmentId);

    await fulfil(next);
    await confirmCleanup(next);
    await expect(queued).resolves.toMatchObject({ status: 'fulfilled' });
    expect(await redis.exists(laneFence)).toBe(0);
  });
}

test('a detached command also overlaps work in its parent checkout', async () => {
  await register();
  const checkout = dispatch(command({ worktree: undefined, command: 'git worktree list' }));
  const held = (await lease(0))!;
  const background = dispatch(command({ detached: true }));
  const admitted = (await lease(1))!;
  expect(isDetached(admitted)).toBe(true);
  expect(await redis.get(checkoutFence)).toBe(held.assignmentId);
  expect(await redis.exists(laneFence)).toBe(0);
  await fulfil(admitted);
  await confirmCleanup(admitted);
  await fulfil(held);
  await confirmCleanup(held);
  await expect(background).resolves.toMatchObject({ status: 'fulfilled' });
  await expect(checkout).resolves.toMatchObject({ status: 'fulfilled' });
});

test('a detached request is refused unless the worker advertises the feature with spare slots', async () => {
  await register([]);
  await expect(dispatch(command({ detached: true }))).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  const ordinary = dispatch(command());
  const assignment = (await lease(0))!;
  await fulfil(assignment);
  await confirmCleanup(assignment);
  await expect(ordinary).resolves.toMatchObject({ status: 'fulfilled' });

  await redis.flushall();
  await register(['detached'], store, 1);
  await expect(dispatch(command({ detached: true }))).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
});

test('a replica that opted out refuses detached requests for an advertising worker', async () => {
  await register();
  const optedOut = new RedisBridgeStore(redis, 60, 1000, 3, false, false);
  expect(optedOut.detachedCommandsOffered).toBe(false);
  expect(store.detachedCommandsOffered).toBe(true);
  expect(new RedisBridgeStore(redis, 60, 1000, 1).detachedCommandsOffered).toBe(false);
  await expect(dispatch(command({ detached: true }), optedOut)).rejects.toMatchObject({
    code: 'WORKER_MISMATCH',
  });
});

test('a quarantine receipt for a detached command expires and leaves its lane usable', async () => {
  await register();
  const background = dispatch(command({ detached: true }));
  const assignment = (await lease(0))!;
  await store.settle(
    workerId,
    assignment.assignmentId,
    rejection(assignment, 'Workspace requires inspection before reset.'),
    undefined,
    undefined,
    true,
  );
  await expect(background).resolves.toMatchObject({ status: 'rejected' });
  expect(await redis.get(detachedFence(assignment))).toBe(`quarantined:${assignment.assignmentId}`);
  const receiptTtl = await redis.ttl(detachedFence(assignment));
  expect(receiptTtl).toBeGreaterThan(0);
  expect(receiptTtl).toBeLessThanOrEqual(35);
  expect(await redis.exists(laneFence)).toBe(0);

  const ordinary = dispatch(command({ command: 'git status' }));
  const next = (await lease(0))!;
  expect(isDetached(next)).toBe(false);
  await store.settle(
    workerId,
    next.assignmentId,
    rejection(next, 'Workspace requires inspection before reset.'),
    undefined,
    undefined,
    true,
  );
  await expect(ordinary).resolves.toMatchObject({ status: 'rejected' });
  expect(await redis.get(laneFence)).toBe(`quarantined:${next.assignmentId}`);
  expect(await redis.ttl(laneFence)).toBe(-1);
});

for (const quarantined of ['lane', 'checkout'] as const) {
  test(`a detached command is refused while its ${quarantined} is quarantined`, async () => {
    await register();
    await redis.set(quarantined === 'lane' ? laneFence : checkoutFence, 'quarantined:earlier');
    await expect(dispatch(command({ detached: true }))).rejects.toMatchObject({
      code: 'WORKSPACE_QUARANTINED',
    });
    expect(await redis.keys(`codeapi:bridge:v1:worker:${workerId}:workspace:*:quarantined`)).toHaveLength(1);
  });
}

test('detached commands never take the last slot', async () => {
  await register();
  const results = ['one', 'two', 'three'].map((name) =>
    dispatch(command({ detached: true, command: name })),
  );
  const first = (await lease(0))!;
  const second = (await lease(1))!;
  expect(await lease(2, 300)).toBeUndefined();
  const ordinary = dispatch(command({ command: 'git status' }));
  const third = (await lease(2))!;
  expect(isDetached(third)).toBe(false);
  for (const assignment of [first, second, third]) {
    await fulfil(assignment);
    await confirmCleanup(assignment);
  }
  const capped = (await lease(0))!;
  expect(isDetached(capped)).toBe(true);
  await fulfil(capped);
  await confirmCleanup(capped);
  await expect(Promise.all([...results, ordinary])).resolves.toHaveLength(4);
});
