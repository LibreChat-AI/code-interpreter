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
  return `${JOB_CANCELLATION_PREFIX}:${encodeURIComponent(
    target.queueName,
  )}:${encodeURIComponent(target.jobId)}`;
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
  private subscriber?: IORedis;
  private readonly controllers = new Map<
    string,
    { target: JobTarget; controllers: Set<AbortController> }
  >();
  private startPromise?: Promise<void>;
  private readonly subscriberEndHandlers = new WeakMap<IORedis, () => void>();
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private subscriberRestartTimer?: ReturnType<typeof setTimeout>;
  private reconcileRetryMs = 100;
  private closed = false;

  constructor(private readonly commands: IORedis) {}

  private readonly onSubscriberError = (): void => {
    // ioredis reconnects using the shared policy. The listener prevents a
    // transient subscriber outage from becoming an uncaught process error.
  };

  private readonly onSubscriberReady = (): void => {
    this.scheduleReconcile(0);
  };

  private readonly onSubscriberMessage = (
    channel: string,
    raw: string,
  ): void => {
    if (channel !== JOB_CANCELLATION_CHANNEL) return;
    const target = parseTarget(raw);
    if (target == null) return;
    for (const controller of this.controllers.get(targetKey(target))
      ?.controllers ?? []) {
      controller.abort(CLIENT_DISCONNECT_REASON);
    }
  };

  private detachSubscriber(subscriber: IORedis): void {
    subscriber.removeListener('error', this.onSubscriberError);
    subscriber.removeListener('ready', this.onSubscriberReady);
    subscriber.removeListener('message', this.onSubscriberMessage);
    const onEnd = this.subscriberEndHandlers.get(subscriber);
    if (onEnd != null) subscriber.removeListener('end', onEnd);
    this.subscriberEndHandlers.delete(subscriber);
  }

  private restartAfterTerminalDisconnect(subscriber: IORedis): void {
    if (this.closed || this.subscriber !== subscriber) return;
    this.detachSubscriber(subscriber);
    this.subscriber = undefined;
    this.startPromise = undefined;
    if (this.controllers.size === 0) return;
    void this.start().then(
      () => this.scheduleReconcile(0),
      () => this.scheduleSubscriberRestart(),
    );
  }

  private scheduleSubscriberRestart(): void {
    if (
      this.closed ||
      this.controllers.size === 0 ||
      this.startPromise != null ||
      this.subscriberRestartTimer != null
    )
      return;
    const retryMs = this.reconcileRetryMs;
    this.reconcileRetryMs = Math.min(2_000, retryMs * 2);
    this.subscriberRestartTimer = setTimeout(() => {
      this.subscriberRestartTimer = undefined;
      if (
        this.closed ||
        this.controllers.size === 0 ||
        this.startPromise != null
      )
        return;
      void this.start().then(
        () => {
          this.reconcileRetryMs = 100;
          this.scheduleReconcile(0);
        },
        () => this.scheduleSubscriberRestart(),
      );
    }, retryMs);
  }

  private async reconcile(): Promise<void> {
    const entries = [...this.controllers.values()];
    if (entries.length === 0) return;
    const cancelled = await this.commands.mget(
      ...entries.map(({ target }) => cancellationKey(target)),
    );
    cancelled.forEach((value, index) => {
      if (value === '1') {
        for (const controller of entries[index]?.controllers ?? []) {
          controller.abort(CLIENT_DISCONNECT_REASON);
        }
      }
    });
  }

  private scheduleReconcile(delayMs: number): void {
    if (
      this.closed ||
      this.controllers.size === 0 ||
      this.reconcileTimer != null
    ) {
      return;
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcile().then(
        () => {
          this.reconcileRetryMs = 100;
        },
        () => {
          const retryMs = this.reconcileRetryMs;
          this.reconcileRetryMs = Math.min(2_000, retryMs * 2);
          this.scheduleReconcile(retryMs);
        },
      );
    }, delayMs);
  }

  private start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Job cancellation registry is closed'));
    }
    if (this.startPromise != null) return this.startPromise;
    const starting = (async (): Promise<void> => {
      const subscriber = this.commands.duplicate();
      this.subscriber = subscriber;
      subscriber.on('error', this.onSubscriberError);
      subscriber.on('ready', this.onSubscriberReady);
      subscriber.on('message', this.onSubscriberMessage);
      const onEnd = (): void => this.restartAfterTerminalDisconnect(subscriber);
      this.subscriberEndHandlers.set(subscriber, onEnd);
      subscriber.on('end', onEnd);
      try {
        await subscriber.subscribe(JOB_CANCELLATION_CHANNEL);
      } catch (error) {
        this.detachSubscriber(subscriber);
        if (this.subscriber === subscriber) this.subscriber = undefined;
        subscriber.disconnect(false);
        throw error;
      }
    })();
    this.startPromise = starting;
    void starting.catch(() => {
      if (this.startPromise === starting) this.startPromise = undefined;
    });
    return starting;
  }

  async register(
    target: JobTarget,
    controller: AbortController,
  ): Promise<void> {
    const key = targetKey(target);
    const entry = this.controllers.get(key) ?? {
      target,
      controllers: new Set<AbortController>(),
    };
    entry.controllers.add(controller);
    this.controllers.set(key, entry);
    try {
      await this.start();
      if ((await this.commands.get(cancellationKey(target))) === '1') {
        controller.abort(CLIENT_DISCONNECT_REASON);
      }
    } catch (error) {
      entry.controllers.delete(controller);
      if (entry.controllers.size === 0) this.controllers.delete(key);
      throw error;
    }
  }

  async unregister(
    target: JobTarget,
    controller?: AbortController,
  ): Promise<void> {
    const key = targetKey(target);
    const entry = this.controllers.get(key);
    if (controller == null) {
      this.controllers.delete(key);
    } else if (entry != null) {
      entry.controllers.delete(controller);
      if (entry.controllers.size === 0) this.controllers.delete(key);
    }
    // Markers expire by TTL. Deleting one here can erase the only evidence
    // needed by another replica whose subscriber was reconnecting.
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controllers.clear();
    if (this.reconcileTimer != null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.subscriberRestartTimer != null)
      clearTimeout(this.subscriberRestartTimer);
    this.subscriberRestartTimer = undefined;
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    this.startPromise = undefined;
    if (subscriber == null) return;
    this.detachSubscriber(subscriber);
    // This socket only carries notifications. Disconnect it before awaiting
    // anything: subscribe() may be queued through an indefinite Redis outage.
    subscriber.disconnect(false);
  }
}

