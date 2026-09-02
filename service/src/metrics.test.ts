import { afterEach, expect, test } from 'bun:test';
import {
  bullmqQueueJobs,
  configureExecutionProfileMetrics,
  executionProfileInfo,
  metricsResponse,
  registerBullmqQueueMetricsCollector,
} from './metrics';

afterEach(() => {
  registerBullmqQueueMetricsCollector(undefined);
  bullmqQueueJobs.set({ queue: 'other-queue', state: 'waiting' }, 0);
  executionProfileInfo.reset();
});

test('execution identity is published only when an API or worker configures it', async () => {
  executionProfileInfo.reset();
  expect((await metricsResponse()).body).not.toContain('codeapi_execution_profile_info{');

  configureExecutionProfileMetrics({
    profile: 'stateful',
    sandboxBackend: 'lambda-microvm',
    runtimeSessionMode: 'affinity',
  });

  expect((await metricsResponse()).body).toContain(
    'codeapi_execution_profile_info{profile="stateful",sandbox_backend="lambda-microvm",runtime_session_mode="affinity"} 1',
  );
});

test('metricsResponse collects BullMQ queue gauges on scrape', async () => {
  let calls = 0;
  registerBullmqQueueMetricsCollector(() => {
    calls += 1;
    bullmqQueueJobs.set({ queue: 'other-queue', state: 'waiting' }, 42);
  });

  const { body } = await metricsResponse();

  expect(calls).toBe(1);
  expect(body).toContain('codeapi_bullmq_queue_jobs{queue="other-queue",state="waiting"} 42');
});
