import type { CommonRedisOptions } from 'ioredis';

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
