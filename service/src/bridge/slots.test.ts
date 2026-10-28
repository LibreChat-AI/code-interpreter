import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BridgeAdmissionQueue } from './admission';
import { BridgeWorkspaceSlots } from './slots';
import { workspaceIsolationKey } from '../../../packages/code/src/protocol';

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
