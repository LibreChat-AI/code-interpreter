import { describe, expect, test, afterEach } from 'bun:test';
import {
    parseRedisNodes,
    isClusterMode,
    buildTlsOptions,
    bullmqPrefix,
} from './redis-connection';

// ──────────────────────────────────────────────────────────────────────────────
// We test the pure helper functions from redis-connection.ts without
// establishing any real network connection.  ioredis constructors are NOT
// called in these tests.
// ──────────────────────────────────────────────────────────────────────────────

// Preserve original env so each test can start clean
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of Object.keys(process.env)) {
    if (key.startsWith('REDIS_') || key === 'USE_REDIS_CLUSTER') {
        ORIGINAL_ENV[key] = process.env[key];
    }
}

function resetEnv(overrides: Record<string, string | undefined> = {}): void {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('REDIS_') || key === 'USE_REDIS_CLUSTER') {
            delete process.env[key];
        }
    }
    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) process.env[k] = v;
    }
}

afterEach(() => {
    resetEnv(ORIGINAL_ENV);
});

// ──────────────────────────────────────────────────────────────────────────────
// parseRedisNodes
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRedisNodes', () => {
    test('single host uses REDIS_PORT default 6379', () => {
        resetEnv({ REDIS_HOST: 'myhost' });
        expect(parseRedisNodes()).toEqual([{ host: 'myhost', port: 6379 }]);
    });

    test('single host with embedded port', () => {
        resetEnv({ REDIS_HOST: 'myhost:6380' });
        expect(parseRedisNodes()).toEqual([{ host: 'myhost', port: 6380 }]);
    });

    test('comma-separated hosts without ports', () => {
        resetEnv({ REDIS_HOST: 'node1,node2,node3', REDIS_PORT: '6380' });
        expect(parseRedisNodes()).toEqual([
            { host: 'node1', port: 6380 },
            { host: 'node2', port: 6380 },
            { host: 'node3', port: 6380 },
        ]);
    });

    test('comma-separated hosts with embedded ports', () => {
        resetEnv({ REDIS_HOST: 'node1:6379,node2:6380,node3:6381' });
        expect(parseRedisNodes()).toEqual([
            { host: 'node1', port: 6379 },
            { host: 'node2', port: 6380 },
            { host: 'node3', port: 6381 },
        ]);
    });

    test('trims whitespace around entries', () => {
        resetEnv({ REDIS_HOST: ' node1 , node2 ' });
        expect(parseRedisNodes()).toEqual([
            { host: 'node1', port: 6379 },
            { host: 'node2', port: 6379 },
        ]);
    });

    test('defaults to "redis" when REDIS_HOST is unset', () => {
        resetEnv({});
        expect(parseRedisNodes()).toEqual([{ host: 'redis', port: 6379 }]);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// isClusterMode
// ──────────────────────────────────────────────────────────────────────────────

describe('isClusterMode', () => {
    test('false by default', () => {
        resetEnv({ REDIS_HOST: 'redis' });
        expect(isClusterMode()).toBe(false);
    });

    test('true when USE_REDIS_CLUSTER=true', () => {
        resetEnv({ REDIS_HOST: 'redis', USE_REDIS_CLUSTER: 'true' });
        expect(isClusterMode()).toBe(true);
    });

    test('true when REDIS_HOST contains a comma', () => {
        resetEnv({ REDIS_HOST: 'node1,node2' });
        expect(isClusterMode()).toBe(true);
    });

    test('false when REDIS_HOST is a single host', () => {
        resetEnv({
            REDIS_HOST: 'single-host:6379',
            USE_REDIS_CLUSTER: 'false',
        });
        expect(isClusterMode()).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildTlsOptions
// ──────────────────────────────────────────────────────────────────────────────

describe('buildTlsOptions', () => {
    test('returns undefined when neither REDIS_TLS nor REDIS_CA is set', () => {
        resetEnv({});
        expect(buildTlsOptions()).toBeUndefined();
    });

    test('returns { rejectUnauthorized: false } when REDIS_TLS=true and no CA', () => {
        resetEnv({ REDIS_TLS: 'true' });
        expect(buildTlsOptions()).toEqual({ rejectUnauthorized: false });
    });

    test('returns { ca } when REDIS_CA points to an existing file', () => {
        const tmpFile = '/tmp/test-redis-ca.pem';
        const pem =
            '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';
        const { writeFileSync, unlinkSync } =
            require('fs') as typeof import('fs');
        writeFileSync(tmpFile, pem, 'utf8');

        resetEnv({ REDIS_CA: tmpFile });
        try {
            expect(buildTlsOptions()).toEqual({ ca: pem });
        } finally {
            unlinkSync(tmpFile);
        }
    });

    test('CA takes precedence over REDIS_TLS=true', () => {
        const tmpFile = '/tmp/test-redis-ca2.pem';
        const pem =
            '-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n';
        const { writeFileSync, unlinkSync } =
            require('fs') as typeof import('fs');
        writeFileSync(tmpFile, pem, 'utf8');

        resetEnv({ REDIS_CA: tmpFile, REDIS_TLS: 'true' });
        try {
            expect(buildTlsOptions()).toEqual({ ca: pem });
        } finally {
            unlinkSync(tmpFile);
        }
    });

    test('returns undefined when REDIS_CA file does not exist', () => {
        resetEnv({ REDIS_CA: '/tmp/does-not-exist-ca-xyz.pem' });
        expect(buildTlsOptions()).toBeUndefined();
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// bullmqPrefix
// ──────────────────────────────────────────────────────────────────────────────

describe('bullmqPrefix', () => {
    test('returns undefined in standalone mode', () => {
        resetEnv({ REDIS_HOST: 'redis' });
        expect(bullmqPrefix()).toBeUndefined();
    });

    test('returns "{codeapi}" in cluster mode via USE_REDIS_CLUSTER', () => {
        resetEnv({ USE_REDIS_CLUSTER: 'true' });
        expect(bullmqPrefix()).toBe('{codeapi}');
    });

    test('returns "{codeapi}" when REDIS_HOST contains multiple nodes', () => {
        resetEnv({ REDIS_HOST: 'node1,node2,node3' });
        expect(bullmqPrefix()).toBe('{codeapi}');
    });
});
