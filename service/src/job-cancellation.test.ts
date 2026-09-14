import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type IORedis from 'ioredis';
import type { Job, QueueEvents } from 'bullmq';
import {
  CLIENT_DISCONNECT_REASON,
  JobCancellationRegistry,
  jobResultCommitFailure,
  jobCancellationInternals,
  removeJobIfWaiting,
  requestJobCancellation,
  throwIfJobAborted,
  waitForJobWithCancellation,
  fenceJobCancellation,
} from './job-cancellation';

class FakeSubscriber extends EventEmitter {
  subscribed?: string;
  closed = false;
  subscribeFailures = 0;

  async subscribe(channel: string): Promise<number> {
    if (this.subscribeFailures > 0) {
      this.subscribeFailures -= 1;
      throw new Error('subscriber unavailable');
    }
    this.subscribed = channel;
    return 1;
  }

  async quit(): Promise<'OK'> {
    this.closed = true;
    return 'OK';
  }

  disconnect(): void {
    this.closed = true;
  }
}

class FakeTransaction {
  readonly operations: unknown[][] = [];

  set(...args: unknown[]): this {
    this.operations.push(['set', ...args]);
    return this;
  }

  publish(...args: unknown[]): this {
    this.operations.push(['publish', ...args]);
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    return this.operations.map(() => [null, 'OK']);
  }
}

class FakeRedis {
  readonly subscriber = new FakeSubscriber();
  duplicateCalls = 0;
  readonly existing = new Set<string>();
  readonly deleted: string[] = [];
  readonly transactions: FakeTransaction[] = [];
  mgetFailures = 0;
  cancellationFailures = 0;
  cancellationAttempts = 0;

  duplicate(): FakeSubscriber {
    this.duplicateCalls += 1;
    return this.subscriber;
  }

  async get(key: string): Promise<string | null> {
    return this.existing.has(key) ? '1' : null;
  }

  async eval(
    _script: string,
    _keys: number,
    key: string,
    _resultKey: string,
    ttl: number,
    channel: string,
    payload: string,
  ): Promise<unknown> {
    this.cancellationAttempts += 1;
    if (this.cancellationFailures-- > 0) throw new Error('Redis unavailable');
    const transaction = this.multi();
    transaction.set(key, '1', 'EX', ttl);
    transaction.publish(channel, payload);
    await transaction.exec();
    return [1];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    if (this.mgetFailures > 0) {
      this.mgetFailures -= 1;
      throw new Error('command connection unavailable');
    }
    return keys.map(key => (this.existing.has(key) ? '1' : null));
  }

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    this.existing.delete(key);
    return 1;
  }

  multi(): FakeTransaction {
    const transaction = new FakeTransaction();
    this.transactions.push(transaction);
    return transaction;
  }
}

function redis(fake: FakeRedis): IORedis {
  return fake as unknown as IORedis;
}

test('idle registries allocate no subscriber connection', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));

  await registry.close();

  expect(fake.duplicateCalls).toBe(0);
});

test('shutdown disconnects a subscriber whose startup is still waiting for Redis', async () => {
  const fake = new FakeRedis();
  fake.subscriber.subscribe = async () => new Promise<number>(() => {});
  const registry = new JobCancellationRegistry(redis(fake));
  void registry
    .register(
      { queueName: 'other', jobId: 'shutdown-startup' },
      new AbortController(),
    )
    .catch(() => undefined);
  await registry.close();
  expect(fake.subscriber.closed).toBe(true);
  expect(fake.subscriber.listenerCount('message')).toBe(0);
}, 1_000);

test('failed subscription startup removes handlers before a bounded retry', async () => {
  const fake = new FakeRedis();
  fake.subscriber.subscribeFailures = 1;
  const registry = new JobCancellationRegistry(redis(fake));
  const first = new AbortController();

  await expect(
    registry.register({ queueName: 'other', jobId: 'job-failed-start' }, first),
  ).rejects.toThrow('subscriber unavailable');
  expect(fake.subscriber.listenerCount('message')).toBe(0);
  expect(fake.subscriber.listenerCount('ready')).toBe(0);
  expect(fake.subscriber.listenerCount('error')).toBe(0);

  const second = new AbortController();
  await registry.register({ queueName: 'other', jobId: 'job-retry' }, second);
  expect(fake.duplicateCalls).toBe(2);
  expect(fake.subscriber.listenerCount('message')).toBe(1);
  await registry.close();
});

