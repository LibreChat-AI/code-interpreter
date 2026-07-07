// src/queue.ts
import { Queue, QueueEvents } from 'bullmq';
import { setMaxListeners } from 'events';
import type { CommonRedisOptions } from 'ioredis';
import type * as t from './types';
import { Jobs, Queues } from './enum';
import { env } from './config';
import logger from './logger';
import {
    bullmqQueueJobs,
    registerBullmqQueueMetricsCollector,
} from './metrics';
import { createRedisConnection, bullmqPrefix } from './redis-connection';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

const retryStrategy: CommonRedisOptions['retryStrategy'] = times => {
    if (times > MAX_RECONNECT_ATTEMPTS) {
        logger.error(`Failed to connect to Redis after ${times} attempts`);
        return null;
    }
    logger.warn(`Retrying Redis connection attempt ${times}`);
    return RECONNECT_DELAY;
};

const reconnectOnError: CommonRedisOptions['reconnectOnError'] = err => {
    logger.error('Redis connection error:', err);
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
        return true;
    }
    return false;
};

const connection = createRedisConnection({
    maxRetriesPerRequest: null,
    retryStrategy,
    reconnectOnError,
    enableReadyCheck: true,
    disconnectTimeout: 2000,
});

const prefix = bullmqPrefix();

// Global queues - no INSTANCE_ID prefix
// This enables horizontal scaling where any worker can process any job
const pyQueue = new Queue<t.JobData, t.JobResult, Jobs.execute>(Queues.python, {
    connection,
    prefix,
});
const otherQueue = new Queue<t.JobData, t.JobResult, Jobs.execute>(
    Queues.other,
    { connection, prefix },
);

const pyQueueEvents = new QueueEvents(Queues.python, { connection, prefix });
const otherQueueEvents = new QueueEvents(Queues.other, { connection, prefix });

const queueMetricStates = ['waiting', 'active', 'delayed'] as const;
const queueMetricSources = [
    { name: Queues.python, queue: pyQueue },
    { name: Queues.other, queue: otherQueue },
] as const;
const QUEUE_METRICS_TIMEOUT_MS = 1000;

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void promise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

registerBullmqQueueMetricsCollector(async () => {
    await Promise.all(
        queueMetricSources.map(async ({ name, queue }) => {
            try {
                const counts = await withTimeout(
                    queue.getJobCounts(...queueMetricStates),
                    QUEUE_METRICS_TIMEOUT_MS,
                    `Timed out collecting BullMQ queue metrics for ${name}`,
                );
                for (const state of queueMetricStates) {
                    bullmqQueueJobs.set(
                        { queue: name, state },
                        counts[state] ?? 0,
                    );
                }
            } catch (error) {
                logger.warn('Failed to collect BullMQ queue metrics', {
                    queue: name,
                    error,
                });
                for (const state of queueMetricStates) {
                    bullmqQueueJobs.remove({ queue: name, state });
                }
            }
        }),
    );
});

/* job.waitUntilFinished() attaches a short-lived `closing` listener to the
 * shared Queue for every in-flight HTTP request waiting on a result. Bursts
 * above Node's default listener limit are normal for CodeAPI throughput, so
 * keep the leak warning enabled elsewhere while disabling it for these shared
 * BullMQ coordination objects. */
setMaxListeners(0, pyQueue, otherQueue, pyQueueEvents, otherQueueEvents);

export { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, connection };
