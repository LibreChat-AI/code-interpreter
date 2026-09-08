import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BridgeAdmissionQueue } from './admission';

const redis = new RedisMock() as unknown as Redis;
afterEach(async () => {
  await redis.flushall();
});

test('bounds FIFO admission across API replicas and releases cancelled waiters', async () => {
  const firstReplica = new BridgeAdmissionQueue(redis, 2);
  const secondReplica = new BridgeAdmissionQueue(redis, 2);
  const deadline = Date.now() + 5000;
  expect(await firstReplica.enter('worker', 'first', deadline)).toBe(true);
  expect(await secondReplica.enter('worker', 'second', deadline)).toBe(true);
  expect(await firstReplica.enter('worker', 'third', deadline)).toBe(false);
  expect(await secondReplica.isHead('worker', 'second')).toBe(false);
  await firstReplica.leave('worker', 'first');
  expect(await secondReplica.isHead('worker', 'second')).toBe(true);
  expect(await firstReplica.enter('worker', 'third', deadline)).toBe(true);
  expect(await firstReplica.isHead('worker', 'third')).toBe(false);
});

test('expired crashed callers cannot strand the next request or consume capacity', async () => {
  const queue = new BridgeAdmissionQueue(redis, 1);
  expect(await queue.enter('worker', 'expired', Date.now() - 1)).toBe(true);
  expect(await queue.enter('worker', 'live', Date.now() + 5000)).toBe(true);
  expect(await queue.isHead('worker', 'live')).toBe(true);
});

test('different machines do not share admission capacity', async () => {
  const queue = new BridgeAdmissionQueue(redis, 1);
  expect(await queue.enter('worker-a', 'a', Date.now() + 5000)).toBe(true);
  expect(await queue.enter('worker-b', 'b', Date.now() + 5000)).toBe(true);
  expect(await queue.isHead('worker-b', 'b')).toBe(true);
});
