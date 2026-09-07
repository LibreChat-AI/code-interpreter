import { expect, test } from 'bun:test';
import { withHostedAppQueueDeadline } from './queue-deadline';

test('bounds unavailable Redis admission, not only an admitted job result', async () => {
  const start = Date.now();
  await expect(withHostedAppQueueDeadline(() => new Promise<never>(() => {}), 25))
    .rejects.toThrow('queue wait timed out');
  expect(Date.now() - start).toBeLessThan(500);
});

test('preserves completed results and failures within the queue deadline', async () => {
  expect(await withHostedAppQueueDeadline(async () => 'ready', 1_000)).toBe('ready');
  await expect(withHostedAppQueueDeadline(async () => { throw new Error('admission failed'); }, 1_000))
    .rejects.toThrow('admission failed');
});
