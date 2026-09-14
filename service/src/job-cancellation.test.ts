import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type IORedis from 'ioredis';
import type { Job, QueueEvents } from 'bullmq';
import {
  CLIENT_DISCONNECT_REASON,
  JobCancellationRegistry,
  jobCancellationInternals,
  requestJobCancellation,
  waitForJobWithCancellation,
} from './job-cancellation';

class FakeSubscriber extends EventEmitter {
  subscribed?: string;
  closed = false;

  async subscribe(channel: string): Promise<number> {
    this.subscribed = channel;
    return 1;
  }

  async quit(): Promise<'OK'> {
    this.closed = true;
    return 'OK';
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
  readonly existing = new Set<string>();
  readonly deleted: string[] = [];
  readonly transactions: FakeTransaction[] = [];

  duplicate(): FakeSubscriber {
    return this.subscriber;
  }

  async exists(key: string): Promise<number> {
    return this.existing.has(key) ? 1 : 0;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => (this.existing.has(key) ? '1' : null));
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

test('subscriber reconnect reconciles active jobs against durable markers', async () => {
  const fake = new FakeRedis();
  const registry = new JobCancellationRegistry(redis(fake));
  const target = { queueName: 'other', jobId: 'job-reconnect' };
  const controller = new AbortController();
  await registry.register(target, controller);
  fake.existing.add(jobCancellationInternals.cancellationKey(target));

  fake.subscriber.emit('ready');
  await new Promise<void>((resolve) => setImmediate(resolve));

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

test('disconnect frees a waiting job and rejects promptly', async () => {
  const fake = new FakeRedis();
  const controller = new AbortController();
  let removed = false;
  const never = new Promise<never>(() => {});
  const job = {
    id: 'job-4',
    queueName: 'other',
    waitUntilFinished: () => never,
    remove: async () => {
      removed = true;
    },
  } as unknown as Job<unknown, unknown>;

  const waiting = waitForJobWithCancellation({
    commands: redis(fake),
    job,
    events: {} as QueueEvents,
    timeoutMs: 60_000,
    cancellationTtlSeconds: 120,
    signal: controller.signal,
  });
  controller.abort(CLIENT_DISCONNECT_REASON);

  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(removed).toBe(true);
  expect(fake.transactions[0]?.operations[0]).toEqual([
    'set',
    jobCancellationInternals.cancellationKey({ queueName: 'other', jobId: 'job-4' }),
    '1',
    'EX',
    120,
  ]);
});
