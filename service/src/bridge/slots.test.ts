import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BridgeAdmissionQueue } from './admission';
import { BridgeWorkspaceSlots } from './slots';

const redis = new RedisMock() as unknown as Redis;
const admission = new BridgeAdmissionQueue(redis);
const slots = new BridgeWorkspaceSlots(redis);
const workerId = 'slot-worker';
const incarnationId = 'slot-incarnation';
const prefix = `codeapi:bridge:v1:worker:${workerId}`;
afterEach(async () => {
  await redis.flushall();
});
async function enqueue(assignmentId: string, workspaceId: string) {
  await redis.set(`${prefix}:incarnation`, incarnationId);
  await redis.set(`${prefix}:workspace-slot-capacity`, '2');
  await admission.enter(workerId, assignmentId, Date.now() + 5000, workspaceId);
  return {
    workerId,
    incarnationId,
    assignmentId,
    workspaceId,
    capacity: 2,
    expiresAtMs: Date.now() + 10000,
  };
}

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