test('registry catches durable cancellation before subscriber registration', async () => {
  const fake = new FakeRedis();
  const target = { queueName: 'other', jobId: 'job-1' };
  fake.existing.add(jobCancellationInternals.cancellationKey(target));
  const registry = new JobCancellationRegistry(redis(fake));
  const controller = new AbortController();

  await registry.register(target, controller);

  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(CLIENT_DISCONNECT_REASON);
  expect(fake.subscriber.subscribed).toBe(jobCancellationInternals.channel);
  await registry.unregister(target);
  await registry.close();
  expect(fake.subscriber.closed).toBe(true);
});

test('one pubsub listener cancels only the matching active job', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const first = new AbortController();
  const second = new AbortController();
  await registry.register({ queueName: 'other', jobId: 'job-1' }, first);
  await registry.register({ queueName: 'other', jobId: 'job-2' }, second);

  fake.subscriber.emit(
    'message',
    jobCancellationInternals.channel,
    JSON.stringify({ queueName: 'other', jobId: 'job-2' }),
  );

  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(true);
  await registry.close();
});

test('one pubsub listener wakes every local waiter for the same job', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-shared' };
  const first = new AbortController();
  const second = new AbortController();
  await registry.register(target, first);
  await registry.register(target, second);

  fake.subscriber.emit(
    'message',
    jobCancellationInternals.channel,
    JSON.stringify(target),
  );

  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  expect(fake.duplicateCalls).toBe(1);
  await registry.close();
});

test('unregistering one local waiter preserves other waiters for the job', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-shared-unregister' };
  const first = new AbortController();
  const second = new AbortController();
  await registry.register(target, first);
  await registry.register(target, second);
  await registry.unregister(target, first);

  fake.subscriber.emit(
    'message',
    jobCancellationInternals.channel,
    JSON.stringify(target),
  );

  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(true);
  await registry.close();
});

test('subscriber reconnect reconciles active jobs against durable markers', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-reconnect' };
  const controller = new AbortController();
  await registry.register(target, controller);
  fake.existing.add(jobCancellationInternals.cancellationKey(target));

  fake.subscriber.emit('ready');
  await new Promise(resolve => setTimeout(resolve, 10));

  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(CLIENT_DISCONNECT_REASON);
  await registry.close();
});

test('subscriber reconnect retries durable-marker reconciliation', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-retry-reconcile' };
  const controller = new AbortController();
  await registry.register(target, controller);
  fake.existing.add(jobCancellationInternals.cancellationKey(target));
  fake.mgetFailures = 1;

  fake.subscriber.emit('ready');
  await new Promise(resolve => setTimeout(resolve, 150));

  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(CLIENT_DISCONNECT_REASON);
  await registry.close();
});

test('terminal subscriber disconnect rebuilds the subscription and reconciles markers', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-terminal-reconnect' };
  const controller = new AbortController();
  await registry.register(target, controller);
  fake.existing.add(jobCancellationInternals.cancellationKey(target));

  fake.subscriber.emit('end');
  await new Promise(resolve => setTimeout(resolve, 10));

  expect(fake.duplicateCalls).toBe(2);
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(CLIENT_DISCONNECT_REASON);
  await registry.close();
});

test('cancellation writes a durable marker before publishing', async () => {
  const fake = new FakeRedis();
  const target = { queueName: 'other', jobId: 'job-3' };

  await requestJobCancellation(redis(fake), target, 42);

  expect(fake.transactions).toHaveLength(1);
  expect(fake.transactions[0]?.operations).toEqual([
    ['set', jobCancellationInternals.cancellationKey(target), '1', 'EX', 42],
    ['publish', jobCancellationInternals.channel, JSON.stringify(target)],
  ]);
});

