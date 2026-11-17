import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BridgeAdmissionQueue } from './admission';
import { BridgeWorkspaceSlots } from './slots';
import { workspaceDetachedCommandKey, workspaceIsolationKey } from '../../../packages/code/src/protocol';

const redis = new RedisMock() as unknown as Redis;
const admission = new BridgeAdmissionQueue(redis);
const slots = new BridgeWorkspaceSlots(redis);
const workerId = 'slot-worker';
const incarnationId = 'slot-incarnation';
const prefix = `codeapi:bridge:v1:worker:${workerId}`;
afterEach(async () => {
  await redis.flushall();
});
async function enqueue(assignmentId: string, workspaceId: string, capacity = 2) {
  await redis.set(`${prefix}:incarnation`, incarnationId);
  await redis.set(`${prefix}:workspace-slot-capacity`, String(capacity));
  await admission.enter(workerId, assignmentId, Date.now() + 5000, workspaceId);
  return {
    workerId,
    incarnationId,
    assignmentId,
    workspaceId,
    capacity,
    expiresAtMs: Date.now() + 10000,
  };
}

async function finish(assignmentId: string) {
  await slots.release(workerId, incarnationId, assignmentId);
  await admission.leave(workerId, assignmentId);
}

const lane = (name: string, parent = 'repo') => workspaceIsolationKey(parent, undefined, name);
const detached = (assignmentId: string, capacity = 3): ReturnType<typeof enqueue> =>
  enqueue(assignmentId, workspaceDetachedCommandKey(assignmentId), capacity);

test('slots admit independent workspaces, skip a busy root, and bound capacity', async () => {
  const a = await enqueue('a', 'root-a');
  const a2 = await enqueue('a2', 'root-a');
  const b = await enqueue('b', 'root-b');
  const c = await enqueue('c', 'root-c');
  expect(await slots.reserve(b)).toBeUndefined();
  expect(await slots.reserve(a)).toBe(0);
  expect(await slots.reserve(a2)).toBeUndefined();
  expect(await slots.reserve(b)).toBe(1);
  expect(await slots.reserve(c)).toBeUndefined();
  expect(await slots.reserve(a)).toBe(0);
  await slots.release(workerId, incarnationId, 'a');
  await admission.leave(workerId, 'a');
  expect(await slots.reserve(c)).toBeUndefined();
  expect(await slots.reserve(a2)).toBe(0);
});

test('stale slot release cannot erase replacement reservation or aggregate lock', async () => {
  const a = await enqueue('a', 'root-a');
  expect(await slots.reserve(a)).toBe(0);
  await slots.release(workerId, incarnationId, 'a');
  await admission.leave(workerId, 'a');
  const b = await enqueue('b', 'root-b');
  expect(await slots.reserve(b)).toBe(0);
  await slots.release(workerId, incarnationId, 'a');
  expect(await redis.hlen(`${prefix}:workspace-slots`)).toBe(4);
  expect(await redis.get(`${prefix}:lock`)).toBe(
    `workspace-slots:${incarnationId}`,
  );
  await slots.release(workerId, incarnationId, 'b');
  expect(await redis.get(`${prefix}:lock`)).toBeNull();
});

test('legacy locks and older serial admission remain barriers', async () => {
  const a = await enqueue('a', 'root-a');
  await redis.set(`${prefix}:lock`, 'legacy-assignment');
  expect(await slots.reserve(a)).toBeUndefined();
  await redis.del(`${prefix}:lock`);
  await admission.leave(workerId, 'a');
  await admission.enter(workerId, 'legacy', Date.now() + 5000);
  await admission.enter(workerId, 'a', Date.now() + 5000, 'root-a');
  expect(await slots.reserve(a)).toBeUndefined();
  await admission.leave(workerId, 'legacy');
  expect(await slots.reserve(a)).toBe(0);
});

test('slots reject invalid capacity and replaced incarnation', async () => {
  const a = await enqueue('a', 'root-a');
  for (const capacity of [0, 9, 1.5, NaN]) {
    await expect(slots.reserve({ ...a, capacity })).rejects.toThrow('Invalid');
  }
  await redis.set(`${prefix}:incarnation`, 'replacement');
  await expect(slots.reserve(a)).rejects.toThrow('replaced');
});

test('releasing a long slot shortens the aggregate expiry to remaining work', async () => {
  const a = await enqueue('a', 'root-a');
  const b = { ...await enqueue('b', 'root-b'), expiresAtMs: Date.now() + 3000 };
  await slots.reserve(a);
  await slots.reserve(b);
  expect(await redis.pttl(`${prefix}:lock`)).toBeGreaterThan(8000);
  await slots.release(workerId, incarnationId, 'a');
  expect(await redis.pttl(`${prefix}:lock`)).toBeLessThanOrEqual(3000);
});

