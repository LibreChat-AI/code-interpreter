import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestRedis } from './test/redis';
import {
  commitJobResult,
  readCommittedJobResult,
  requestJobCancellation,
  JobCancellationRegistry,
  jobCancellationInternals,
} from './job-cancellation';

let redis: Awaited<ReturnType<typeof startTestRedis>>;
beforeEach(async () => {
  redis = await startTestRedis();
});
afterEach(async () => {
  await redis.closeTestServer();
});
const target = { queueName: 'other', jobId: 'commit-race' };

test('durable cancellation wins even before its subscriber notification arrives', async () => {
  expect(await requestJobCancellation(redis, target, 60)).toBe(true);
  expect(await commitJobResult(redis, target, { stdout: 'late' }, 60)).toBe(
    false,
  );
  expect(await readCommittedJobResult(redis, target)).toBeUndefined();
});

test('committed results reject late Stop and survive a lost BullMQ completion reply', async () => {
  const result = { stdout: 'one mutation', files: [] };
  expect(await commitJobResult(redis, target, result, 60)).toBe(true);
  expect(await requestJobCancellation(redis, target, 60)).toBe(false);
  expect(await readCommittedJobResult(redis, target)).toEqual({ result });
  expect(await redis.get(jobCancellationInternals.cancellationKey(target))).toBe('completed');
  const registry = new JobCancellationRegistry(redis);
  const controller = new AbortController();
  try {
    await registry.register(target, controller);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    await registry.close();
  }
});

test('concurrent cancellation and completion have exactly one winner', async () => {
  const [cancelled, committed] = await Promise.all([
    requestJobCancellation(redis, target, 60),
    commitJobResult(redis, target, { stdout: 'result' }, 60),
  ]);
  expect(Number(cancelled) + Number(committed)).toBe(1);
});

test('a missing committed result fails closed instead of re-executing', async () => {
  await commitJobResult(redis, target, { stdout: 'already applied' }, 60);
  await redis.del(`${jobCancellationInternals.cancellationKey(target)}:result`);
  await expect(readCommittedJobResult(redis, target)).rejects.toThrow('refusing re-execution');
});