async function cancelJobInRedis(
  commands: IORedis,
  target: JobTarget,
  ttlSeconds: number,
  includeResult: boolean,
): Promise<unknown> {
  // Cancellation and result publication have ONE durable winner. Pub/sub is
  // only a notification; it must not decide whether Stop was accepted.
  return commands.eval(
    `
    local state = redis.call('GET', KEYS[1])
    if state == 'completed' then
      -- Keep completion evidence at least as long as the requesting process
      -- requires, even across API/worker config differences. Attached request
      -- tombstones never renew independently of this decision.
      local requestedTtlMs = tonumber(ARGV[1]) * 1000
      for i = 1, 2 do
        if redis.call('PTTL', KEYS[i]) < requestedTtlMs then
          redis.call('PEXPIRE', KEYS[i], requestedTtlMs)
        end
      end
      if ARGV[4] == '1' then return {0, redis.call('GET', KEYS[2])} end
      return {0}
    end
    if state and state ~= '1' then return {-1} end
    redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
    redis.call('PUBLISH', ARGV[2], ARGV[3])
    return {1}
  `,
    2,
    cancellationKey(target),
    `${cancellationKey(target)}:result`,
    Math.max(1, ttlSeconds),
    JOB_CANCELLATION_CHANNEL,
    JSON.stringify(target),
    includeResult ? '1' : '0',
  );
}

