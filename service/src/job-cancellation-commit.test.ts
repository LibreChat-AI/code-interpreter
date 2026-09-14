import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestRedis } from './test/redis';
import { RedisBridgeStore } from './bridge/store';
import {
  commitJobResult,
  readCommittedJobResult,
  requestJobCancellation,
  JobCancellationRegistry,
  jobCancellationInternals,
  fenceJobCancellation,
  waitForJobWithCancellation,
  jobCancellationRetentionSeconds,
  claimJobExecution,
} from './job-cancellation';

let redis: Awaited<ReturnType<typeof startTestRedis>>;
beforeEach(async () => {
  redis = await startTestRedis();
});
afterEach(async () => {
  await redis.closeTestServer();
});
const target = { queueName: 'other', jobId: 'commit-race' };

for (const outcome of ['commit', 'stop', 'duplicate'])
  test(`native mutation handoff commits or quarantines before root release (${outcome})`, async () => {
    const store = new RedisBridgeStore(redis);
    const workerId = 'handoff-worker';
    const incarnationId = 'incarnation-handoff-01';
    await store.register({
      protocolVersion: 1,
      workerId,
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'anthropic-srt',
        runtimes: [],
        workspaceTools: {
          protocolVersion: 1,
          operations: ['execute_command'],
          programmaticLanguages: ['bash'],
          workspaces: [{ id: 'primary' }],
        },
      },
    });
    const controller = new AbortController();
    const dispatchArgs = {
      workerId,
      workspaceId: 'primary',
      headers: {},
      body: {
        language: 'bash',
        version: '5.2',
        session_id: 'handoff-session',
        files: [{ name: 'main.sh', content: 'echo mutation' }],
      },
      deadlineAtMs: Date.now() + 5_000,
      signal: controller.signal,
    };
    const completion = store.dispatch({
      ...dispatchArgs,
      finalize: async settlement => {
        if (outcome === 'stop') await requestJobCancellation(redis, target, 60);
        if (outcome === 'duplicate')
          await commitJobResult(
            redis,
            target,
            { stdout: 'first mutation' },
            60,
          );
        if (
          (await commitJobResult(
            redis,
            target,
            { stdout: 'mutation settled' },
            60,
          )) !== 'committed'
        )
          throw new Error('handoff did not win');
        // This represents Stop during post-handoff egress cleanup. It must no
        // longer turn the applied mutation into an acknowledged cancellation.
        expect(await requestJobCancellation(redis, target, 60)).toBe(false);
        return settlement;
      },
    });
    void completion.catch(() => undefined);
    const assignment = await store.lease(workerId, incarnationId, 1_000);
    if (assignment == null) throw new Error('Missing assignment');
    await store.settle(workerId, assignment.assignmentId, {
      protocolVersion: 1,
      incarnationId,
      generation: assignment.generation,
      leaseToken: assignment.leaseToken,
      status: 'fulfilled',
      result: {
        session_id: 'handoff-session',
        language: 'bash',
        version: '5.2',
        files: [],
      },
    });
    if (outcome !== 'commit') {
      await expect(completion).rejects.toThrow('handoff did not win');
      await expect(store.dispatch(dispatchArgs)).rejects.toMatchObject({
        code: 'WORKSPACE_QUARANTINED',
      });
    } else {
      await expect(completion).resolves.toMatchObject({
        status: 'fulfilled',
      });
      expect(await readCommittedJobResult(redis, target)).toEqual({
        result: { stdout: 'mutation settled' },
      });
    }
  });

test('concurrent stalled-job redelivery claims at most one sandbox execution', async () => {
  let executions = 0;
  const attempt = async () => {
    const claim = await claimJobExecution(redis, target, 60);
    if (claim.status === 'claimed') executions += 1;
    return claim;
  };
  const results = await Promise.allSettled([attempt(), attempt()]);
  expect(executions).toBe(1);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(
    1,
  );
  await expect(attempt()).rejects.toThrow('already claimed');
  expect(executions).toBe(1);
  await commitJobResult(redis, target, { stdout: 'first result' }, 60);
  expect(await attempt()).toEqual({
    status: 'completed',
    result: { stdout: 'first result' },
  });
  expect(executions).toBe(1);
  expect(
    await commitJobResult(redis, target, { stdout: 'different result' }, 60),
  ).toBe('already_completed');
  expect(await readCommittedJobResult(redis, target)).toEqual({
    result: { stdout: 'first result' },
  });
});

test('a lost execution-claim reply never authorizes a second attempt', async () => {
  const lostReply = {
    eval: async (...args: Parameters<typeof redis.eval>) => {
      await redis.eval(...args);
      throw new Error('claim reply lost');
    },
  } as unknown as typeof redis;
  await expect(claimJobExecution(lostReply, target, 60)).rejects.toThrow(
    'claim reply lost',
  );
  await expect(claimJobExecution(redis, target, 60)).rejects.toThrow(
    'already claimed',
  );
});

