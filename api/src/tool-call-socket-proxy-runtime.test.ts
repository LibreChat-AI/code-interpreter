/**
 * Runtime regression tests for the tool-call socket proxy.
 *
 * The tests in `tool-call-socket-proxy.test.ts` instantiate the proxy
 * in-process via `startToolCallSocketProxy()` under bun:test. That is fine
 * for verifying request-handler logic, but it CANNOT catch the audit DoS
 * because Bun's node:http compat layer never fires `'connection'` events
 * and Bun.serve's idleTimeout doesn't close silent unix-socket connects —
 * so `activeConnections()`, `maxConnections`, and `idleSocketTimeoutMs`
 * silently no-op when the proxy is hosted by Bun. The in-process tests
 * pass vacuously (counters stay 0) while the production runtime is
 * unprotected.
 *
 * In production the proxy runs under Node (see api/Dockerfile + the
 * entrypoint.sh edit). These tests spawn the BUILT proxy bundle as a
 * Node subprocess so the runtime under test matches production exactly.
 *
 * Skipped automatically when:
 *   - `node` isn't on PATH (CI without Node)
 *   - `.build/tool-call-socket-proxy.cjs` doesn't exist (test invoked
 *     before `bun run build`)
 *   - we're on Windows (unix sockets in temp dirs hit AppData EACCES
 *     quirks; production is Linux)
 */
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const PROXY_BUNDLE = path.resolve(
    __dirname,
    '..',
    '.build',
    'tool-call-socket-proxy.cjs',
);
const NODE_AVAILABLE = (() => {
    try {
        return (
            spawnSync('node', ['--version'], { stdio: 'ignore' }).status === 0
        );
    } catch {
        return false;
    }
})();
const SHOULD_RUN =
    NODE_AVAILABLE &&
    fs.existsSync(PROXY_BUNDLE) &&
    process.platform !== 'win32';

const describeIfRuntime = SHOULD_RUN ? describe : describe.skip;

interface UpstreamHandle {
    server: http.Server;
    url: string;
    calls: () => number;
    close: () => Promise<void>;
}

interface ProxyHandle {
    socketPath: string;
    proc: ChildProcess;
    stop: () => Promise<void>;
}

let workdir: string;

beforeAll(() => {
    if (!NODE_AVAILABLE) {
        console.warn('[tcs-proxy-runtime] skipping: `node` not on PATH');
    } else if (!fs.existsSync(PROXY_BUNDLE)) {
        console.warn(
            `[tcs-proxy-runtime] skipping: ${PROXY_BUNDLE} missing — run \`bun run build\` first`,
        );
    } else if (process.platform === 'win32') {
        console.warn(
            '[tcs-proxy-runtime] skipping: Windows (unix-socket EACCES quirk); production is Linux',
        );
    }
});

beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tcs-proxy-runtime-'));
});

afterEach(async () => {
    if (workdir) await fsp.rm(workdir, { recursive: true, force: true });
});

async function startUpstream(
    handler?: http.RequestListener,
): Promise<UpstreamHandle> {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls++;
        if (handler) return handler(req, res);
        let total = 0;
        req.on('data', chunk => {
            total += chunk.length;
        });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, received: total }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string')
        throw new Error('upstream listen failed');
    return {
        server,
        url: `http://127.0.0.1:${addr.port}`,
        calls: () => calls,
        close: () => new Promise(r => server.close(() => r())),
    };
}

