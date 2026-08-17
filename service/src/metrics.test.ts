import { afterEach, expect, test } from 'bun:test';
import {
    bullmqQueueJobs,
    metricsResponse,
    registerBullmqQueueMetricsCollector,
} from './metrics';

afterEach(() => {
    registerBullmqQueueMetricsCollector(undefined);
    bullmqQueueJobs.set({ queue: 'other-queue', state: 'waiting' }, 0);
});

test('metricsResponse collects BullMQ queue gauges on scrape', async () => {
    let calls = 0;
    registerBullmqQueueMetricsCollector(() => {
        calls += 1;
        bullmqQueueJobs.set({ queue: 'other-queue', state: 'waiting' }, 42);
    });

    const { body } = await metricsResponse();

    expect(calls).toBe(1);
    expect(body).toContain(
        'codeapi_bullmq_queue_jobs{queue="other-queue",state="waiting"} 42',
    );
});
