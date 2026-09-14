import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestRedis } from './test/redis';
import {
  commitJobResult,
  readCommittedJobResult,
  requestJobCancellation,
  JobCancellationRegistry,
  jobCancellationInternals,
  fenceJobCancellation,
  waitForJobWithCancellation,
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
  expect(
    await redis.get(jobCancellationInternals.cancellationKey(target)),
  ).toBe('completed');
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
  await expect(readCommittedJobResult(redis, target)).rejects.toThrow(
    'refusing re-execution',
  );
});

test('an enqueue failure can recover a result that won cancellation fencing', async () => {
  const result = { stdout: 'effect already applied' };
  await commitJobResult(redis, target, result, 60);
  expect(
    await fenceJobCancellation({
      commands: redis,
      target,
      ttlSeconds: 60,
      deadlineAtMs: Date.now() + 5_000,
    }),
  ).toBe(false);
  expect(await readCommittedJobResult(redis, target)).toEqual({ result });
});

test('enqueue fencing still recovers completion after the original deadline', async () => {
  await commitJobResult(redis, target, { stdout: 'done' }, 60);
  expect(
    await fenceJobCancellation({
      commands: redis,
      target,
      ttlSeconds: 60,
      deadlineAtMs: Date.now() - 1_000,
    }),
  ).toBe(false);
});

test('Redis rejects commitment when recovery happens after the producer deadline', async () => {
  const delayed = {
    eval: async (...args: Parameters<typeof redis.eval>) => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return redis.eval(...args);
    },
  } as unknown as typeof redis;
  await expect(
    commitJobResult(delayed, target, { stdout: 'late' }, 60, Date.now() + 100),
  ).rejects.toThrow('exceeded its deadline');
  expect(await readCommittedJobResult(redis, target)).toBeUndefined();
});

test('a timely durable commit remains successful when only its acknowledgement is late', async () => {
  const delayedReply = {
    eval: async (...args: Parameters<typeof redis.eval>) => {
      const value = await redis.eval(...args);
      await new Promise(resolve => setTimeout(resolve, 150));
      return value;
    },
  } as unknown as typeof redis;
  expect(
    await commitJobResult(
      delayedReply,
      target,
      { stdout: 'committed' },
      60,
      Date.now() + 100,
    ),
  ).toBe(true);
  expect(await readCommittedJobResult(redis, target)).toEqual({
    result: { stdout: 'committed' },
  });
});

for (const failedStage of ['subscription', 'completion'] as const) {
  test(`a lost ${failedStage} reply recovers the committed result instead of reporting failure`, async () => {
    const result = { stdout: 'already applied once' };
    await commitJobResult(redis, target, result, 60);
    const registry = new JobCancellationRegistry(redis);
    if (failedStage === 'subscription')
      registry.register = async () => {
        throw new Error('lost reply');
      };
    const job = {
      id: target.jobId,
      queueName: target.queueName,
      waitUntilFinished: () => Promise.reject(new Error('lost result event')),
    } as unknown as Parameters<typeof waitForJobWithCancellation>[0]['job'];
    try {
      expect(
        await waitForJobWithCancellation({
          commands: redis,
          registry,
          job,
          events: {} as Parameters<
            typeof waitForJobWithCancellation
          >[0]['events'],
          timeoutMs: 1_000,
          cancellationTtlSeconds: 60,
        }),
      ).toEqual(result);
    } finally {
      await registry.close();
    }
  });
}
