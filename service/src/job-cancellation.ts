import type IORedis from 'ioredis';
import type { Job, QueueEvents } from 'bullmq';

const JOB_CANCELLATION_PREFIX = 'codeapi:job-cancellation:v1';
const JOB_CANCELLATION_CHANNEL = `${JOB_CANCELLATION_PREFIX}:events`;
export const CLIENT_DISCONNECT_REASON = 'client_disconnected';
export const JOB_CANCELLED_MESSAGE = 'Job cancelled after client disconnected';

interface JobTarget {
  queueName: string;
  jobId: string;
}

function targetKey(target: JobTarget): string {
  return `${target.queueName}:${target.jobId}`;
}

function cancellationKey(target: JobTarget): string {
  return `${JOB_CANCELLATION_PREFIX}:${encodeURIComponent(target.queueName)}:${encodeURIComponent(target.jobId)}`;
}

function parseTarget(raw: string): JobTarget | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<JobTarget>;
    if (
      typeof parsed.queueName !== 'string' ||
      parsed.queueName.length === 0 ||
      parsed.queueName.length > 256 ||
      typeof parsed.jobId !== 'string' ||
      parsed.jobId.length === 0 ||
      parsed.jobId.length > 256
    ) {
      return undefined;
    }
    return { queueName: parsed.queueName, jobId: parsed.jobId };
  } catch {
    return undefined;
  }
}

/**
 * Cross-process cancellation for BullMQ work.
 *
 * The durable marker closes the publish-before-subscribe race while one
 * process-wide pub/sub connection makes active cancellation O(events), not
 * O(active jobs) Redis polling. Only explicitly cancellable replay jobs use
 * this path, so ordinary queue traffic pays no extra Redis round trips.
 */
export class JobCancellationRegistry {
  private readonly subscriber: IORedis;
  private readonly controllers = new Map<
    string,
    { target: JobTarget; controller: AbortController }
  >();
  private startPromise?: Promise<void>;

  constructor(private readonly commands: IORedis) {
    this.subscriber = commands.duplicate();
    this.subscriber.on('error', () => {
      // ioredis reconnects using the shared policy. The listener prevents a
      // transient subscriber outage from becoming an uncaught process error.
    });
    this.subscriber.on('ready', () => {
      void this.reconcile().catch(() => undefined);
    });
  }

  private async reconcile(): Promise<void> {
    const entries = [...this.controllers.values()];
    if (entries.length === 0) return;
    const cancelled = await this.commands.mget(
      ...entries.map(({ target }) => cancellationKey(target)),
    );
    cancelled.forEach((value, index) => {
      if (value != null) {
        entries[index]?.controller.abort(CLIENT_DISCONNECT_REASON);
      }
    });
  }

  private start(): Promise<void> {
    if (this.startPromise != null) return this.startPromise;
    const starting = (async () => {
      this.subscriber.on('message', (channel, raw) => {
        if (channel !== JOB_CANCELLATION_CHANNEL) return;
        const target = parseTarget(raw);
        if (target == null) return;
        this.controllers
          .get(targetKey(target))
          ?.controller.abort(CLIENT_DISCONNECT_REASON);
      });
      await this.subscriber.subscribe(JOB_CANCELLATION_CHANNEL);
    })();
    this.startPromise = starting.catch(error => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  async register(target: JobTarget, controller: AbortController): Promise<void> {
    this.controllers.set(targetKey(target), { target, controller });
    try {
      await this.start();
      if (await this.commands.exists(cancellationKey(target))) {
        controller.abort(CLIENT_DISCONNECT_REASON);
      }
    } catch (error) {
      this.controllers.delete(targetKey(target));
      throw error;
    }
  }

  async unregister(target: JobTarget): Promise<void> {
    this.controllers.delete(targetKey(target));
    await this.commands.del(cancellationKey(target));
  }

  async close(): Promise<void> {
    if (this.startPromise == null) return;
    this.controllers.clear();
    await this.subscriber.quit();
  }
}

export async function requestJobCancellation(
  commands: IORedis,
  target: JobTarget,
  ttlSeconds: number,
): Promise<void> {
  const payload = JSON.stringify(target);
  const transaction = commands.multi();
  transaction.set(cancellationKey(target), '1', 'EX', Math.max(1, ttlSeconds));
  transaction.publish(JOB_CANCELLATION_CHANNEL, payload);
  const result = await transaction.exec();
  if (result == null) {
    throw new Error('Redis transaction aborted while cancelling queued execution');
  }
  const failure = result.find(([error]) => error != null)?.[0];
  if (failure != null) throw failure;
}

function abortError(): Error {
  return new DOMException('Programmatic execution request disconnected', 'AbortError');
}

export async function waitForJobWithCancellation<T>(args: {
  commands: IORedis;
  job: Job<unknown, T>;
  events: QueueEvents;
  timeoutMs: number;
  cancellationTtlSeconds: number;
  signal?: AbortSignal;
}): Promise<T> {
  const { commands, job, events, timeoutMs, cancellationTtlSeconds, signal } = args;
  const completion = job.waitUntilFinished(events, timeoutMs);
  if (signal == null) return completion;

  const target = { queueName: job.queueName, jobId: String(job.id) };
  let removeAbortListener = (): void => {};
  const cancelled = new Promise<never>((_, reject) => {
    let cancelling = false;
    const cancel = (): void => {
      if (cancelling) return;
      cancelling = true;
      void requestJobCancellation(commands, target, cancellationTtlSeconds)
        .then(async () => {
          // Removing a waiting job immediately frees queue capacity. An active
          // job cannot be removed; its worker observes the durable marker or
          // pub/sub event and aborts the sandbox transport instead.
          await job.remove().catch(() => undefined);
        })
        .then(() => reject(abortError()), reject);
    };
    removeAbortListener = (): void => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });

  // A cancelled request stops awaiting the BullMQ result, so attach a sink to
  // the losing promise before racing it to avoid an unhandled late rejection.
  void completion.catch(() => undefined);
  try {
    return await Promise.race([completion, cancelled]);
  } finally {
    removeAbortListener();
  }
}

export const jobCancellationInternals = {
  channel: JOB_CANCELLATION_CHANNEL,
  cancellationKey,
  parseTarget,
};