test('result commit barrier rejects cancellation observed after execution', () => {
  const controller = new AbortController();
  expect(() => throwIfJobAborted(controller.signal)).not.toThrow();
  controller.abort(CLIENT_DISCONNECT_REASON);
  expect(() => throwIfJobAborted(controller.signal)).toThrow(
    CLIENT_DISCONNECT_REASON,
  );
});

test('result cleanup maps late cancellation to stable worker failures', () => {
  const disconnected = new AbortController();
  disconnected.abort(CLIENT_DISCONNECT_REASON);
  expect(jobResultCommitFailure(disconnected.signal, 30_000)?.message).toBe(
    'Job cancelled after client disconnected',
  );

  const deadline = new AbortController();
  deadline.abort('deadline');
  expect(jobResultCommitFailure(deadline.signal, 30_000)?.message).toBe(
    'Job timed out after 30000ms',
  );
  expect(
    jobResultCommitFailure(new AbortController().signal, 30_000),
  ).toBeUndefined();
});

test('disconnect frees a waiting job and rejects promptly', async () => {
  const fake = new FakeRedis();
  const controller = new AbortController();
  let removed = false;
  const never = new Promise<never>(() => {});
  const job = {
    id: 'job-4',
    queueName: 'other',
    waitUntilFinished: () => never,
    getState: async () => 'waiting',
    remove: async () => {
      removed = true;
    },
  } as unknown as Job<unknown, unknown>;

  const registry = new JobCancellationRegistry(redis(fake));
  const waiting = waitForJobWithCancellation({
    commands: redis(fake),
    registry,
    job,
    events: {} as QueueEvents,
    timeoutMs: 60_000,
    cancellationTtlSeconds: 120,
    signal: controller.signal,
  });
  controller.abort(CLIENT_DISCONNECT_REASON);

  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(removed).toBe(true);
  expect(fake.cancellationAttempts).toBe(1);
  expect(fake.transactions[0]?.operations[0]).toEqual([
    'set',
    jobCancellationInternals.cancellationKey({
      queueName: 'other',
      jobId: 'job-4',
    }),
    '1',
    'EX',
    120,
  ]);
  await registry.close();
});

test('registration failure fences and removes the already-enqueued job', async () => {
  const fake = new FakeRedis();
  fake.subscriber.subscribeFailures = 1;
  let removed = false;
  const job = {
    id: 'job-register-failure',
    queueName: 'other',
    waitUntilFinished: () => new Promise<never>(() => {}),
    getState: async () => 'waiting',
    remove: async () => {
      removed = true;
    },
  } as unknown as Job<unknown, unknown>;
  const registry = new JobCancellationRegistry(redis(fake));

  await expect(
    waitForJobWithCancellation({
      commands: redis(fake),
      registry,
      job,
      events: {} as QueueEvents,
      timeoutMs: 60_000,
      cancellationTtlSeconds: 120,
    }),
  ).rejects.toThrow('subscriber unavailable');

  expect(removed).toBe(true);
  expect(fake.transactions[0]?.operations[0]).toEqual([
    'set',
    jobCancellationInternals.cancellationKey({
      queueName: 'other',
      jobId: 'job-register-failure',
    }),
    '1',
    'EX',
    120,
  ]);
  await registry.close();
});

test('a result rejection is owned while subscription registration is pending', async () => {
  const fake = new FakeRedis();
  let release!: () => void;
  fake.subscriber.subscribe = async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return 1;
  };
  const registry = new JobCancellationRegistry(redis(fake));
  const job = {
    id: 'pending-registration',
    queueName: 'other',
    waitUntilFinished: () => Promise.reject(new Error('completion timeout')),
    getState: async () => 'active',
    remove: async () => {},
  } as unknown as Job<unknown, unknown>;
  const waiting = waitForJobWithCancellation({
    commands: redis(fake),
    registry,
    job,
    events: {} as QueueEvents,
    timeoutMs: 1_000,
    cancellationTtlSeconds: 60,
  });
  const rejection = waiting.catch((error: Error) => error);
  // An unowned rejection fails the test runner on this event-loop turn.
  await new Promise(resolve => setImmediate(resolve));
  release();
  expect(await rejection).toMatchObject({ message: 'completion timeout' });
  await registry.close();
});