export async function requestJobCancellation(
  commands: IORedis,
  target: JobTarget,
  ttlSeconds: number,
): Promise<boolean> {
  const decision = await cancelJobInRedis(commands, target, ttlSeconds, false);
  if (!Array.isArray(decision) || ![0, 1].includes(decision[0])) {
    throw new Error('Invalid durable cancellation decision');
  }
  return decision[0] === 1;
}

export type JobFenceOutcome<T> =
  | { status: 'cancelled' | 'expired' }
  | { status: 'completed'; result: T };

function decodeCommittedResult<T>(value: unknown): { result: T } {
  if (typeof value !== 'string') {
    throw new Error(
      'Committed programmatic result expired; refusing re-execution',
    );
  }
  const decoded: unknown = JSON.parse(value);
  if (
    decoded == null ||
    typeof decoded !== 'object' ||
    !Object.prototype.hasOwnProperty.call(decoded, 'result')
  ) {
    throw new Error(
      'Invalid committed programmatic result; refusing re-execution',
    );
  }
  return decoded as { result: T };
}

export function jobCancellationRetentionSeconds(
  localTimeoutMs: number,
  producerTtlSeconds = 0,
): number {
  return Math.max(
    Math.ceil(localTimeoutMs / 1_000) * 2 + 180,
    Number.isFinite(producerTtlSeconds) ? producerTtlSeconds : 0,
  );
}

/** Retain the actual result so a BullMQ retry after a lost completion reply
 * cannot repeat sandbox mutations. Keep the status small: reconnect MGETs must
 * never load every active job's output into each API/worker replica. */
export async function commitJobResult<T>(
  commands: IORedis,
  target: JobTarget,
  result: T,
  ttlSeconds: number,
  deadlineAtMs = Number.MAX_SAFE_INTEGER,
): Promise<'committed' | 'cancelled' | 'already_completed'> {
  const serialized = JSON.stringify({ result });
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
    throw new Error('Programmatic completion exceeds the 16 MiB result limit');
  }
  const decision = await commands.eval(
    `
    local state = redis.call('GET', KEYS[1])
    if state == '1' then return 0 end
    if state == 'completed' then return 2 end
    if state then return -2 end
    if not state then
      local now = redis.call('TIME')
      if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[3]) then
        return -1
      end
      -- One write command, so an OOM cannot publish just half the decision.
      redis.call('MSET', KEYS[1], 'completed', KEYS[2], ARGV[1])
      redis.call('EXPIRE', KEYS[1], ARGV[2])
      redis.call('EXPIRE', KEYS[2], ARGV[2])
    end
    return 1
  `,
    2,
    cancellationKey(target),
    `${cancellationKey(target)}:result`,
    serialized,
    Math.max(1, ttlSeconds),
    deadlineAtMs,
  );
  if (decision === -1)
    throw new Error('Job result commitment exceeded its deadline');
  if (decision === 1) return 'committed';
  if (decision === 0) return 'cancelled';
  if (decision === 2) return 'already_completed';
  throw new Error('Invalid durable result commitment');
}

/** BullMQ lock loss can redeliver a job while its first processor still runs.
 * Claim once before any sandbox work, retaining the claim through the job's
 * recovery horizon. An ambiguous/stalled attempt is never permission to rerun.
 * Completion lookup and claim are atomic, so there is no read-then-start gap. */
