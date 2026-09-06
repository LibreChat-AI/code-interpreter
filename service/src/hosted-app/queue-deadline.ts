/** BullMQ starts its result timer after Redis readiness; bound admission too.
 * A timed-out submission may still be admitted and must remain idempotent. */
export async function withHostedAppQueueDeadline<T>(work: () => Promise<T>, waitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Hosted app queue wait timed out')), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
