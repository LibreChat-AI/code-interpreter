import { Queue, QueueEvents } from 'bullmq';
import { setMaxListeners } from 'node:events';
import { nanoid } from 'nanoid';
import { connection } from '../queue';
import { env } from '../config';
import type { HostedAppJobData, HostedAppJobName, HostedAppJobResult } from './jobs';

/** Hosted apps are stateful-only. A fixed isolated queue prevents an ordinary
 * stateless worker from ever receiving an AWS lifecycle job. */
export const HOSTED_APP_QUEUE_NAME = 'stateful-hosted-app-queue';

type HostedAppQueue = Queue<
  HostedAppJobData,
  HostedAppJobResult,
  HostedAppJobName
>;

let hostedAppQueue: HostedAppQueue | undefined;
let hostedAppQueueEvents: QueueEvents | undefined;

function resources(): { queue: HostedAppQueue; events: QueueEvents } {
  if (!hostedAppQueue || !hostedAppQueueEvents) {
    hostedAppQueue = new Queue<HostedAppJobData, HostedAppJobResult, HostedAppJobName>(
      HOSTED_APP_QUEUE_NAME,
      { connection },
    );
    hostedAppQueueEvents = new QueueEvents(HOSTED_APP_QUEUE_NAME, { connection });
    setMaxListeners(0, hostedAppQueue, hostedAppQueueEvents);
  }
  return { queue: hostedAppQueue, events: hostedAppQueueEvents };
}

/* A cold start can capture (pull + store), restore (load + push), launch, wait
 * for control, start the process, and mint preview credentials. Budget every
 * independently bounded leg so the queue waiter cannot abandon valid work. */
const HOSTED_APP_OPERATION_WAIT_MS = env.CHECKPOINT_TIMEOUT_MS * 5
  + env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS * 7
  + env.HOSTED_APP_START_TIMEOUT_MS
  + 45_000;

export async function submitHostedAppJob(
  name: HostedAppJobName,
  data: HostedAppJobData,
  jobId = `happ-${nanoid()}`,
): Promise<HostedAppJobResult> {
  const { queue, events } = resources();
  const job = await queue.add(name, data, {
    jobId,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 1_000 },
  });
  return job.waitUntilFinished(events, HOSTED_APP_OPERATION_WAIT_MS);
}

/** No-op unless this process submitted hosted-app work. Keeping construction
 * lazy means disabled/default-profile services create no extra Redis clients. */
export async function closeHostedAppQueueResources(): Promise<void> {
  const queue = hostedAppQueue;
  const events = hostedAppQueueEvents;
  hostedAppQueue = undefined;
  hostedAppQueueEvents = undefined;
  await Promise.all([
    ...(queue ? [queue.close()] : []),
    ...(events ? [events.close()] : []),
  ]);
}