export async function claimJobExecution<T>(
  commands: IORedis,
  target: JobTarget,
  ttlSeconds: number,
): Promise<{ status: 'claimed' } | { status: 'completed'; result: T }> {
  const key = cancellationKey(target);
  const decision = await commands.eval(
    `
    local state = redis.call('GET', KEYS[1])
    if state == 'completed' then return {0, redis.call('GET', KEYS[2])} end
    if state == '1' then return {-1} end
    if state then return {-3} end
    if redis.call('SET', KEYS[3], '1', 'NX', 'EX', ARGV[1]) then return {1} end
    return {-2}
  `,
    3,
    key,
    `${key}:result`,
    `${key}:execution`,
    Math.max(1, ttlSeconds),
  );
  if (!Array.isArray(decision)) throw new Error('Invalid execution claim');
  if (decision[0] === 1) return { status: 'claimed' };
  if (decision[0] === 0)
    return {
      status: 'completed',
      result: decodeCommittedResult<T>(decision[1]).result,
    };
  if (decision[0] === -1) throw new Error(JOB_CANCELLED_MESSAGE);
  if (decision[0] === -2)
    throw new Error(
      'Programmatic job already claimed; refusing duplicate execution',
    );
  throw new Error('Invalid durable execution claim');
}

export async function readCommittedJobResult<T>(
  commands: IORedis,
  target: JobTarget,
): Promise<{ result: T } | undefined> {
  const [state, value] = await commands.mget(
    cancellationKey(target),
    `${cancellationKey(target)}:result`,
  );
  if (state !== 'completed') return undefined;
  return decodeCommittedResult<T>(value);
}

/** Do not release replay ownership on an ambiguous Redis failure. Keep one
 * outstanding marker write, retry rejected writes with bounded backoff, and
 * retain ownership until it succeeds or the job's ORIGINAL deadline expires.
 * A delayed queue.add must carry that same timestamp into the worker. */
export async function fenceJobCancellation<T = unknown>(args: {
  commands: IORedis;
  target: JobTarget;
  ttlSeconds: number;
  deadlineAtMs: number;
}): Promise<JobFenceOutcome<T>> {
  let retryMs = 25;
  let firstAttempt = true;
  while (firstAttempt || Date.now() < args.deadlineAtMs) {
    firstAttempt = false;
    // If a lost enqueue reply arrives after the execution deadline, still
    // give a healthy Redis one bounded opportunity to return completion's
    // winning decision. Never translate a known committed effect to failure.
    const remainingMs = args.deadlineAtMs - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let decision: unknown;
    try {
      decision = await Promise.race([
        cancelJobInRedis(args.commands, args.target, args.ttlSeconds, true),
        new Promise<undefined>(resolve => {
          timer = setTimeout(
            () => resolve(undefined),
            remainingMs > 0 ? remainingMs : 1_000,
          );
        }),
      ]);
    } catch {
      await new Promise<void>(resolve =>
        setTimeout(
          resolve,
          Math.min(retryMs, Math.max(0, args.deadlineAtMs - Date.now())),
        ),
      );
      retryMs = Math.min(1_000, retryMs * 2);
      continue;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
    // Only transport failures retry. Corrupt/missing durable results are
    // deterministic invariant failures, not an invitation to extend their TTL.
    if (decision === undefined) return { status: 'expired' };
    if (!Array.isArray(decision))
      throw new Error('Invalid durable cancellation decision');
    if (decision[0] === 1) return { status: 'cancelled' };
    if (decision[0] === 0)
      return {
        status: 'completed',
        result: decodeCommittedResult<T>(decision[1]).result,
      };
    throw new Error('Invalid durable cancellation decision');
  }
  return { status: 'expired' };
}

const REMOVABLE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/** Frees queued capacity without ever removing an active or settled job. */
export async function removeJobIfWaiting(
  job: Pick<Job, 'getState' | 'remove'>,
): Promise<boolean> {
  if (!REMOVABLE_JOB_STATES.has(await job.getState())) return false;
  try {
    await job.remove();
    return true;
  } catch {
    // A worker may have activated the job between getState() and remove().
    // The durable marker remains authoritative for that race.
    return false;
  }
}

export function programmaticCancellationError(): Error {
  return new DOMException(
    'Programmatic execution request disconnected',
    'AbortError',
  );
}

/** Commit barrier for result-processing stages that may yield after execution. */
export function throwIfJobAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Job aborted',
    'AbortError',
  );
}

