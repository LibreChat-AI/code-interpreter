import { afterEach, describe, expect, test } from 'bun:test';
import { redisKeepAliveMs, redisKeepAliveOptions } from './redis-options';

describe('Redis keepalive options', () => {
    afterEach(() => {
        delete process.env.REDIS_KEEP_ALIVE_MS;
    });

    test('defaults to disabled', () => {
        expect(redisKeepAliveMs()).toBe(0);
        expect(redisKeepAliveOptions()).toEqual({});
    });

    test('uses a positive integer keepalive delay', () => {
        process.env.REDIS_KEEP_ALIVE_MS = '300000';

        expect(redisKeepAliveMs()).toBe(300000);
        expect(redisKeepAliveOptions()).toEqual({ keepAlive: 300000 });
    });

    test('rounds fractional values down', () => {
        process.env.REDIS_KEEP_ALIVE_MS = '300000.9';

        expect(redisKeepAliveMs()).toBe(300000);
        expect(redisKeepAliveOptions()).toEqual({ keepAlive: 300000 });
    });

    test('ignores invalid values', () => {
        process.env.REDIS_KEEP_ALIVE_MS = '-1';
        expect(redisKeepAliveOptions()).toEqual({});

        process.env.REDIS_KEEP_ALIVE_MS = 'not-a-number';
        expect(redisKeepAliveOptions()).toEqual({});
    });

    test('ignores non-decimal numeric syntax', () => {
        process.env.REDIS_KEEP_ALIVE_MS = '1e3';
        expect(redisKeepAliveOptions()).toEqual({});

        process.env.REDIS_KEEP_ALIVE_MS = '0x10';
        expect(redisKeepAliveOptions()).toEqual({});
    });
});