test('sibling linked-worktree lanes share their checkout, which waits for both', async () => {
  const a = await enqueue('a', lane('task-a'), 3);
  const b = await enqueue('b', lane('task-b'), 3);
  const root = await enqueue('root', 'repo', 3);
  expect(await slots.reserve(a)).toBe(0);
  expect(await slots.reserve(b)).toBe(1);
  expect(await slots.reserve(root)).toBeUndefined();
  await finish('a');
  expect(await slots.reserve(root)).toBeUndefined();
  await finish('b');
  expect(await slots.reserve(root)).toBe(0);
});

test('a busy checkout holds every lane beneath it but not other checkouts', async () => {
  const root = await enqueue('root', 'repo', 3);
  const a = await enqueue('a', lane('task-a'), 3);
  const other = await enqueue('other', lane('task-a', 'other-repo'), 3);
  expect(await slots.reserve(root)).toBe(0);
  expect(await slots.reserve(a)).toBeUndefined();
  expect(await slots.reserve(other)).toBe(1);
  await finish('root');
  expect(await slots.reserve(a)).toBe(0);
});

test('a waiting checkout holds back newer lanes so root work cannot starve', async () => {
  const a = await enqueue('a', lane('task-a'), 3);
  expect(await slots.reserve(a)).toBe(0);
  const root = await enqueue('root', 'repo', 3);
  const b = await enqueue('b', lane('task-b'), 3);
  const other = await enqueue('other', 'other-repo', 3);
  expect(await slots.reserve(root)).toBeUndefined();
  expect(await slots.reserve(b)).toBeUndefined();
  expect(await slots.reserve(other)).toBe(1);
  await finish('a');
  expect(await slots.reserve(b)).toBeUndefined();
  expect(await slots.reserve(root)).toBe(0);
});

test('lanes nest beneath a conversation checkout, not the source root', async () => {
  const instance = workspaceIsolationKey('repo', 'c'.repeat(64));
  const conversation = await enqueue('conversation', instance, 3);
  const nested = await enqueue('nested', workspaceIsolationKey('repo', 'c'.repeat(64), 'task-a'), 3);
  const source = await enqueue('source', lane('task-a'), 3);
  expect(await slots.reserve(conversation)).toBe(0);
  expect(await slots.reserve(nested)).toBeUndefined();
  expect(await slots.reserve(source)).toBe(1);
});

test('a detached command runs beside its busy lane and checkout, and they beside it', async () => {
  const laneWork = await enqueue('lane', lane('task-a'), 3);
  expect(await slots.reserve(laneWork)).toBe(0);
  expect(await slots.reserve(await detached('beside-lane'))).toBe(1);
  await finish('lane');
  const checkout = await enqueue('checkout', 'repo', 3);
  expect(await slots.reserve(checkout)).toBe(0);
  await finish('beside-lane');
  expect(await slots.reserve(await detached('beside-checkout'))).toBe(1);
  await finish('checkout');
  const laneAgain = await enqueue('lane-again', lane('task-a'), 3);
  expect(await slots.reserve(laneAgain)).toBe(0);
  const sibling = await enqueue('sibling', lane('task-b'), 3);
  expect(await slots.reserve(sibling)).toBe(2);
});

test('a queued detached command is not held behind a held lane or a waiting checkout', async () => {
  const running = await enqueue('running', lane('task-a'), 3);
  expect(await slots.reserve(running)).toBe(0);
  const heldLane = await enqueue('held-lane', lane('task-a'), 3);
  const waitingCheckout = await enqueue('waiting-checkout', 'repo', 3);
  const background = await detached('background');
  expect(await slots.reserve(heldLane)).toBeUndefined();
  expect(await slots.reserve(waitingCheckout)).toBeUndefined();
  expect(await slots.reserve(background)).toBe(1);
  expect(await slots.reserve(heldLane)).toBeUndefined();
  await finish('running');
  expect(await slots.reserve(heldLane)).toBe(0);
});

test('detached commands leave one slot for other work and never act as a barrier', async () => {
  expect(await slots.reserve(await detached('d1'))).toBe(0);
  expect(await slots.reserve(await detached('d2'))).toBe(1);
  const capped = await detached('d3');
  const laneWork = await enqueue('lane', lane('task-a'), 3);
  expect(await slots.reserve(capped)).toBeUndefined();
  expect(await slots.reserve(laneWork)).toBe(2);
  await finish('d1');
  expect(await slots.reserve(capped)).toBe(0);
  await finish('d2');
  await finish('d3');
  await finish('lane');

  const only = await detached('only', 2);
  expect(await slots.reserve(only)).toBe(0);
  const second = await detached('second', 2);
  const checkout = await enqueue('checkout', 'repo', 2);
  expect(await slots.reserve(second)).toBeUndefined();
  expect(await slots.reserve(checkout)).toBe(1);
});

test('a single slot never admits a detached command', async () => {
  const lone = await detached('lone', 1);
  const checkout = await enqueue('checkout', 'repo', 1);
  expect(await slots.reserve(lone)).toBeUndefined();
  expect(await slots.reserve(checkout)).toBe(0);
});