/** Maps cancellation observed during asynchronous result cleanup to the same
 * stable worker failure used by the main execution catch path. */
export function jobResultCommitFailure(
  signal: AbortSignal,
  jobTimeoutMs: number,
): Error | undefined {
  if (!signal.aborted) return undefined;
  return new Error(
    signal.reason === CLIENT_DISCONNECT_REASON
      ? JOB_CANCELLED_MESSAGE
      : `Job timed out after ${jobTimeoutMs}ms`,
  );
}

export async function waitForJobWithCancellation<T>(args: {
  commands: IORedis;
  registry: JobCancellationRegistry;
  job: Job<unknown, T>;
  events: QueueEvents;
  timeoutMs: number;
  cancellationTtlSeconds: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const {
    commands,
    registry,
    job,
    events,
    timeoutMs,
    cancellationTtlSeconds,
    signal,
  } = args;
  const completion = job.waitUntilFinished(events, timeoutMs);
  // Subscription startup can itself wait for Redis recovery. Own the losing
  // promise immediately, before any await, rather than after registration.
  void completion.catch(() => undefined);
  const target = { queueName: job.queueName, jobId: String(job.id) };
  const deadlineAtMs = args.deadlineAtMs ?? Date.now() + timeoutMs;
  let fencing: Promise<JobFenceOutcome<T>> | undefined;
  const fence = (): Promise<JobFenceOutcome<T>> =>
    (fencing ??= fenceJobCancellation<T>({
      commands,
      target,
      ttlSeconds: cancellationTtlSeconds,
      deadlineAtMs,
    }));
  const externalController = new AbortController();
  try {
    await registry.register(target, externalController);
  } catch (error) {
    void completion.catch(() => undefined);
    const outcome = await fence();
    if (outcome.status === 'completed') return outcome.result;
    await removeJobIfWaiting(job).catch(() => false);
    throw error;
  }

  let removeAbortListener = (): void => {};
  const disconnected = new Promise<T>((resolve, reject) => {
    let cancelling = false;
    const cancel = (): void => {
      if (cancelling) return;
      cancelling = true;
      void fence()
        .then(async outcome => {
          if (outcome.status === 'completed') {
            resolve(outcome.result);
            return;
          }
          // Removing a waiting job immediately frees queue capacity. An active
          // job cannot be removed; its worker observes the durable marker or
          // pub/sub event and aborts the sandbox transport instead.
          await removeJobIfWaiting(job).catch(() => false);
          reject(programmaticCancellationError());
        })
        .catch(reject);
    };
    if (signal != null) {
      removeAbortListener = (): void =>
        signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }
  });
  const cancelled = new Promise<never>((_, reject) => {
    const cancel = (): void => {
      void removeJobIfWaiting(job).then(
        () => reject(programmaticCancellationError()),
        () => reject(programmaticCancellationError()),
      );
    };
    externalController.signal.addEventListener('abort', cancel, {
      once: true,
    });
    if (externalController.signal.aborted) cancel();
  });

  // A cancelled request stops awaiting the BullMQ result, so attach a sink to
  // the losing promise before racing it to avoid an unhandled late rejection.
  void completion.catch(() => undefined);
  try {
    return await Promise.race([completion, disconnected, cancelled]);
  } catch (error) {
    // Includes waitUntilFinished timeouts and registration/transport errors,
    // not only explicit Stop. Replay cleanup is unsafe until this barrier.
    const outcome = await fence();
    if (outcome.status === 'completed') return outcome.result;
    throw error;
  } finally {
    removeAbortListener();
    await registry
      .unregister(target, externalController)
      .catch(() => undefined);
  }
}

export const jobCancellationInternals = {
  channel: JOB_CANCELLATION_CHANNEL,
  cancellationKey,
  parseTarget,
};
