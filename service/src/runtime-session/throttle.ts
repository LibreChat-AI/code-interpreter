import type { RedisClient } from '../redis-connection';
import { connection } from '../queue';

/**
 * Distributed per-second token buckets for Lambda MicroVM control-plane
 * calls. All workers share the AWS account limits (RunMicrovm 5 TPS,
 * ResumeMicrovm 5, SuspendMicrovm 2, CreateMicrovmAuthToken 50), so the
 * budget lives in Redis:
 *
 *   rtsx:tps:<op>:<epochSecond>  INCR-ed per attempt   (PEXPIRE 2s)
 *   rtsx:tps:poison:<op>         backoff flag set on SDK throttle errors
 */

export type ThrottledOp = 'run' | 'resume' | 'suspend' | 'token';

const BUCKET_PREFIX = 'rtsx:tps:';
const POISON_PREFIX = 'rtsx:tps:poison:';
const BUCKET_TTL_MS = 2_000;
const DEFAULT_POISON_MS = 2_000;

let redis: RedisClient = connection;

export function setRedisForTests(client: RedisClient): void {
    redis = client;
}

export function resetRedisForTests(): void {
    redis = connection;
}

export class MicrovmOpThrottledError extends Error {
    constructor(public readonly op: ThrottledOp, budgetMs: number) {
        super(
            `Lambda MicroVM ${op} budget exhausted after ${budgetMs}ms of throttling`
        );
        this.name = 'MicrovmOpThrottledError';
    }
}

export interface OpBudgetOptions {
    limitPerSecond: number;
    /** Total time the caller is willing to wait for a slot. */
    budgetMs: number;
    /** Optional caller-owned absolute deadline. Supplying it lets multiple
     * launch attempts and every Redis leg consume one shared budget instead of
     * starting a fresh `budgetMs` window. */
    deadlineAtMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
}

export interface PoisonOpBucketOptions {
    deadlineAtMs?: number;
    now?: () => number;
    signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Lambda MicroVM operation budget aborted');
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(abortReason(signal as AbortSignal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        /* Abort can land between the preflight check and registration. */
        if (signal?.aborted) onAbort();
    });

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
}

/** ioredis cannot cancel one queued command. This bounds the caller's await,
 * keeps a handler attached to any late result/rejection, and relies on the
 * throttle mutations' conservative ambiguity: a late INCR consumes capacity,
 * while a late expiry or poison only reduces load. */
function runRedisWithinDeadline<T>(
    operation: () => Promise<T>,
    options: {
        deadlineAtMs?: number;
        now: () => number;
        signal?: AbortSignal;
        timeoutError: () => Error;
    }
): Promise<T> {
    throwIfAborted(options.signal);
    const remainingMs =
        options.deadlineAtMs == null
            ? undefined
            : options.deadlineAtMs - options.now();
    if (remainingMs != null && remainingMs <= 0) {
        return Promise.reject(options.timeoutError());
    }

    /* Construct only after the preflight checks: an already-expired caller must
     * not enqueue a mutation that can execute after Redis recovers. */
    const command = operation();
    if (remainingMs == null && options.signal == null) return command;

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = (): void => {
            finish(() => reject(abortReason(options.signal as AbortSignal)));
        };
        if (remainingMs != null) {
            timer = setTimeout(() => {
                finish(() => reject(options.timeoutError()));
            }, remainingMs);
            timer.unref?.();
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        /* Abort may race the preflight check and listener registration. */
        if (options.signal?.aborted) onAbort();

        command.then(
            value => {
                if (settled) return;
                if (
                    options.deadlineAtMs != null &&
                    options.now() >= options.deadlineAtMs
                ) {
                    finish(() => reject(options.timeoutError()));
                    return;
                }
                finish(() => resolve(value));
            },
            error => finish(() => reject(error))
        );
    });
}

/**
 * Reserves one control-plane call slot for `op`, waiting across second
 * boundaries until `budgetMs` is exhausted. Throws MicrovmOpThrottledError
 * when no slot frees up in time.
 */
export async function acquireOpBudget(
    op: ThrottledOp,
    options: OpBudgetOptions
): Promise<void> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const deadline = options.deadlineAtMs ?? now() + options.budgetMs;
    const redisOptions = {
        deadlineAtMs: deadline,
        now,
        signal: options.signal,
        timeoutError: () => new MicrovmOpThrottledError(op, options.budgetMs),
    };

    for (;;) {
        throwIfAborted(options.signal);
        const poisoned = await runRedisWithinDeadline(
            () => redis.pttl(`${POISON_PREFIX}${op}`),
            redisOptions
        );
        throwIfAborted(options.signal);
        if (poisoned > 0) {
            if (now() + poisoned > deadline)
                throw new MicrovmOpThrottledError(op, options.budgetMs);
            await sleep(poisoned, options.signal);
            continue;
        }

        const nowMs = now();
        const second = Math.floor(nowMs / 1_000);
        const key = `${BUCKET_PREFIX}${op}:${second}`;
        const count = await runRedisWithinDeadline(
            () => redis.incr(key),
            redisOptions
        );
        throwIfAborted(options.signal);
        if (count === 1) {
            await runRedisWithinDeadline(
                () => redis.pexpire(key, BUCKET_TTL_MS),
                redisOptions
            );
            throwIfAborted(options.signal);
        }
        if (count <= options.limitPerSecond) return;

        const nextSecondMs = (second + 1) * 1_000 - nowMs;
        const jitter = Math.floor(Math.random() * 100);
        const waitMs = nextSecondMs + jitter;
        if (nowMs + waitMs > deadline)
            throw new MicrovmOpThrottledError(op, options.budgetMs);
        await sleep(waitMs, options.signal);
    }
}

/** Called when the SDK reports ThrottlingException/TooManyRequests: back the
 *  whole fleet off `op` briefly instead of hammering per-second buckets. */
export async function poisonOpBucket(
    op: ThrottledOp,
    durationMs: number = DEFAULT_POISON_MS,
    options: PoisonOpBucketOptions = {}
): Promise<void> {
    const now = options.now ?? Date.now;
    await runRedisWithinDeadline(
        () => redis.set(`${POISON_PREFIX}${op}`, '1', 'PX', durationMs),
        {
            deadlineAtMs: options.deadlineAtMs,
            now,
            signal: options.signal,
            timeoutError: () =>
                new Error(`Lambda MicroVM ${op} poison deadline exceeded`),
        }
    );
}