async function spawnProxy(opts: {
    upstreamUrl: string;
    env?: Record<string, string>;
}): Promise<ProxyHandle> {
    const socketPath = path.join(
        workdir,
        `tcs-${Math.random().toString(36).slice(2)}.sock`,
    );
    const proc = spawn('node', [PROXY_BUNDLE], {
        env: {
            ...process.env,
            TCS_SOCKET: socketPath,
            SANDBOX_FORWARD_TARGET: opts.upstreamUrl,
            ...(opts.env || {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    /* Wait for the proxy to be connectable. fs.existsSync on a unix socket
     * is unreliable on some platforms; try-connect-then-disconnect is the
     * authoritative readiness probe. */
    let ready = false;
    for (let i = 0; i < 50; i++) {
        try {
            const probe = net.createConnection(socketPath);
            await new Promise<void>((res, rej) => {
                probe.once('connect', () => {
                    probe.destroy();
                    res();
                });
                probe.once('error', rej);
            });
            ready = true;
            break;
        } catch {
            /* not yet */
        }
        await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) {
        proc.kill('SIGKILL');
        throw new Error('proxy never became connectable');
    }

    return {
        socketPath,
        proc,
        stop: async () => {
            proc.kill('SIGTERM');
            await new Promise<void>(r => {
                const killTimer = setTimeout(() => {
                    proc.kill('SIGKILL');
                    r();
                }, 1000);
                proc.once('exit', () => {
                    clearTimeout(killTimer);
                    r();
                });
            });
        },
    };
}

function rawConnect(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
    });
}

function slowHeaderConnect(
    socketPath: string,
    dripEveryMs: number,
): Promise<{ socket: net.Socket; close: () => void }> {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        let drip: ReturnType<typeof setInterval> | undefined;
        const clearDrip = (): void => {
            if (drip) clearInterval(drip);
            drip = undefined;
        };
        const onInitialError = (error: Error): void => {
            clearDrip();
            reject(error);
        };

        sock.once('error', onInitialError);
        sock.once('connect', () => {
            sock.off('error', onInitialError);
            sock.on('error', () => {
                /* connection was destroyed by the proxy */
            });
            sock.once('close', clearDrip);
            sock.write('POST /tool-call HTTP/1.1\r\nHost: x\r\nX-Drip: ');
            drip = setInterval(() => {
                if (sock.destroyed) {
                    clearDrip();
                    return;
                }
                try {
                    sock.write('x');
                } catch {
                    clearDrip();
                }
            }, dripEveryMs);
            resolve({
                socket: sock,
                close: () => {
                    clearDrip();
                    sock.destroy();
                },
            });
        });
    });
}

/* The proxy's PTC-presence filter rejects /tool-call requests that lack
 * the SDK-supplied headers (canonical 404 — see proxy source for why).
 * Tests that want to exercise the forwarding path supply matching shape
 * here. Cryptographic validation is the upstream's job; presence is the
 * proxy's. */
const PTC_HEADERS = {
    'X-Execution-ID': 'test-exec-id',
    'X-Tool-Call-ID': 'test-call-001',
    'X-Callback-Token': 'test-callback-token',
} as const;

function postToolCall(
    socketPath: string,
    body: string,
    extraHeaders: Record<string, string | number> = {},
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                socketPath,
                method: 'POST',
                path: '/tool-call',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...PTC_HEADERS,
                    ...extraHeaders,
                },
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString(),
                    }),
                );
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