test('cancel-before-claim and missing completion payload fail closed', async () => {
  await requestJobCancellation(redis, target, 60);
  await expect(claimJobExecution(redis, target, 60)).rejects.toThrow(
    'cancelled',
  );
  const completedTarget = { ...target, jobId: 'missing-payload-claim' };
  await commitJobResult(redis, completedTarget, { stdout: 'done' }, 60);
  await redis.del(
    `${jobCancellationInternals.cancellationKey(completedTarget)}:result`,
  );
  await expect(claimJobExecution(redis, completedTarget, 60)).rejects.toThrow(
    'refusing re-execution',
  );
});

for (const corrupt of [false, true])
  test(`invalid committed result fails immediately without Redis retries (corrupt=${corrupt})`, async () => {
    await commitJobResult(redis, target, { stdout: 'done' }, 60);
    const key = jobCancellationInternals.cancellationKey(target);
    if (corrupt) await redis.set(`${key}:result`, '{invalid');
    else await redis.del(`${key}:result`);
    let calls = 0;
    const commands = {
      eval: (...args: Parameters<typeof redis.eval>) => {
        calls += 1;
        return redis.eval(...args);
      },
    } as unknown as typeof redis;
    await expect(
      fenceJobCancellation({
        commands,
        target,
        ttlSeconds: 60,
        deadlineAtMs: Date.now() + 30_000,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

test('completion retention includes the API producer across timeout configuration drift', async () => {
  const ttl = jobCancellationRetentionSeconds(30_000, 430);
  expect(ttl).toBe(430);
  expect(jobCancellationRetentionSeconds(300_000, 430)).toBe(780);
  await commitJobResult(redis, target, { stdout: 'done' }, ttl);
  const key = jobCancellationInternals.cancellationKey(target);
  expect(await redis.ttl(key)).toBeGreaterThanOrEqual(429);
  expect(await redis.ttl(`${key}:result`)).toBeGreaterThanOrEqual(429);
});

test('a late Stop renews completion evidence along with its request tombstone', async () => {
  await commitJobResult(redis, target, { stdout: 'done' }, 1);
  expect(await requestJobCancellation(redis, target, 60)).toBe(false);
  const key = jobCancellationInternals.cancellationKey(target);
  expect(await redis.ttl(key)).toBeGreaterThanOrEqual(59);
  expect(await redis.ttl(`${key}:result`)).toBeGreaterThanOrEqual(59);
});

test('retention renewal does not lose subsecond time to rounded TTL readings', async () => {
  await commitJobResult(redis, target, { stdout: 'done' }, 60);
  const key = jobCancellationInternals.cancellationKey(target);
  await redis.pexpire(key, 59_900);
  const expiration = async () =>
    Number(
      await redis.eval(
        `
    local now = redis.call('TIME')
    return tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + redis.call('PTTL', KEYS[1])
  `,
        1,
        key,
      ),
    );
  const before = await expiration();
  await requestJobCancellation(redis, target, 60);
  expect(await expiration()).toBeGreaterThan(before);
});

test('fencing returns the committed result without a vulnerable second Redis read', async () => {
  const result = { stdout: 'one committed effect' };
  await commitJobResult(redis, target, result, 60);
  let calls = 0;
  const connectionDropsAfterDecision = {
    eval: async (...args: Parameters<typeof redis.eval>) => {
      calls += 1;
      return redis.eval(...args);
    },
    get: async () => {
      throw new Error('connection lost after decision');
    },
    mget: async () => {
      throw new Error('connection lost after decision');
    },
  } as unknown as typeof redis;
  expect(
    await fenceJobCancellation({
      commands: connectionDropsAfterDecision,
      target,
      ttlSeconds: 60,
      deadlineAtMs: Date.now() + 1_000,
    }),
  ).toEqual({ status: 'completed', result });
  expect(calls).toBe(1);
});

test('disconnect returns a known completed result without waiting for a lost queue event', async () => {
  const result = { stdout: 'done' };
  await commitJobResult(redis, target, result, 60);
  const registry = new JobCancellationRegistry(redis);
  const controller = new AbortController();
  controller.abort();
  const job = {
    id: target.jobId,
    queueName: target.queueName,
    waitUntilFinished: () => new Promise(() => {}),
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
        signal: controller.signal,
      }),
    ).toEqual(result);
  } finally {
    await registry.close();
  }
});

test('durable cancellation wins even before its subscriber notification arrives', async () => {
  expect(await requestJobCancellation(redis, target, 60)).toBe(true);
  expect(await commitJobResult(redis, target, { stdout: 'late' }, 60)).toBe(
    'cancelled',
  );
  expect(await readCommittedJobResult(redis, target)).toBeUndefined();
});

test('committed results reject late Stop and survive a lost BullMQ completion reply', async () => {
  const result = { stdout: 'one mutation', files: [] };
  expect(await commitJobResult(redis, target, result, 60)).toBe('committed');
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
  expect(Number(cancelled) + Number(committed === 'committed')).toBe(1);
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
  ).toEqual({ status: 'completed', result });
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
  ).toEqual({ status: 'completed', result: { stdout: 'done' } });
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
  ).toBe('committed');
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
