// src/queue.ts
import { Queue, QueueEvents } from 'bullmq';
import { setMaxListeners } from 'events';
import type { CommonRedisOptions } from 'ioredis';
import type * as t from './types';
import { Jobs } from './enum';
import { env } from './config';
import {
    queueNameForExecution,
    queueNamesForExecutionProfile,
} from './execution-profile';
import type {
    ExecutionProfile,
    ExecutionProfileSource,
    SandboxBackendName,
} from './execution-profile';
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
    connectTimeout: 2000,
});

const prefix = bullmqPrefix();

// Global queues - no INSTANCE_ID prefix
// This enables horizontal scaling where any worker can process any job
// while the execution-profile prefix prevents HTTP and Lambda workers from
// consuming each other's jobs when they share Redis.
const queueNames = queueNamesForExecutionProfile(
    env.EXECUTION_PROFILE,
    env.EXECUTION_PROFILE_SOURCE,
    env.SANDBOX_BACKEND
);
export interface QueueBinding {
    queue: Queue<t.JobData, t.JobResult, Jobs.execute>;
    events: QueueEvents;
    language: 'python' | 'bash';
}

const queueResources = new Map<
    string,
    { queue: Queue<t.JobData, t.JobResult, Jobs.execute>; events: QueueEvents }
>();

function getQueueResources(name: string): {
    queue: Queue<t.JobData, t.JobResult, Jobs.execute>;
    events: QueueEvents;
} {
    const existing = queueResources.get(name);
    if (existing != null) return existing;

    const queue = new Queue<t.JobData, t.JobResult, Jobs.execute>(name, {
        connection,
        prefix,
    });
    const events = new QueueEvents(name, { connection, prefix });
    setMaxListeners(0, queue, events);
    const resources = { queue, events };
    queueResources.set(name, resources);
    return resources;
}

export function getExecutionQueueBinding(
    language: 'python' | 'bash',
    backend: SandboxBackendName | undefined = env.SANDBOX_BACKEND,
    profile: ExecutionProfile = env.EXECUTION_PROFILE,
    source: ExecutionProfileSource = env.EXECUTION_PROFILE_SOURCE
): QueueBinding {
    const name = queueNameForExecution(language, profile, source, backend);
    return { ...getQueueResources(name), language };
}

const { queue: pyQueue, events: pyQueueEvents } = getQueueResources(
    queueNames.python
);
const { queue: otherQueue, events: otherQueueEvents } = getQueueResources(
    queueNames.other
);

const queueMetricStates = ['waiting', 'active', 'delayed'] as const;
const QUEUE_METRICS_TIMEOUT_MS = 1000;

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
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
        [...queueResources.entries()].map(async ([name, { queue }]) => {
            try {
                const counts = await withTimeout(
                    queue.getJobCounts(...queueMetricStates),
                    QUEUE_METRICS_TIMEOUT_MS,
                    `Timed out collecting BullMQ queue metrics for ${name}`
                );
                for (const state of queueMetricStates) {
                    bullmqQueueJobs.set(
                        { queue: name, state },
                        counts[state] ?? 0
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
        })
    );
});

/* job.waitUntilFinished() attaches a short-lived `closing` listener to the
 * shared Queue for every in-flight HTTP request waiting on a result. Bursts
 * above Node's default listener limit are normal for CodeAPI throughput, so
 * keep the leak warning enabled elsewhere while disabling it for these shared
 * BullMQ coordination objects. */
setMaxListeners(0, pyQueue, otherQueue, pyQueueEvents, otherQueueEvents);

export async function closeQueueConnections(): Promise<void> {
    await Promise.all(
        [...queueResources.values()].flatMap(({ queue, events }) => [
            queue.close(),
            events.close(),
        ])
    );
}

export {
    pyQueue,
    otherQueue,
    pyQueueEvents,
    otherQueueEvents,
    queueNames,
    connection,
};
