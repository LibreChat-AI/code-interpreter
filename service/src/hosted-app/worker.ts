import { Worker } from 'bullmq';
import { env } from '../config';
import { connection } from '../queue';
import { withSpan, withTraceContext } from '../telemetry';
import { HostedAppControlPlaneError } from './control-plane';
import type { HostedAppJob, HostedAppJobData, HostedAppJobName, HostedAppJobResult } from './jobs';
import { HOSTED_APP_QUEUE_NAME } from './queue';
import logger from '../logger';
import { workerRunning } from '../metrics';

function serializedFailure(error: unknown): Error {
  if (error instanceof HostedAppControlPlaneError) {
    return new Error(JSON.stringify({
      code: error.code,
      status: error.status,
      message: error.message,
      transient: error.transient,
    }));
  }
  return error instanceof Error ? error : new Error('Hosted app operation failed');
}

export async function processHostedAppJob(job: HostedAppJob): Promise<HostedAppJobResult> {
  return withTraceContext(job.data._otel, () => withSpan('codeapi.hosted_app.process', {
    'messaging.system': 'bullmq',
    'messaging.operation.name': job.name,
    'messaging.message.id': String(job.id ?? ''),
    'codeapi.hosted_app.id': job.data.hostedAppRuntimeId,
  }, async () => {
    const controller = new AbortController();
    const timeoutMs = env.CHECKPOINT_TIMEOUT_MS * 2
      + env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS * 3
      + env.HOSTED_APP_START_TIMEOUT_MS
      + 30_000;
    const timer = setTimeout(
      () => controller.abort(new Error(`Hosted app operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    try {
      /* Keep AWS SDK and checkpoint-store construction out of default-profile
       * workers; this import is reached only by an enabled hosted-app job. */
      const control = (await import('./factory')).getHostedAppControlPlane();
      if (job.name === 'hosted-app:start' && job.data.operation === 'start') {
        return await control.start({
          ...job.data,
          signal: controller.signal,
        });
      }
      if (job.name === 'hosted-app:stop' && job.data.operation === 'stop') {
        return await control.stop(
          job.data.hostedAppRuntimeId,
          job.data,
          controller.signal,
        );
      }
      if (
        job.name === 'hosted-app:refresh-preview'
        && job.data.operation === 'refresh-preview'
      ) {
        return await control.refreshPreview(
          job.data.hostedAppRuntimeId,
          job.data,
          controller.signal,
        );
      }
      throw new HostedAppControlPlaneError(
        'hosted_app_job_invalid',
        'Hosted app job name and payload do not match',
        400,
      );
    } catch (error) {
      throw serializedFailure(error);
    } finally {
      clearTimeout(timer);
    }
  }, 'CONSUMER'));
}

export const hostedAppWorker: Worker<
  HostedAppJobData,
  HostedAppJobResult,
  HostedAppJobName
> | undefined = env.HOSTED_APPS_ENABLED
  ? new Worker(HOSTED_APP_QUEUE_NAME, processHostedAppJob, {
    connection,
    /* Lifecycle transitions are serialized again by their per-app Redis lock.
     * This modest concurrency allows unrelated apps to launch in parallel while
     * the fleet-wide AWS throttle remains authoritative. */
    concurrency: Math.max(1, Math.min(env.OTHER_CONCURRENCY, 4)),
  })
  : undefined;

if (hostedAppWorker) workerRunning.set({ worker_type: 'hosted-app' }, 1);

hostedAppWorker?.on('failed', (job, error) => {
  logger.error('Hosted app job failed', { jobId: job?.id, error });
});
hostedAppWorker?.on('error', error => {
  logger.error('Hosted app worker error', { error });
  workerRunning.set({ worker_type: 'hosted-app' }, 0);
});
hostedAppWorker?.on('closed', () => {
  workerRunning.set({ worker_type: 'hosted-app' }, 0);
});
