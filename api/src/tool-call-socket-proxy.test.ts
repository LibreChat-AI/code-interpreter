import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
    createTokenBucket,
    defaultConnectionRateBurst,
    defaultConnectionRateRefillPerSec,
    startToolCallSocketProxy,
    type ToolCallSocketProxyHandle,
} from './tool-call-socket-proxy';

/* PTC-presence headers required by the proxy's filter so legitimate
 * /tool-call requests forward instead of getting the canonical 404. The
 * proxy only checks PRESENCE; cryptographic validation happens upstream. */
const PTC_HEADERS = {
    'X-Execution-ID': 'test-exec-id',
    'X-Tool-Call-ID': 'test-call-001',
    'X-Callback-Token': 'test-callback-token',
} as const;

const handles: ToolCallSocketProxyHandle[] = [];
const tempDirs: string[] = [];

function makeSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcs-proxy-test-'));
    tempDirs.push(dir);
    return path.join(dir, 'tcs.sock');
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createRawSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

async function startUpstream(): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/tool-call') {
            res.writeHead(404).end();
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    success: true,
                    body: Buffer.concat(chunks).toString('utf8'),
                }),
            );
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
        throw new Error('unexpected upstream address');
    }
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>(resolve => server.close(() => resolve())),
    };
}

afterEach(async () => {
    while (handles.length > 0) {
        await handles.pop()!.close();
    }
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('tool-call socket proxy', () => {
    test('forwards valid tool-call requests with Connection: close', async () => {
        const upstream = await startUpstream();
        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: upstream.url,
            idleSocketTimeoutMs: 100,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const response = await new Promise<{
            status: number;
            body: string;
            closeHeader: unknown;
        }>((resolve, reject) => {
            const req = http.request(
                {
                    socketPath,
                    method: 'POST',
                    path: '/tool-call',
                    headers: {
                        'Content-Type': 'application/json',
                        Connection: 'keep-alive',
                        ...PTC_HEADERS,
                    },
                },
                res => {
                    const chunks: Buffer[] = [];
                    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode ?? 0,
                            body: Buffer.concat(chunks).toString('utf8'),
                            closeHeader: res.headers.connection,
                        }),
                    );
                },
            );
            req.on('error', reject);
            req.end('{"tool_name":"safe","input":{}}');
        });

        expect(response.status).toBe(200);
        expect(response.closeHeader).toBe('close');
        expect(JSON.parse(response.body).body).toBe(
            '{"tool_name":"safe","input":{}}',
        );
        await upstream.close();
    });

    test('destroys idle raw connections so socket probes cannot pin FDs', async () => {
        const upstream = await startUpstream();
        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: upstream.url,
            idleSocketTimeoutMs: 50,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const sockets = await Promise.all(
            Array.from({ length: 8 }, () => createRawSocket(socketPath)),
        );

        await wait(250);

        expect(proxy.activeConnections()).toBe(0);
        for (const socket of sockets) {
            socket.destroy();
        }
        await upstream.close();
    });

    test('keeps socket connectable for per-job UID sandboxes', async () => {
        const upstream = await startUpstream();
        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: upstream.url,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        expect(fs.statSync(socketPath).mode & 0o777).toBe(0o666);
        await upstream.close();
    });

    test('caps active connections and drops excess clients', async () => {
        const upstream = await startUpstream();
        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: upstream.url,
            maxConnections: 2,
            idleSocketTimeoutMs: 500,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const sockets = await Promise.allSettled(
            Array.from({ length: 6 }, () => createRawSocket(socketPath)),
        );

        await wait(50);

        expect(
            sockets.filter(result => result.status === 'fulfilled').length,
        ).toBeGreaterThanOrEqual(2);
        expect(proxy.activeConnections()).toBeLessThanOrEqual(2);
        for (const result of sockets) {
            if (result.status === 'fulfilled') result.value.destroy();
        }
        await upstream.close();
    });

    test('caps active tool-call requests separately from raw socket connections', async () => {
        let releaseUpstream!: () => void;
        let upstreamCalls = 0;
        const upstreamReleased = new Promise<void>(resolve => {
            releaseUpstream = resolve;
        });
        const server = http.createServer(async (req, res) => {
            upstreamCalls += 1;
            req.resume();
            await new Promise<void>(resolve => req.on('end', resolve));
            await upstreamReleased;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (address == null || typeof address === 'string')
            throw new Error('bad address');

        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: `http://127.0.0.1:${address.port}`,
            maxConnections: 8,
            maxActiveRequests: 1,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const first = new Promise<number>((resolve, reject) => {
            const req = http.request(
                {
                    socketPath,
                    method: 'POST',
                    path: '/tool-call',
                    headers: PTC_HEADERS,
                },
                res => {
                    res.on('end', () => resolve(res.statusCode ?? 0));
                    res.resume();
                },
            );
            req.on('error', reject);
            req.end('{"tool_name":"slow","input":{}}');
        });

        while (proxy.activeRequests() < 1) {
            await wait(5);
        }

        const second = await new Promise<{
            status: number;
            body: string;
            retryAfter: unknown;
        }>((resolve, reject) => {
            const req = http.request(
                {
                    socketPath,
                    method: 'POST',
                    path: '/tool-call',
                    headers: PTC_HEADERS,
                },
                res => {
                    const chunks: Buffer[] = [];
                    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode ?? 0,
                            body: Buffer.concat(chunks).toString('utf8'),
                            retryAfter: res.headers['retry-after'],
                        }),
                    );
                },
            );
            req.on('error', reject);
            req.end('{"tool_name":"second","input":{}}');
        });

        expect(second.status).toBe(429);
        expect(second.retryAfter).toBe('1');
        expect(JSON.parse(second.body)).toEqual({
            success: false,
            error: 'Too many concurrent tool-call requests',
        });
        expect(upstreamCalls).toBe(1);

        releaseUpstream();
        expect(await first).toBe(200);
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    test('expires active tool-call requests instead of holding proxy FDs indefinitely', async () => {
        let upstreamCalls = 0;
        let resolveUpstreamSeen!: () => void;
        const upstreamSeen = new Promise<void>(resolve => {
            resolveUpstreamSeen = resolve;
        });
        const server = http.createServer((req, res) => {
            upstreamCalls += 1;
            req.resume();
            req.on('end', resolveUpstreamSeen);
            // Intentionally never respond; the proxy must time out and release its
            // active request/upstream budgets.
            void res;
        });
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (address == null || typeof address === 'string')
            throw new Error('bad address');

        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: `http://127.0.0.1:${address.port}`,
            maxActiveRequests: 1,
            activeRequestTimeoutMs: 50,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const client = await createRawSocket(socketPath);
        const body = '{"tool_name":"slow","input":{}}';
        client.end(
            [
                'POST /tool-call HTTP/1.1',
                'Host: localhost',
                'Content-Type: application/json',
                `Content-Length: ${Buffer.byteLength(body)}`,
                'Connection: close',
                'X-Execution-ID: t',
                'X-Tool-Call-ID: t',
                'X-Callback-Token: t',
                '',
                body,
            ].join('\r\n'),
        );

        await upstreamSeen;
        expect(upstreamCalls).toBe(1);
        expect(proxy.activeRequests()).toBe(1);
        expect(proxy.activeUpstreams()).toBe(1);

        const deadline = Date.now() + 500;
        while (proxy.activeUpstreams() > 0 && Date.now() < deadline) {
            await wait(5);
        }

        expect(proxy.activeRequests()).toBe(0);
        expect(proxy.activeUpstreams()).toBe(0);
        client.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    test('rejects oversized request bodies before proxying', async () => {
        let upstreamCalls = 0;
        const server = http.createServer((_req, res) => {
            upstreamCalls += 1;
            res.writeHead(200).end('unexpected');
        });
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (address == null || typeof address === 'string')
            throw new Error('bad address');

        const socketPath = makeSocketPath();
        const proxy = await startToolCallSocketProxy({
            socketPath,
            rawTarget: `http://127.0.0.1:${address.port}`,
            maxBodyBytes: 4,
            log: { log() {}, warn() {}, error() {} },
        });
        handles.push(proxy);

        const response = await new Promise<{ status: number; body: string }>(
            (resolve, reject) => {
                const req = http.request(
                    {
                        socketPath,
                        method: 'POST',
                        path: '/tool-call',
                        headers: PTC_HEADERS,
                    },
                    res => {
                        const chunks: Buffer[] = [];
                        res.on('data', chunk =>
                            chunks.push(Buffer.from(chunk)),
                        );
                        res.on('end', () =>
                            resolve({
                                status: res.statusCode ?? 0,
                                body: Buffer.concat(chunks).toString('utf8'),
                            }),
                        );
                    },
                );
                req.on('error', reject);
                req.end('too large');
            },
        );

        expect(response.status).toBe(413);
        expect(response.body).toBe('request body too large');
        expect(upstreamCalls).toBe(0);
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    /* Integration tests for the connection-rate limiter live in
     * tool-call-socket-proxy-runtime.test.ts. Bun's node:http compat layer
     * does not fire `'connection'` events, so the in-process proxy here
     * never invokes the rate-limiter code path under `bun test` — the
     * checks would pass vacuously. The runtime tests spawn the proxy as a
     * real Node subprocess, matching the production runtime. The pure
     * createTokenBucket logic is fully unit-tested below and runs fine
     * under either runtime. */
});

describe('createTokenBucket', () => {
    test('starts full at burst capacity', () => {
        const b = createTokenBucket({ burst: 10, refillPerSec: 1 });
        expect(b.tokens()).toBeCloseTo(10);
    });

    test('returns true until the bucket is drained, then false', () => {
        const b = createTokenBucket({
            burst: 3,
            refillPerSec: 0,
            now: () => 0,
        });
        expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(false);
        expect(b.tryConsume()).toBe(false);
    });

    test('refills at refillPerSec without exceeding the burst cap', () => {
        let t = 1000;
        const b = createTokenBucket({
            burst: 10,
            refillPerSec: 100,
            now: () => t,
        });
        /* Drain. */
        for (let i = 0; i < 10; i++) expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(false);
        /* Advance 50ms — 100/sec * 0.050 = 5 tokens. */
        t += 50;
        for (let i = 0; i < 5; i++) expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(false);
        /* Advance way more than burst's worth — capacity caps at 10, not
         * unbounded growth. */
        t += 10_000;
        expect(b.tokens()).toBeCloseTo(10);
    });

    test('refillPerSec=0 freezes the bucket once drained (test-determinism guarantee)', () => {
        const b = createTokenBucket({
            burst: 2,
            refillPerSec: 0,
            now: () => 0,
        });
        expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(true);
        /* No matter how much time we'd advance with a real clock, refill of
         * 0/sec adds zero tokens. */
        expect(b.tryConsume()).toBe(false);
        expect(b.tokens()).toBe(0);
    });
});

describe('connection-rate defaults scale with SANDBOX_MAX_CONCURRENT_JOBS', () => {
    /* Codex P2 follow-up on PR #1652: the previous fixed 20-accept/sec
     * refill would throttle legitimate sustained traffic on deployments
     * where maxConcurrentJobs is scaled up (e.g. 64), because the proxy's
     * other defaults (maxConnections, maxActiveRequests) already scale
     * from SANDBOX_MAX_CONCURRENT_JOBS but the rate limiter did not. */
    const originalEnv = process.env.SANDBOX_MAX_CONCURRENT_JOBS;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.SANDBOX_MAX_CONCURRENT_JOBS;
        } else {
            process.env.SANDBOX_MAX_CONCURRENT_JOBS = originalEnv;
        }
    });

    test('unset env keeps the fixed 64/20 defaults', () => {
        delete process.env.SANDBOX_MAX_CONCURRENT_JOBS;
        expect(defaultConnectionRateBurst()).toBe(64);
        expect(defaultConnectionRateRefillPerSec()).toBe(20);
    });

    test('small concurrency floors at the baseline (never tighter than the fixed defaults)', () => {
        process.env.SANDBOX_MAX_CONCURRENT_JOBS = '8';
        /* 8 * 4 = 32, but floor at 64 baseline. */
        expect(defaultConnectionRateBurst()).toBe(64);
        /* 8 * 2 = 16, but floor at 20 baseline. */
        expect(defaultConnectionRateRefillPerSec()).toBe(20);
    });

    test('mid concurrency scales burst proportionally', () => {
        process.env.SANDBOX_MAX_CONCURRENT_JOBS = '32';
        /* 32 * 4 = 128 (above 64 floor, below 256 ceiling). */
        expect(defaultConnectionRateBurst()).toBe(128);
        /* 32 * 2 = 64 (above 20 floor, below 200 ceiling). */
        expect(defaultConnectionRateRefillPerSec()).toBe(64);
    });

    test('high concurrency caps at the ceiling — bounded resource use even with extreme config', () => {
        process.env.SANDBOX_MAX_CONCURRENT_JOBS = '256';
        /* 256 * 4 = 1024, capped at 256 ceiling. */
        expect(defaultConnectionRateBurst()).toBe(256);
        /* 256 * 2 = 512, capped at 200 ceiling. */
        expect(defaultConnectionRateRefillPerSec()).toBe(200);
    });
});