test('external cancellation frees a waiting job before rejecting its waiter', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  let removed = false;
  const job = {
    id: 'job-external-waiting',
    queueName: 'other',
    waitUntilFinished: () => new Promise<never>(() => {}),
    getState: async () => 'waiting',
    remove: async () => {
      removed = true;
    },
  } as unknown as Job<unknown, unknown>;
  const waiting = waitForJobWithCancellation({
    commands: redis(fake),
    registry,
    job,
    events: {} as QueueEvents,
    timeoutMs: 60_000,
    cancellationTtlSeconds: 120,
  });
  await new Promise<void>(resolve => setImmediate(resolve));

  fake.subscriber.emit(
    'message',
    jobCancellationInternals.channel,
    JSON.stringify({ queueName: 'other', jobId: 'job-external-waiting' }),
  );

  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(removed).toBe(true);
  await registry.close();
});

test('a separate cancellation request wakes the original job waiter', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const never = new Promise<never>(() => {});
  const job = {
    id: 'job-external-cancel',
    queueName: 'other',
    waitUntilFinished: () => never,
    getState: async () => 'active',
    remove: async () => undefined,
  } as unknown as Job<unknown, unknown>;

  const waiting = waitForJobWithCancellation({
    commands: redis(fake),
    registry,
    job,
    events: {} as QueueEvents,
    timeoutMs: 60_000,
    cancellationTtlSeconds: 120,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  fake.subscriber.emit(
    'message',
    jobCancellationInternals.channel,
    JSON.stringify({ queueName: 'other', jobId: 'job-external-cancel' }),
  );

  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(fake.deleted).toEqual([]);
  await registry.close();
});

test('queued removal never removes an active job', async () => {
  let removed = false;
  const job = {
    getState: async () => 'active' as const,
    remove: async () => {
      removed = true;
    },
  };

  expect(await removeJobIfWaiting(job)).toBe(false);
  expect(removed).toBe(false);
});

test('a failed cancellation write retains ownership until a durable retry succeeds', async () => {
  const fake = new FakeRedis();
  fake.cancellationFailures = 2;
  const target = { queueName: 'other', jobId: 'ambiguous-enqueue' };
  let released = false;
  const fencing = fenceJobCancellation({
    commands: redis(fake),
    target,
    ttlSeconds: 60,
    deadlineAtMs: Date.now() + 500,
  }).then(() => {
    released = true;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(released).toBe(false);
  await fencing;
  expect(fake.cancellationAttempts).toBe(3);
  expect(released).toBe(true);
});

test('an unavailable Redis cannot release ownership before the fixed job deadline', async () => {
  const fake = new FakeRedis();
  fake.cancellationFailures = 1_000;
  const startedAt = Date.now();
  await fenceJobCancellation({
    commands: redis(fake),
    target: { queueName: 'other', jobId: 'offline' },
    ttlSeconds: 60,
    deadlineAtMs: startedAt + 80,
  });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
  expect(fake.cancellationAttempts).toBeLessThanOrEqual(4);
});

test('a pending Redis write allocates no retry backlog and waits until the deadline', async () => {
  const fake = new FakeRedis();
  let calls = 0;
  fake.eval = async () => {
    calls += 1;
    return new Promise<number>(() => {});
  };
  const startedAt = Date.now();
  await fenceJobCancellation({
    commands: redis(fake),
    target: { queueName: 'other', jobId: 'pending-write' },
    ttlSeconds: 60,
    deadlineAtMs: startedAt + 40,
  });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(39);
  expect(calls).toBe(1);
});

test('queued removal frees waiting capacity and tolerates an activation race', async () => {
  let removals = 0;
  expect(
    await removeJobIfWaiting({
      getState: async () => 'waiting',
      remove: async () => {
        removals += 1;
      },
    }),
  ).toBe(true);
  expect(
    await removeJobIfWaiting({
      getState: async () => 'waiting',
      remove: async () => {
        removals += 1;
        throw new Error('job is active');
      },
    }),
  ).toBe(false);
  expect(removals).toBe(2);
});
