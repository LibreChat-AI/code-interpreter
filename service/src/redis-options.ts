import type { CommonRedisOptions } from 'ioredis';

/** Long-lived queue/cancellation command and subscriber connections must both
 * recover after an outage. Never leave a live process with a terminal client. */
export function redisReconnectDelay(attempt: number): number {
  return Math.min(2_000, 100 * Math.max(1, attempt));
}

export function redisKeepAliveMs(): number {
  const raw = process.env.REDIS_KEEP_ALIVE_MS;
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed === '') {
    return 0;
  }

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return 0;
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

export function redisKeepAliveOptions(): Pick<CommonRedisOptions, 'keepAlive'> {
  const keepAlive = redisKeepAliveMs();
  return keepAlive > 0 ? { keepAlive } : {};
}
