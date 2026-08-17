import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import express from 'express';
import { once } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { Request } from 'express';
import { applyPrincipal } from '../auth/principal';
import type { AuthenticatedRequest } from '../types';
import {
    createRateLimiter,
    keyGenerator,
    rateLimitResponseBody,
    setRateLimitRedisForTests,
} from './limits';

const servers: Server[] = [];

class TestRedisRateLimitStore {
    private readonly counters = new Map<
        string,
        { hits: number; expiresAt: number }
    >();
    private readonly scripts = new Map<string, string>();

    async call(
        command: string,
        ...args: (string | number | Buffer)[]
    ): Promise<unknown> {
        switch (command.toUpperCase()) {
            case 'SCRIPT': {
                const subcommand = String(args[0]).toUpperCase();
                if (subcommand !== 'LOAD') {
                    throw new Error(
                        `Unsupported SCRIPT subcommand: ${subcommand}`,
                    );
                }
                const script = String(args[1]);
                const sha = createHash('sha1').update(script).digest('hex');
                this.scripts.set(sha, script);
                return sha;
            }
            case 'EVALSHA':
                return this.evalRateLimitScript(args);
            case 'DECR': {
                const key = String(args[0]);
                const entry = this.counters.get(key);
                if (entry) entry.hits -= 1;
                return entry?.hits ?? 0;
            }
            case 'DEL':
                return this.counters.delete(String(args[0])) ? 1 : 0;
            default:
                throw new Error(`Unsupported Redis command: ${command}`);
        }
    }

    private evalRateLimitScript(args: (string | number | Buffer)[]): unknown[] {
        const sha = String(args[0]);
        if (!this.scripts.has(sha)) {
            throw new Error(`Unknown script: ${sha}`);
        }
        const key = String(args[2]);
        const now = Date.now();
        const entry = this.counters.get(key);
        const ttl = entry ? entry.expiresAt - now : -2;

        if (args.length === 3) {
            // get script: EVALSHA sha 1 key
            if (!entry || ttl <= 0) return [false, -2];
            return [entry.hits, ttl];
        }

        // increment script: EVALSHA sha 1 key windowMs
        const windowMs = Number(args[3]);
        if (!entry || ttl <= 0) {
            this.counters.set(key, { hits: 1, expiresAt: now + windowMs });
            return [1, windowMs];
        }

        entry.hits += 1;
        return [entry.hits, ttl];
    }
}

afterEach(async () => {
    setRateLimitRedisForTests();
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>((resolve, reject) => {
                    server.close(error => (error ? reject(error) : resolve()));
                }),
        ),
    );
});

async function startRateLimitedApp(
    max: number,
    windowMs: number,
): Promise<string> {
    const redis = new TestRedisRateLimitStore();
    setRateLimitRedisForTests(redis);

    const app = express();
    app.use((req, _res, next) => {
        applyPrincipal(req as AuthenticatedRequest, {
            userId: req.header('x-user-id') ?? 'user-a',
            tenantId: req.header('x-tenant-id') ?? 'tenant-a',
            principalSource:
                req.header('x-principal-source') ?? 'librechat_jwt',
            credentialId: req.header('x-credential-id'),
        });
        next();
    });
    app.post(
        '/v1/exec',
        createRateLimiter('test-exec', windowMs, max, {
            message: 'Too many CodeAPI execution requests.',
            structuredBody: true,
        }),
        (_req, res) => res.status(200).json({ ok: true }),
    );

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

function postExec(
    url: string,
    headers: Record<string, string> = {},
): Promise<Response> {
    return fetch(`${url}/v1/exec`, {
        method: 'POST',
        headers,
    });
}

describe('keyGenerator', () => {
    test('keys LibreChat JWT principals by tenant and user', () => {
        const req = {
            codeApiPrincipal: {
                userId: 'user-1',
                tenantId: 'tenant-1',
                principalSource: 'librechat_jwt',
            },
        } as unknown as Request;

        expect(keyGenerator(req)).toBe('tenant-1:user:user-1');
    });

    test('keys credential-bearing principals by user instead of credential', () => {
        const req = {
            codeApiPrincipal: {
                userId: 'user-1',
                tenantId: 'tenant-1',
                principalSource: 'librechat_jwt',
                credentialId: 'key-1',
            },
        } as unknown as Request;

        expect(keyGenerator(req)).toBe('tenant-1:user:user-1');
    });

    test('shares a limiter bucket across principal sources for the same tenant user', () => {
        const libreChatReq = {
            codeApiPrincipal: {
                userId: 'user-1',
                tenantId: 'tenant-1',
                principalSource: 'librechat_jwt',
            },
        } as unknown as Request;
        const legacyReq = {
            codeApiPrincipal: {
                userId: 'user-1',
                tenantId: 'tenant-1',
                principalSource: 'openid_reuse',
                credentialId: 'key-1',
            },
        } as unknown as Request;

        expect(keyGenerator(libreChatReq)).toBe(keyGenerator(legacyReq));
    });
});

describe('execution rate limiting', () => {
    test('allows requests up to the configured limit and rejects the next request with retry guidance', async () => {
        const url = await startRateLimitedApp(2, 30_000);

        expect((await postExec(url)).status).toBe(200);
        expect((await postExec(url)).status).toBe(200);
        const rejected = await postExec(url);
        const body = (await rejected.json()) as ReturnType<
            typeof rateLimitResponseBody
        >;

        expect(rejected.status).toBe(429);
        expect(rejected.headers.get('ratelimit-limit')).toBe('2');
        expect(rejected.headers.get('ratelimit-remaining')).toBe('0');
        expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(body.error).toBe('rate_limited');
        expect(body.message).toContain('Too many CodeAPI execution requests.');
        expect(body.retry_after_seconds).toBeGreaterThan(0);
    });

    test('does not count one user against another user window', async () => {
        const url = await startRateLimitedApp(1, 30_000);

        expect((await postExec(url, { 'x-user-id': 'user-a' })).status).toBe(
            200,
        );
        expect((await postExec(url, { 'x-user-id': 'user-a' })).status).toBe(
            429,
        );
        expect((await postExec(url, { 'x-user-id': 'user-b' })).status).toBe(
            200,
        );
    });

    test('counts the same user across auth sources in one window', async () => {
        const url = await startRateLimitedApp(1, 30_000);

        expect(
            (
                await postExec(url, {
                    'x-user-id': 'user-a',
                    'x-principal-source': 'librechat_jwt',
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await postExec(url, {
                    'x-user-id': 'user-a',
                    'x-principal-source': 'openid_reuse',
                    'x-credential-id': 'key-1',
                })
            ).status,
        ).toBe(429);
    });

    test('keeps concurrent rate-limit decisions isolated per user', async () => {
        const url = await startRateLimitedApp(1, 30_000);

        expect((await postExec(url, { 'x-user-id': 'user-a' })).status).toBe(
            200,
        );

        const [limitedUser, otherUser] = await Promise.all([
            postExec(url, { 'x-user-id': 'user-a' }),
            postExec(url, { 'x-user-id': 'user-b' }),
        ]);

        expect(limitedUser.status).toBe(429);
        expect(otherUser.status).toBe(200);
    });

    test('allows the same user again after the window resets', async () => {
        const url = await startRateLimitedApp(1, 50);

        expect((await postExec(url)).status).toBe(200);
        expect((await postExec(url)).status).toBe(429);
        await new Promise(resolve => setTimeout(resolve, 125));
        expect((await postExec(url)).status).toBe(200);
    });
});