describeIfRuntime(
    'tool-call-socket-proxy under Node runtime (production parity)',
    () => {
        test('forwards a normal POST /tool-call', async () => {
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                const res = await postToolCall(proxy.socketPath, '{"x":1}');
                expect(res.status).toBe(200);
                expect(JSON.parse(res.body)).toEqual({ ok: true, received: 7 });
                expect(upstream.calls()).toBe(1);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('SILENT-CONNECTION DoS: idle accept-then-do-nothing connections close before they pin FDs', async () => {
            /* This is the audit's actual attack:
             *   for i in range(N): socket.connect('/tmp/tcs.sock')
             * Open many connections without writing anything. Without the Node
             * runtime + working `'connection'` events + working socket.setTimeout,
             * each accepted FD sits in the proxy until the OS limit. With them
             * all working, every FD must be reclaimed within a small multiple of
             * idleSocketTimeoutMs. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({
                upstreamUrl: upstream.url,
                env: {
                    /* defaults: idle 2s, max 64. Test against the production defaults. */
                },
            });
            try {
                const sockets: net.Socket[] = [];
                for (let i = 0; i < 32; i++) {
                    try {
                        sockets.push(await rawConnect(proxy.socketPath));
                    } catch {
                        /* over-cap rejection is fine — also "didn't pin a FD" */
                    }
                }
                /* Wait for idle timer (default 2000ms) + slack. */
                const start = Date.now();
                const closeTimes = await Promise.all(
                    sockets.map(
                        s =>
                            new Promise<number>(resolve => {
                                if (s.destroyed) {
                                    resolve(0);
                                    return;
                                }
                                s.once('close', () =>
                                    resolve(Date.now() - start),
                                );
                                setTimeout(() => resolve(-1), 8000);
                            }),
                    ),
                );
                const closed = closeTimes.filter(t => t >= 0).length;
                const stuck = closeTimes.filter(t => t < 0).length;
                expect(stuck).toBe(0);
                /* All idle FDs must be reclaimed within a small multiple of the
                 * default idleSocketTimeoutMs (2s). Slack is generous. */
                const maxClose = Math.max(...closeTimes);
                expect(maxClose).toBeLessThan(7000);
                expect(closed).toBeGreaterThan(0);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('legitimate POST still succeeds after a silent-connection storm clears', async () => {
            /* Regression guard for the actual user-facing failure: while
             * malicious code spams idle connections, real tool calls from
             * sibling sandboxes must still succeed. With the default cap (64)
             * and idleSocketTimeoutMs=2s, we open the storm, wait ~2.5s for
             * the proxy to reclaim those FDs, then verify a real POST works. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            const stormSockets: net.Socket[] = [];
            try {
                for (let i = 0; i < 32; i++) {
                    try {
                        stormSockets.push(await rawConnect(proxy.socketPath));
                    } catch {
                        /* over-cap rejection is fine */
                    }
                }
                /* Let the proxy's idleSocketTimeoutMs (default 2s) reclaim FDs. */
                await new Promise(r => setTimeout(r, 2500));
                const res = await postToolCall(
                    proxy.socketPath,
                    '{"during":"storm"}',
                );
                expect(res.status).toBe(200);
                expect(JSON.parse(res.body)).toEqual({
                    ok: true,
                    received: 18,
                });
            } finally {
                stormSockets.forEach(s => {
                    try {
                        s.destroy();
                    } catch {
                        /* ignore */
                    }
                });
                await proxy.stop();
                await upstream.close();
            }
        });

        test(
            'CIRCUMVENTION: slow incomplete headers cannot starve all connection slots',
            async () => {
                /* Header-drip clients are more subtle than silent sockets: they send
                 * bytes under the idle timeout, so socket.setTimeout never fires. The
                 * proxy must still reclaim each accepted socket on an absolute
                 * accept-to-headers deadline before all maxConnections slots can be held. */
                const upstream = await startUpstream();
                const proxy = await spawnProxy({
                    upstreamUrl: upstream.url,
                    env: {
                        TCS_MAX_CONNECTIONS: '4',
                        TCS_HEADER_TIMEOUT_MS: '500',
                        TCS_CONNECTION_RATE_BURST: '32',
                        TCS_CONNECTION_RATE_REFILL_PER_SEC: '200',
                    },
                });
                const drips: Array<{ socket: net.Socket; close: () => void }> =
                    [];

                try {
                    for (let i = 0; i < 4; i++) {
                        drips.push(
                            await slowHeaderConnect(proxy.socketPath, 100),
                        );
                    }

                    await new Promise(r => setTimeout(r, 900));

                    const res = await postToolCall(proxy.socketPath, '{"x":1}');
                    expect(res.status).toBe(200);
                    expect(JSON.parse(res.body)).toEqual({
                        ok: true,
                        received: 7,
                    });
                    expect(upstream.calls()).toBe(1);
                } finally {
                    drips.forEach(drip => drip.close());
                    await proxy.stop();
                    await upstream.close();
                }
            },
            { timeout: 10_000 },
        );

        test('CIRCUMVENTION: HTTP request smuggling (Content-Length + Transfer-Encoding) does not reach upstream', async () => {
            /* The classic CL.TE / TE.CL smuggling primitive: send both headers
             * with conflicting interpretations. If the proxy and upstream
             * disagree on body boundary, the attacker can prepend bytes to a
             * synthesized "second request" that bypasses the path filter and
             * could reach a different upstream route. The defense per RFC 7230
             * §3.3.3 is to reject the request rather than try to reconcile.
             * Whether node:http rejects in its own parser or our isSmugglingShaped
             * gate fires first, the security property is the same: upstream
             * must never see the smuggled bytes. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                const sock = await rawConnect(proxy.socketPath);
                const smuggled =
                    'POST /tool-call HTTP/1.1\r\n' +
                    'Host: x\r\n' +
                    'Content-Length: 13\r\n' +
                    'Transfer-Encoding: chunked\r\n' +
                    'Connection: close\r\n' +
                    '\r\n' +
                    '0\r\n\r\n' +
                    'POST /admin HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
                sock.write(smuggled);
                await new Promise<void>(resolve => {
                    sock.once('close', () => resolve());
                    setTimeout(resolve, 3000);
                });
                /* Critical security property: upstream MUST NOT have been called. */
                expect(upstream.calls()).toBe(0);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('CIRCUMVENTION: hop-by-hop headers (Connection, Upgrade, TE, Trailer, Transfer-Encoding) do not reach upstream', async () => {
            /* RFC 7230 §6.1: a proxy MUST NOT forward hop-by-hop headers. If we
             * leak them through, an upstream that treats Upgrade specially could
             * be coerced into an unexpected protocol switch, and Transfer-
             * Encoding pollution feeds smuggling chains at the next hop. */
            let receivedHeaders: http.IncomingHttpHeaders = {};
            const upstream = await startUpstream((req, res) => {
                receivedHeaders = req.headers;
                let total = 0;
                req.on('data', c => {
                    total += c.length;
                });
                req.on('end', () => {
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        Connection: 'keep-alive',
                    });
                    res.end(JSON.stringify({ ok: true, received: total }));
                });
            });
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                const body = '{"x":1}';
                const reply = await new Promise<{
                    status: number;
                    body: string;
                    headers: http.IncomingHttpHeaders;
                }>((resolve, reject) => {
                    const req = http.request(
                        {
                            socketPath: proxy.socketPath,
                            method: 'POST',
                            path: '/tool-call',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(body),
                                /* PTC presence required to forward (proxy filter). */
                                ...PTC_HEADERS,
                                /* Hop-by-hop headers we expect the proxy to strip: */
                                Connection:
                                    'keep-alive, Upgrade-Insecure-Requests',
                                'Keep-Alive': 'timeout=300, max=1000',
                                Upgrade: 'websocket',
                                TE: 'trailers',
                                Trailer: 'X-Foo',
                                'Proxy-Authorization': 'Basic c3RlYWw=',
                                'Proxy-Connection': 'close',
                                Host: 'attacker-controlled.example',
                            },
                        },
                        res => {
                            const chunks: Buffer[] = [];
                            res.on('data', c => chunks.push(c));
                            res.on('end', () =>
                                resolve({
                                    status: res.statusCode ?? 0,
                                    body: Buffer.concat(chunks).toString(),
                                    headers: res.headers,
                                }),
                            );
                        },
                    );
                    req.on('error', reject);
                    req.write(body);
                    req.end();
                });
                expect(reply.status).toBe(200);
                /* Upstream must not have seen the attacker's hop-by-hop values.
                 * The Connection header is special: node:http always sets one
                 * automatically (we tell it `connection: close`), so what we
                 * verify there is "the proxy's choice, not the attacker's". */
                expect(receivedHeaders.connection).toBe('close');
                expect(receivedHeaders.connection).not.toContain('Upgrade');
                for (const stripped of [
                    'keep-alive',
                    'upgrade',
                    'te',
                    'trailer',
                    'transfer-encoding',
                    'proxy-authorization',
                    'proxy-connection',
                ]) {
                    expect(receivedHeaders[stripped]).toBeUndefined();
                }
                /* Host header must be the upstream's, not the attacker's value. */
                expect(receivedHeaders.host).not.toBe(
                    'attacker-controlled.example',
                );
                /* And the upstream's hop-by-hop response headers must not reach
                 * the sandbox client (Connection: keep-alive from upstream gets
                 * stripped, our Connection: close wins). */
                expect(reply.headers.connection).toBe('close');
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test(
            'CIRCUMVENTION: slow-loris body upload is bounded by requestBodyTimeoutMs (~5s default)',
            async () => {
                /* Drip body bytes one at a time, each within the per-byte idle
                 * window. Without an absolute server.requestTimeout, this would
                 * stretch up to activeRequestTimeoutMs (default 30s) and let an
                 * attacker monopolize a slot. With server.requestTimeout =
                 * requestBodyTimeoutMs, the proxy must close us within ~5s. */
                const upstream = await startUpstream();
                const proxy = await spawnProxy({ upstreamUrl: upstream.url });
                try {
                    const sock = await rawConnect(proxy.socketPath);
                    sock.write(
                        'POST /tool-call HTTP/1.1\r\n' +
                            'Host: x\r\n' +
                            'Content-Type: application/json\r\n' +
                            'Content-Length: 100\r\n' +
                            'Connection: close\r\n' +
                            /* PTC headers required so the proxy forwards (presence-only check;
                             * lets us reach the bodyUploadDeadline path the test exercises). */
                            'X-Execution-ID: test-exec-id\r\n' +
                            'X-Tool-Call-ID: test-call-001\r\n' +
                            'X-Callback-Token: test-callback-token\r\n' +
                            '\r\n',
                    );
                    /* Drip 1 byte every 800ms. After 5s we've sent ~6 bytes — far short
                     * of the declared 100 — and the proxy must have closed us. */
                    const start = Date.now();
                    const dripInterval = setInterval(() => {
                        if (sock.destroyed) {
                            clearInterval(dripInterval);
                            return;
                        }
                        try {
                            sock.write('x');
                        } catch {
                            clearInterval(dripInterval);
                        }
                    }, 800);
                    const closedAt = await new Promise<number>(resolve => {
                        sock.once('close', () => resolve(Date.now() - start));
                        setTimeout(() => resolve(-1), 15000);
                    });
                    clearInterval(dripInterval);
                    expect(closedAt).toBeGreaterThanOrEqual(0);
                    /* Bounded close — proves slow-loris is mitigated. Generous upper
                     * bound to absorb scheduler jitter; the point is "<<30s". */
                    expect(closedAt).toBeLessThan(12000);
                    expect(upstream.calls()).toBe(0);
                } finally {
                    await proxy.stop();
                    await upstream.close();
                }
            },
            { timeout: 15_000 },
        );

        test('CIRCUMVENTION: HTTP/2 binary framing on a /tmp/tcs.sock connection fails clean (no crash)', async () => {
            /* If the proxy crashed on unexpected protocol bytes, an attacker
             * could brick it. Send raw HTTP/2 connection-preface bytes; the
             * node:http parser must close the socket with clientError without
             * affecting subsequent legitimate clients. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                /* HTTP/2 connection preface (24 bytes) per RFC 7540. */
                const h2Preface = Buffer.from(
                    'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n',
                );
                for (let i = 0; i < 5; i++) {
                    const sock = await rawConnect(proxy.socketPath);
                    sock.write(h2Preface);
                    await new Promise<void>(r => sock.once('close', () => r()));
                }
                /* Proxy must still serve a normal POST. */
                const res = await postToolCall(proxy.socketPath, '{"x":1}');
                expect(res.status).toBe(200);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('CIRCUMVENTION: oversize request body is rejected with 413 before reaching upstream', async () => {
            /* maxBodyBytes (default 1 MiB) bounds memory pressure. The
             * Content-Length precheck closes the loophole where streaming the
             * body to upstream would let the first chunks of an honestly-
             * declared oversize request leak through. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({
                upstreamUrl: upstream.url,
                env: {/* default maxBodyBytes */},
            });
            try {
                const big = 'A'.repeat(2 * 1024 * 1024); // 2 MiB body
                const reply = await new Promise<{
                    status: number;
                    body: string;
                }>(resolve => {
                    const req = http.request(
                        {
                            socketPath: proxy.socketPath,
                            method: 'POST',
                            path: '/tool-call',
                            headers: {
                                'Content-Length': Buffer.byteLength(big),
                                Connection: 'close',
                                /* PTC presence so the proxy actually attempts to forward,
                                 * letting the maxBodyBytes / Content-Length precheck fire. */
                                ...PTC_HEADERS,
                            },
                        },
                        res => {
                            const chunks: Buffer[] = [];
                            res.on('data', c => chunks.push(c));
                            res.on('end', () =>
                                resolve({
                                    status: res.statusCode ?? 0,
                                    body: Buffer.concat(chunks).toString(),
                                }),
                            );
                        },
                    );
                    req.on('error', err =>
                        resolve({ status: 0, body: err.message }),
                    );
                    req.write(big);
                    req.end();
                });
                /* Either 413 (CL precheck or runtime byte counter) or transport
                 * error (proxy closed mid-stream). The security property is the
                 * same: NO bytes of the oversize body reach the upstream. */
                expect([413, 0]).toContain(reply.status);
                expect(upstream.calls()).toBe(0);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('PTC presence filter: duplicate empty header lines do not bypass the gate', async () => {
            /* Codex caught this: Node joins duplicate request headers with
             * `, ` (per RFC 7230 §3.2.2). A naive `!headers[name]` check on
             * `X-Execution-ID:` sent twice with empty values produces the
             * truthy string `", "`, slips past the gate, and lets the
             * attacker reach the upstream — whose structured auth-error
             * response defeats the route-opacity goal. The proxy must
             * normalise (strip commas + whitespace) before checking. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                const sock = await rawConnect(proxy.socketPath);
                /* Each required PTC header sent TWICE with empty values. Without
                 * the fix, Node's join produces `, ` for each name and the
                 * proxy forwards. With the fix, the values normalise to '' and
                 * the proxy returns its canonical 404. */
                sock.write(
                    'POST /tool-call HTTP/1.1\r\n' +
                        'Host: x\r\n' +
                        'Content-Length: 0\r\n' +
                        'Connection: close\r\n' +
                        'X-Execution-ID:\r\n' +
                        'X-Execution-ID:\r\n' +
                        'X-Tool-Call-ID:\r\n' +
                        'X-Tool-Call-ID:\r\n' +
                        'X-Callback-Token:\r\n' +
                        'X-Callback-Token:\r\n' +
                        '\r\n',
                );
                const reply = await new Promise<string>(resolve => {
                    const chunks: Buffer[] = [];
                    sock.on('data', c => chunks.push(c));
                    sock.on('close', () =>
                        resolve(Buffer.concat(chunks).toString()),
                    );
                    setTimeout(
                        () => resolve(Buffer.concat(chunks).toString()),
                        3000,
                    );
                });
                /* Critical: upstream MUST NOT have been called. Status MUST be
                 * 404. Body MUST be the canonical "not found". */
                expect(reply).toContain('404');
                expect(reply).toContain('not found');
                expect(reply).not.toMatch(/X-Request-ID|ETag/i);
                expect(upstream.calls()).toBe(0);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('PTC presence filter: missing headers get canonical 404, never reach upstream', async () => {
            /* The proxy filters on PTC-header presence before forwarding so a
             * sandbox attacker probing /tool-call without SDK headers cannot
             * fingerprint the route via the upstream's structured "missing PTC
             * headers" response. The `bogus_headers` case proves cryptographic
             * validation is still upstream's job — bogus values DO forward and
             * upstream's structured error is preserved (so the SDK can parse it). */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                // No PTC headers → proxy 404, upstream NOT called
                const noHeaders = await new Promise<{
                    status: number;
                    body: string;
                    ct?: string;
                }>(resolve => {
                    const r = http.request(
                        {
                            socketPath: proxy.socketPath,
                            method: 'POST',
                            path: '/tool-call',
                        },
                        res => {
                            const chunks: Buffer[] = [];
                            res.on('data', c => chunks.push(c));
                            res.on('end', () =>
                                resolve({
                                    status: res.statusCode ?? 0,
                                    body: Buffer.concat(chunks).toString(),
                                    ct: res.headers['content-type'] as
                                        string | undefined,
                                }),
                            );
                        },
                    );
                    r.on('error', err =>
                        resolve({ status: 0, body: err.message }),
                    );
                    r.end();
                });
                expect(noHeaders.status).toBe(404);
                expect(noHeaders.body).toBe('not found');
                expect(noHeaders.ct).toContain('text/plain');
                const callsAfterNoHeaders = upstream.calls();
                expect(callsAfterNoHeaders).toBe(0);

                // With PTC headers (any values) → proxy forwards
                const withHeaders = await postToolCall(
                    proxy.socketPath,
                    '{"x":1}',
                );
                expect(withHeaders.status).toBe(200);
                expect(upstream.calls()).toBe(1);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('CIRCUMVENTION: pipelined requests on a single socket only target /tool-call and respect active-request budget', async () => {
            /* HTTP/1.1 pipelining lets a client batch requests on one socket.
             * Both pipelined requests still go through the proxy's path filter
             * and active-request budget — they cannot reach a different upstream
             * route. node:http may parse and dispatch the second request
             * before the first response's Connection: close fires; that is fine
             * as long as the second is ALSO subject to all the proxy's defenses. */
            let receivedPaths: string[] = [];
            const upstream = await startUpstream((req, res) => {
                receivedPaths.push(req.url ?? '');
                let n = 0;
                req.on('data', c => {
                    n += c.length;
                });
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, received: n }));
                });
            });
            const proxy = await spawnProxy({ upstreamUrl: upstream.url });
            try {
                const sock = await rawConnect(proxy.socketPath);
                /* Second request tries to hit /admin (a path the proxy's filter
                 * MUST reject). If pipelining could bypass the filter, we'd see
                 * /admin in receivedPaths. */
                /* PTC headers on the first request so it actually forwards; the
                 * second request deliberately omits them AND targets /admin to
                 * verify both the path filter AND the presence filter hold even
                 * across pipelined dispatch. */
                const pipelined =
                    'POST /tool-call HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n' +
                    'X-Execution-ID: t\r\nX-Tool-Call-ID: t\r\nX-Callback-Token: t\r\n\r\n{"x":1}' +
                    'POST /admin HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\n{"y":2}';
                sock.write(pipelined);
                await new Promise<void>(r => sock.once('close', () => r()));
                /* Whatever node:http chose to dispatch, the path filter must hold:
                 * upstream must NEVER see /admin. */
                expect(receivedPaths.every(p => p === '/tool-call')).toBe(true);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('ACTIVE-FLOOD DoS: excess concurrent /tool-call requests get 429 and do not reach upstream', async () => {
            /* Hold the upstream so requests pile up at the proxy's active cap.
             * With maxActiveRequests=2, only 2 requests should reach upstream;
             * the others should get 429 + Retry-After. */
            let pendingUpstreams = 0;
            let release: (() => void) | undefined;
            const releaseAll = new Promise<void>(r => {
                release = r;
            });
            const upstream = await startUpstream(async (req, res) => {
                pendingUpstreams++;
                req.resume();
                await new Promise<void>(r => req.on('end', () => r()));
                await releaseAll;
                res.writeHead(200).end('{"ok":true}');
            });

            const proxy = await spawnProxy({
                upstreamUrl: upstream.url,
                env: {
                    SANDBOX_MAX_CONCURRENT_JOBS: '2',
                },
            });

            try {
                const inflight = Array.from({ length: 32 }, () =>
                    postToolCall(proxy.socketPath, '{"x":1}').catch(err => ({
                        status: -1,
                        body: String(err),
                    })),
                );
                /* Give the proxy time to admit the first batch and 429 the rest. */
                await new Promise(r => setTimeout(r, 500));
                release!();
                const results = await Promise.all(inflight);
                const ok = results.filter(r => r.status === 200).length;
                const tooMany = results.filter(r => r.status === 429).length;
                /* Active cap default-derives from SANDBOX_MAX_CONCURRENT_JOBS but is
                 * floored at 16. Launch above the floor so this test actually exercises
                 * the 429 branch instead of merely proving that 16 requests succeed. */
                expect(ok).toBeGreaterThan(0);
                expect(ok).toBeLessThanOrEqual(16);
                expect(tooMany).toBeGreaterThan(0);
                expect(upstream.calls()).toBeLessThanOrEqual(16);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('CIRCUMVENTION: SIGTERM during proxy init exits cleanly (no TypeError on undefined handle)', async () => {
            /* Codex flagged that `shutdown()` could fall through to `handle.close()`
             * when a signal arrives before `startToolCallSocketProxy()` resolves —
             * which would crash with `TypeError: Cannot read properties of undefined`.
             * Hold the socket path with a sentinel server so the real proxy's
             * listen() blocks indefinitely (EADDRINUSE on a unix socket retries
             * via Node's listen-with-existing-socket dance, but with another
             * server actively listening the bind never resolves), then signal it.
             * The proxy must exit code 0 (signal handler ran cleanly) — never
             * exit on the SIGTERM signal directly (which would mean the handler
             * never ran) and never exit non-zero (which would mean the handler
             * ran but threw). */
            const socketPath = path.join(workdir, 'sigterm-init-race.sock');
            /* Pre-bind the socket path so the proxy's listen() hangs in EADDRINUSE
             * retry loops, keeping `handle` undefined long enough to test the race. */
            const blocker = http.createServer(() => {
                /* noop */
            });
            await new Promise<void>(r => blocker.listen(socketPath, () => r()));

            const proc = spawn('node', [PROXY_BUNDLE], {
                env: {
                    ...process.env,
                    TCS_SOCKET: socketPath,
                    SANDBOX_FORWARD_TARGET: 'http://127.0.0.1:1',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            /* Wait long enough for Node to install the SIGTERM handler but
             * NOT long enough for startToolCallSocketProxy to have resolved
             * (it can't — the socket is bound by `blocker`). 100ms is well
             * above the ~10ms handler-install window observed in probes. */
            await new Promise(r => setTimeout(r, 100));
            proc.kill('SIGTERM');

            const exit = await new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>(resolve => {
                const t = setTimeout(() => {
                    proc.kill('SIGKILL');
                    resolve({ code: -1, signal: null });
                }, 3000);
                proc.once('exit', (code, signal) => {
                    clearTimeout(t);
                    resolve({ code, signal });
                });
            });

            /* Critical assertion: handler ran AND exited cleanly. Exit code 0 is
             * the only acceptable outcome — anything else (signal:'SIGTERM' meaning
             * default behavior, code 1 meaning thrown error, code -1 meaning hung
             * past 3s) indicates the race window is broken. */
            expect(exit.code).toBe(0);
            expect(exit.signal).toBeNull();

            await new Promise<void>(r => blocker.close(() => r()));
        });

        test('CONNECT-FLOOD DoS: connection-rate limiter drops fast-burst accepts that would pressure kernel slab', async () => {
            /* This is the SPECIFIC audit scenario PR #1648 follow-up was opened
             * for: 500 AF_UNIX connect()s in <50 ms. Without the rate limiter,
             * every accept allocates kernel unix_sock + dentry + skb queue slab
             * entries; the proxy's existing maxConnections only bounds the
             * application-level activeSockets set, not the allocation rate.
             * Observation from the audit: in-VM kernel slab pressure surfaces
             * as EMFILE in subsequent loader open() calls even though the fd
             * table itself sits at 0.1% utilization.
             *
             * Test verifies the wire-level effect: with burst=8, refill=0 (frozen
             * for determinism), only the first 8 of 100 concurrent /tool-call
             * requests reach the upstream. The remaining 92 hit the rate limiter
             * and are destroyed before the HTTP request layer sees them — they
             * surface as either ECONNRESET / 'socket hang up' or EPIPE on the
             * client side. */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({
                upstreamUrl: upstream.url,
                env: {
                    /* burst=8 — much smaller than maxConnections so the RATE limit
                     * bites first. refill=1/sec is effectively frozen over the
                     * test's ~100ms window. */
                    TCS_CONNECTION_RATE_BURST: '8',
                    TCS_CONNECTION_RATE_REFILL_PER_SEC: '1',
                },
            });

            try {
                const results = await Promise.allSettled(
                    Array.from({ length: 100 }, () =>
                        postToolCall(proxy.socketPath, '{"x":1}'),
                    ),
                );

                const ok = results.filter(
                    r => r.status === 'fulfilled' && r.value.status === 200,
                ).length;
                const dropped = results.length - ok;

                /* Burst=8 with a near-frozen refill — somewhere in [8, 12] should
                 * succeed (burst + occasional refill during test window). The
                 * key assertion is that the count is bounded WELL below 100. */
                expect(ok).toBeGreaterThanOrEqual(1);
                expect(ok).toBeLessThanOrEqual(20);
                expect(dropped).toBeGreaterThanOrEqual(80);
                /* And critically: upstream sees only the rate-limit-allowed ones,
                 * NOT 100. This bounds kernel slab pressure: the proxy never
                 * creates the in-VM unix_sock entries for the dropped batch. */
                expect(upstream.calls()).toBeLessThanOrEqual(ok);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });

        test('CONNECT-FLOOD recovery: bucket refills so legitimate traffic resumes after a flood', async () => {
            /* Follow-up to the test above: confirm the limiter doesn't permanently
             * starve a connection. After draining the burst bucket, wait long
             * enough for the refill to top it back up, then verify a new
             * /tool-call succeeds. This guards against a bug where dropped
             * connections might leak the rate-limit credit (e.g. if the bucket
             * was decremented BEFORE the maxConnections check and never
             * compensated when both gates were hit by the same connection). */
            const upstream = await startUpstream();
            const proxy = await spawnProxy({
                upstreamUrl: upstream.url,
                env: {
                    TCS_CONNECTION_RATE_BURST: '4',
                    /* 20/sec refill — burst recovers in ~250ms. */
                    TCS_CONNECTION_RATE_REFILL_PER_SEC: '20',
                },
            });

            try {
                /* Drain the burst with a parallel flood. */
                const drain = await Promise.allSettled(
                    Array.from({ length: 30 }, () =>
                        postToolCall(proxy.socketPath, '{"x":1}'),
                    ),
                );
                const okDuringDrain = drain.filter(
                    r => r.status === 'fulfilled' && r.value.status === 200,
                ).length;
                expect(okDuringDrain).toBeGreaterThanOrEqual(1);
                expect(okDuringDrain).toBeLessThanOrEqual(15);

                /* Wait for the bucket to refill past 1 token (50ms refills 1 token
                 * at 20/sec; 500ms gives us plenty of margin). */
                await new Promise(r => setTimeout(r, 500));

                /* A single legitimate request after the wait must succeed. */
                const post = await postToolCall(proxy.socketPath, '{"x":2}');
                expect(post.status).toBe(200);
            } finally {
                await proxy.stop();
                await upstream.close();
            }
        });
    },
);
