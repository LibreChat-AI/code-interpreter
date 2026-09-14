import { afterEach, beforeEach, expect, test } from 'bun:test';
import type IORedis from 'ioredis';
import { startTestRedis } from './test/redis';
import { commitJobResult, requestJobCancellation } from './job-cancellation';
import {
  attachProgrammaticCancellationTarget,
  cancelProgrammaticRequest,
  normalizeProgrammaticRequestId,
  programmaticCancellationInternals,
  releaseProgrammaticCancellation,
  reserveProgrammaticCancellation,
} from './programmatic-cancellation';

let redis: IORedis & { closeTestServer(): Promise<void> };

beforeEach(async () => {
  redis = await startTestRedis();
});

afterEach(async () => {
  await redis.closeTestServer();
});

test('normalizes only bounded opaque request IDs', () => {
  expect(normalizeProgrammaticRequestId('request_123456789')).toBe(
    'request_123456789',
  );
  expect(normalizeProgrammaticRequestId(' short ')).toBeUndefined();
  expect(
    normalizeProgrammaticRequestId('../request_123456789'),
  ).toBeUndefined();
  expect(normalizeProgrammaticRequestId('a'.repeat(129))).toBeUndefined();
});

test('Stop cannot extend an attached tombstone before the outcome command succeeds', async () => {
  const requestId = 'request_no_split_renewal';
  const owner = 'owner-a';
  const target = { queueName: 'other', jobId: 'split-renewal' };
  await reserveProgrammaticCancellation({
    redis,
    requestId,
    owner,
    ttlSeconds: 60,
  });
  await attachProgrammaticCancellationTarget({
    redis,
    requestId,
    owner,
    target,
    ttlSeconds: 60,
  });
  await commitJobResult(redis, target, { stdout: 'done' }, 60);
  const key = programmaticCancellationInternals.requestKey(requestId);
  await redis.pexpire(key, 5_000);
  const before = await redis.pttl(key);
  expect(
    await cancelProgrammaticRequest({
      redis,
      requestId,
      owner,
      ttlSeconds: 600,
    }),
  ).toEqual({ status: 'accepted', target });
  // Simulate losing Redis before requestJobCancellation: no second command.
  expect(await redis.pttl(key)).toBeLessThanOrEqual(before);
  expect(await requestJobCancellation(redis, target, 600)).toBe(false);
});

test('cancellation before queue attachment is retained atomically', async () => {
  const requestId = 'request_early_cancel_123';
  const owner = 'owner-a';
  expect(
    await cancelProgrammaticRequest({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toEqual({ status: 'accepted' });

  expect(
    await reserveProgrammaticCancellation({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toBe('cancelled');
  expect(
    await attachProgrammaticCancellationTarget({
      redis,
      requestId,
      owner,
      target: { queueName: 'other', jobId: '42' },
      ttlSeconds: 60,
    }),
  ).toBe('cancelled');
});

test('cancellation after attachment returns the exact queue target', async () => {
  const requestId = 'request_attached_cancel_1';
  const owner = 'owner-a';
  expect(
    await reserveProgrammaticCancellation({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toBe('active');
  expect(
    await attachProgrammaticCancellationTarget({
      redis,
      requestId,
      owner,
      target: { queueName: 'other', jobId: '43' },
      ttlSeconds: 60,
    }),
  ).toBe('active');

  expect(
    await cancelProgrammaticRequest({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toEqual({
    status: 'accepted',
    target: { queueName: 'other', jobId: '43' },
  });
});

test('overlapping requests from the same owner cannot share cancellation state', async () => {
  const requestId = 'request_duplicate_owner_1';
  const owner = 'owner-a';
  expect(
    await reserveProgrammaticCancellation({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toBe('active');

  expect(
    await reserveProgrammaticCancellation({
      redis,
      requestId,
      owner,
      ttlSeconds: 60,
    }),
  ).toBe('duplicate');
});

test('a different principal cannot reserve, attach, cancel, or release a request', async () => {
  const requestId = 'request_owned_cancel_123';
  await reserveProgrammaticCancellation({
    redis,
    requestId,
    owner: 'owner-a',
    ttlSeconds: 60,
  });

  expect(
    await reserveProgrammaticCancellation({
      redis,
      requestId,
      owner: 'owner-b',
      ttlSeconds: 60,
    }),
  ).toBe('forbidden');
  expect(
    await attachProgrammaticCancellationTarget({
      redis,
      requestId,
      owner: 'owner-b',
      target: { queueName: 'other', jobId: '44' },
      ttlSeconds: 60,
    }),
  ).toBe('forbidden');
  expect(
    await cancelProgrammaticRequest({
      redis,
      requestId,
      owner: 'owner-b',
      ttlSeconds: 60,
    }),
  ).toEqual({ status: 'forbidden' });
  await releaseProgrammaticCancellation({
    redis,
    requestId,
    owner: 'owner-b',
  });
  expect(
    await redis.exists(programmaticCancellationInternals.requestKey(requestId)),
  ).toBe(1);
});

test('settlement retains a bounded target tombstone for late Stop classification', async () => {
  const requestId = 'request_release_cancel_1';
  await reserveProgrammaticCancellation({
    redis,
    requestId,
    owner: 'owner-a',
    ttlSeconds: 60,
  });
  const target = { queueName: 'other', jobId: 'settled-job' };
  await attachProgrammaticCancellationTarget({
    redis,
    requestId,
    owner: 'owner-a',
    target,
    ttlSeconds: 60,
  });
  await commitJobResult(redis, target, { stdout: 'done' }, 60);
  await releaseProgrammaticCancellation({
    redis,
    requestId,
    owner: 'owner-a',
  });
  const key = programmaticCancellationInternals.requestKey(requestId);
  expect(await redis.exists(key)).toBe(1);
  expect(await redis.ttl(key)).toBeGreaterThan(0);
  expect(await redis.ttl(key)).toBeLessThanOrEqual(60);
  const cancelled = await cancelProgrammaticRequest({
    redis,
    requestId,
    owner: 'owner-a',
    ttlSeconds: 60,
  });
  expect(cancelled).toEqual({ status: 'accepted', target });
  expect(await requestJobCancellation(redis, target, 60)).toBe(false);
});
