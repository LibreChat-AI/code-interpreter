import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';

export interface ToolCallSocketProxyOptions {
    socketPath: string;
    rawTarget: string;
    maxConnections?: number;
    maxActiveRequests?: number;
    idleSocketTimeoutMs?: number;
    headerTimeoutMs?: number;
    requestBodyTimeoutMs?: number;
    activeRequestTimeoutMs?: number;
    maxBodyBytes?: number;
    listenBacklog?: number;
    /** Token-bucket capacity for the connection-rate limiter. The bucket
     * starts full and refills at `connectionRateRefillPerSec`. Burst of
     * legitimate concurrent tool calls (up to maxActiveRequests=16 by
     * default) easily fits; a 500-connect()-in-50ms flood drains the
     * bucket and subsequent connections are dropped at the application
     * layer instead of allocating kernel unix_sock slab entries. */
    connectionRateBurst?: number;
    /** Sustained connection-acceptance rate in connections/second after the
     * burst bucket is drained. The SDK opens one connection per tool call;
     * even an aggressive agent rarely exceeds a few /sec. */
    connectionRateRefillPerSec?: number;
    socketUid?: number;
    socketGid?: number;
    socketMode?: number;
    log?: Pick<typeof console, 'error' | 'log' | 'warn'>;
}

export interface ToolCallSocketProxyHandle {
    server: http.Server;
    close: () => Promise<void>;
    activeConnections: () => number;
    activeRequests: () => number;
    activeUpstreams: () => number;
    /** For tests: current available tokens in the connection-rate bucket. */
    connectionRateTokens: () => number;
    /** For tests + observability: cumulative count of connections dropped
     * by the connection-rate limiter since proxy start. */
    connectionRateDropped: () => number;
}

const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_ACTIVE_REQUESTS = 16;
const DEFAULT_IDLE_SOCKET_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_LISTEN_BACKLOG = 16;
const MAX_DEFAULT_CONNECTIONS = 256;
const MAX_DEFAULT_ACTIVE_REQUESTS = 64;
const ACTIVE_REQUEST_TIMEOUT_GRACE_MS = 5_000;
const MAX_DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECTION_RATE_BURST = 64;
const DEFAULT_CONNECTION_RATE_REFILL_PER_SEC = 20;
const MAX_DEFAULT_CONNECTION_RATE_BURST = 256;
const MAX_DEFAULT_CONNECTION_RATE_REFILL_PER_SEC = 200;

/** Monotonic-ish token bucket. Tokens refill continuously at a configured
 * rate up to a burst cap. `tryConsume()` returns false instead of waiting
 * when empty — callers drop the connection synchronously, which is the
 * right behavior for a SOCK_STREAM accept handler (queuing in JS would
 * still hold the kernel socket struct alive, defeating the point). */
export interface TokenBucket {
    tryConsume(): boolean;
    tokens(): number;
}

export function createTokenBucket(opts: {
    burst: number;
    refillPerSec: number;
    now?: () => number;
}): TokenBucket {
    const now = opts.now ?? Date.now;
    const refillPerMs = opts.refillPerSec / 1000;
    let tokens = opts.burst;
    let last = now();

    function refill(): void {
        const t = now();
        const elapsed = t - last;
        if (elapsed <= 0) return;
        tokens = Math.min(opts.burst, tokens + elapsed * refillPerMs);
        last = t;
    }

    return {
        tryConsume(): boolean {
            refill();
            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            return false;
        },
        tokens(): number {
            refill();
            return tokens;
        },
    };
}

function normalizeTarget(rawTarget: string): URL {
    if (!rawTarget) {
        throw new Error('SANDBOX_FORWARD_TARGET is required');
    }
    return new URL(
        rawTarget.includes('://') ? rawTarget : `http://${rawTarget}`,
    );
}

function destroySocket(socket: net.Socket): void {
    socket.destroy();
}

/* RFC 7230 §6.1 hop-by-hop headers. A proxy MUST NOT forward these to the
 * upstream — they describe the proxy<->client connection, not the request.
 * `host` is rewritten separately to point at the upstream. Forwarding the
 * client's `host` would let a malicious sandbox steer the upstream's
 * routing if it ever virtual-hosts. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
]);

function buildForwardedHeaders(
    reqHeaders: http.IncomingHttpHeaders,
    upstreamHost: string,
): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(reqHeaders)) {
        if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
        if (v == null) continue;
        out[k] = v;
    }
    /* Set our own connection-management headers; the proxy never keep-alives
     * to upstream because each request is one-shot. */
    out.host = upstreamHost;
    out.connection = 'close';
    return out;
}

/* True only when the header has at least one non-empty, non-whitespace
 * character. Naive `!headers[name]` is bypassable: Node joins duplicate
 * request headers with `, ` (per RFC 7230 §3.2.2), so two empty
 * `X-Foo:` lines arrive as the truthy string `", "`. An attacker who
 * sends each PTC header twice with empty values would slip past the
 * presence filter and reach the upstream — defeating the route-opacity
 * goal. Stripping commas + whitespace before the empty check closes
 * that gap. */
function hasPtcHeaderValue(value: string | string[] | undefined): boolean {
    if (value == null) return false;
    const joined = Array.isArray(value) ? value.join(',') : value;
    /* Strip every comma (Node's separator for joined duplicates) and every
     * whitespace character. If anything is left, the header carries real
     * content. */
    return joined.replace(/[,\s]/g, '') !== '';
}

/* Request smuggling defense (CVE class). When a request carries BOTH
 * Transfer-Encoding and Content-Length, an upstream may pick the
 * different one than the proxy did, letting an attacker prepend bytes
 * to a synthesized "second request" that bypasses the proxy's path
 * filter. The fix per RFC 7230 §3.3.3 is to reject the request rather
 * than try to reconcile. */
function isSmugglingShaped(headers: http.IncomingHttpHeaders): boolean {
    const hasCL = headers['content-length'] != null;
    const hasTE = headers['transfer-encoding'] != null;
    return hasCL && hasTE;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return undefined;
    return Math.floor(n);
}

function defaultMaxConnections(): number {
    const maxConcurrentJobs = parsePositiveInt(
        process.env.SANDBOX_MAX_CONCURRENT_JOBS,
    );
    if (maxConcurrentJobs == null) return DEFAULT_MAX_CONNECTIONS;
    return Math.min(
        Math.max(maxConcurrentJobs * 4, DEFAULT_MAX_CONNECTIONS),
        MAX_DEFAULT_CONNECTIONS,
    );
}

function defaultMaxActiveRequests(): number {
    const maxConcurrentJobs = parsePositiveInt(
        process.env.SANDBOX_MAX_CONCURRENT_JOBS,
    );
    if (maxConcurrentJobs == null) return DEFAULT_MAX_ACTIVE_REQUESTS;
    return Math.min(
        Math.max(maxConcurrentJobs, DEFAULT_MAX_ACTIVE_REQUESTS),
        MAX_DEFAULT_ACTIVE_REQUESTS,
    );
}

function defaultActiveRequestTimeoutMs(): number {
    const runTimeoutMs = parsePositiveInt(process.env.SANDBOX_RUN_TIMEOUT);
    if (runTimeoutMs == null) return DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS;
    return Math.min(
        Math.max(
            runTimeoutMs + ACTIVE_REQUEST_TIMEOUT_GRACE_MS,
            DEFAULT_REQUEST_BODY_TIMEOUT_MS,
        ),
        MAX_DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS,
    );
}

/* Rate-limit defaults scale with SANDBOX_MAX_CONCURRENT_JOBS in the same
 * shape as defaultMaxConnections / defaultMaxActiveRequests above. A
 * deployment with maxConcurrentJobs=64 is sized to run ~64 tool calls
 * in parallel; capping the connection-acceptance rate at the fixed 20/sec
 * baseline would throttle legitimate sustained traffic from that
 * workload — connections that would have been 429'd by maxActiveRequests
 * instead get destroyed at the rate limiter, which is the wrong shape
 * (clients see ECONNRESET instead of a structured Retry-After response). */
export function defaultConnectionRateBurst(): number {
    const maxConcurrentJobs = parsePositiveInt(
        process.env.SANDBOX_MAX_CONCURRENT_JOBS,
    );
    if (maxConcurrentJobs == null) return DEFAULT_CONNECTION_RATE_BURST;
    return Math.min(
        Math.max(maxConcurrentJobs * 4, DEFAULT_CONNECTION_RATE_BURST),
        MAX_DEFAULT_CONNECTION_RATE_BURST,
    );
}

export function defaultConnectionRateRefillPerSec(): number {
    const maxConcurrentJobs = parsePositiveInt(
        process.env.SANDBOX_MAX_CONCURRENT_JOBS,
    );
    if (maxConcurrentJobs == null)
        return DEFAULT_CONNECTION_RATE_REFILL_PER_SEC;
    /* 2x maxConcurrentJobs gives headroom over the steady-state rate
     * (~1 connection per active job per second for typical tool-call
     * workloads). Floor at 20/sec so small deployments don't get a
     * tighter limit than the fixed baseline. */
    return Math.min(
        Math.max(maxConcurrentJobs * 2, DEFAULT_CONNECTION_RATE_REFILL_PER_SEC),
        MAX_DEFAULT_CONNECTION_RATE_REFILL_PER_SEC,
    );
}

export async function startToolCallSocketProxy(
    opts: ToolCallSocketProxyOptions,
): Promise<ToolCallSocketProxyHandle> {
    const log = opts.log ?? console;
    const socketPath = opts.socketPath;
    const target = normalizeTarget(opts.rawTarget);
    const transport = target.protocol === 'https:' ? https : http;
    const maxConnections = opts.maxConnections ?? defaultMaxConnections();
    const maxActiveRequests =
        opts.maxActiveRequests ?? defaultMaxActiveRequests();
    const idleSocketTimeoutMs =
        opts.idleSocketTimeoutMs ?? DEFAULT_IDLE_SOCKET_TIMEOUT_MS;
    const headerTimeoutMs = opts.headerTimeoutMs ?? idleSocketTimeoutMs;
    const requestBodyTimeoutMs =
        opts.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS;
    const activeRequestTimeoutMs =
        opts.activeRequestTimeoutMs ?? defaultActiveRequestTimeoutMs();
    const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const listenBacklog = opts.listenBacklog ?? DEFAULT_LISTEN_BACKLOG;
    const connectionRateBurst =
        opts.connectionRateBurst ?? defaultConnectionRateBurst();
    const connectionRateRefillPerSec =
        opts.connectionRateRefillPerSec ?? defaultConnectionRateRefillPerSec();
    // The socket is intentionally connectable by sandbox jobs even when
    // SANDBOX_PER_JOB_UIDS maps each job to a distinct outside UID. Abuse is
    // bounded by the proxy's connection caps/timeouts, not by inode ownership.
    const socketMode = opts.socketMode ?? 0o666;

    const activeSockets = new Set<net.Socket>();
    /* Absolute accept-to-headers deadlines cover slow-header clients. Node's
     * headersTimeout and socket idle timers are not a short per-socket deadline
     * for AF_UNIX header drip attacks, so track the accepted socket ourselves
     * until node:http has parsed enough bytes to dispatch a request. */
    const headerReceiveDeadlines = new WeakMap<
        net.Socket,
        ReturnType<typeof setTimeout>
    >();
    let activeRequests = 0;
    let activeUpstreams = 0;

    const clearHeaderReceiveDeadline = (socket: net.Socket): void => {
        const deadline = headerReceiveDeadlines.get(socket);
        if (deadline) clearTimeout(deadline);
        headerReceiveDeadlines.delete(socket);
    };

    /* Connection-rate limiter — counters the audit pattern of 500 AF_UNIX
     * connect()s in <50 ms. Without this, even though the proxy itself
     * stays bounded (maxConnections destroys excess accepts), each accept
     * still allocates a unix_sock + dentry + skb queue in the in-VM
     * kernel slab. On a memory-tight microVM, 500+ allocations in a
     * single tick pressures the slab allocator hard enough that
     * subsequent legitimate openat() / mmap() calls (e.g. ld.so loading
     * shared libraries) sporadically fail with EMFILE — even though the
     * fd table itself is at <1% utilization. Capping the *rate* of
     * accepts at the application layer bounds how fast new slab entries
     * can be created, giving the kernel time to reclaim. */
    const connectionRateLimiter = createTokenBucket({
        burst: connectionRateBurst,
        refillPerSec: connectionRateRefillPerSec,
    });
    let connectionRateDroppedCount = 0;

    const server = http.createServer((req, res) => {
        const socket = req.socket;
        clearHeaderReceiveDeadline(socket);
        socket.setTimeout(requestBodyTimeoutMs, () => destroySocket(socket));
        req.setTimeout(requestBodyTimeoutMs, () => destroySocket(socket));
        res.setHeader('Connection', 'close');

        res.on('finish', () => {
            socket.end();
        });

        if (req.method !== 'POST' || req.url !== '/tool-call') {
            req.resume();
            res.writeHead(404, {
                'Content-Type': 'text/plain',
                Connection: 'close',
            });
            res.end('not found');
            return;
        }

        /* PTC-header presence filter at the proxy boundary. Three reasons:
         *
         * (1) Route opacity. If a sandbox attacker probes /tool-call without
         *     the SDK-supplied PTC headers, the upstream's 404 leaks Express's
         *     framing (ETag/X-Request-ID/charset/content-length) which is
         *     visibly different from the proxy's own 404 for unknown paths.
         *     Filtering at the proxy means missing-header probes never reach
         *     the upstream and the response is byte-identical to /any/unknown.
         *
         * (2) Cheap rejection. Don't burn an active-request slot or open an
         *     upstream connection for a request that's going to be rejected.
         *
         * (3) Preserves legitimate 404s. The previous shape blanket-masked
         *     ALL upstream 404 responses, which broke "Session not found" and
         *     other structured upstream errors that the SDK's preamble parses
         *     as JSON (json.loads("not found") raises). With the filter
         *     here, only missing-header probes are masked; a genuine 404 with
         *     a JSON body for an authenticated request still reaches the
         *     SDK intact.
         *
         * The proxy only checks PRESENCE — actual cryptographic validation
         * happens at the upstream. An attacker supplying garbage values for
         * these headers gets forwarded and the upstream rejects with its
         * structured response, but they've already revealed sandbox-side
         * activity by sending non-empty headers, so route opacity isn't the
         * goal there. */
        if (
            !hasPtcHeaderValue(req.headers['x-execution-id']) ||
            !hasPtcHeaderValue(req.headers['x-tool-call-id']) ||
            !hasPtcHeaderValue(req.headers['x-callback-token'])
        ) {
            req.resume();
            res.writeHead(404, {
                'Content-Type': 'text/plain',
                Connection: 'close',
            });
            res.end('not found');
            return;
        }

        /* Smuggling defense — block before we do anything else with the
         * request so neither our active-request budget nor any upstream
         * connection is consumed. */
        if (isSmugglingShaped(req.headers)) {
            req.resume();
            res.writeHead(400, {
                'Content-Type': 'text/plain',
                Connection: 'close',
            });
            res.end('ambiguous Content-Length and Transfer-Encoding');
            return;
        }

        /* Content-Length precheck — if the client honestly declares a body
         * larger than maxBodyBytes, reject BEFORE opening an upstream and
         * BEFORE leaking any of those bytes through req.pipe(upstream). The
         * runtime byte counter below is the second line of defense for
         * chunked uploads and dishonest CL values, but this gate handles
         * the common case cleanly. */
        const declaredCL = Number(req.headers['content-length'] ?? '0');
        if (Number.isFinite(declaredCL) && declaredCL > maxBodyBytes) {
            req.resume();
            res.writeHead(413, {
                'Content-Type': 'text/plain',
                Connection: 'close',
            });
            res.end('request body too large');
            return;
        }

        if (activeRequests >= maxActiveRequests) {
            req.resume();
            res.writeHead(429, {
                'Content-Type': 'application/json',
                Connection: 'close',
                'Retry-After': '1',
            });
            res.end(
                JSON.stringify({
                    success: false,
                    error: 'Too many concurrent tool-call requests',
                }),
            );
            return;
        }

        activeRequests += 1;
        let releasedActiveRequest = false;
        const releaseActiveRequest = (): void => {
            if (releasedActiveRequest) return;
            releasedActiveRequest = true;
            activeRequests = Math.max(0, activeRequests - 1);
        };
        res.on('finish', releaseActiveRequest);
        res.on('close', releaseActiveRequest);

        let bodyBytes = 0;
        let rejected = false;
        let upstreamClosed = false;

        /* Absolute body-upload deadline. socket.setTimeout / req.setTimeout
         * are idle timers and reset on every byte, so a malicious client
         * dripping bytes just under the idle threshold (slow-loris) bypasses
         * them. Node's `server.requestTimeout` was meant to bound this but
         * empirically does NOT fire mid-body for unix-socket clients in
         * Node 22 (probed; drip kept flowing past 3x the configured value).
         * This explicit setTimeout fires unconditionally `requestBodyTimeoutMs`
         * after the request handler runs and is cleared once the body is
         * fully received. */
        const bodyUploadDeadline = setTimeout(() => {
            if (req.complete || rejected) return;
            destroySocket(socket);
        }, requestBodyTimeoutMs);
        const clearBodyUploadDeadline = (): void =>
            clearTimeout(bodyUploadDeadline);
        req.on('end', clearBodyUploadDeadline);
        req.on('aborted', clearBodyUploadDeadline);
        res.on('finish', clearBodyUploadDeadline);
        res.on('close', clearBodyUploadDeadline);

        req.on('end', () => {
            socket.setTimeout(activeRequestTimeoutMs, () =>
                destroySocket(socket),
            );
        });

        /* BUFFER then forward — do NOT open upstream or pipe bytes until the
         * full body is received. Streaming would let a slow-loris that drips
         * body bytes pin an UPSTREAM connection slot for the entire body-
         * upload window, even though the proxy itself bounds its own socket
         * lifetime. Tool-call payloads are small JSON (capped at maxBodyBytes,
         * default 1 MiB), so buffering is cheap and the security property
         * "upstream never sees a partial request" is much stronger. */
        const bodyChunks: Buffer[] = [];
        let upstream: http.ClientRequest | undefined;
        const abortUpstream = (): void => {
            if (!upstream || upstreamClosed || res.writableEnded) return;
            upstream.destroy(new Error('tool-call client disconnected'));
        };
        req.on('aborted', abortUpstream);
        res.on('close', abortUpstream);
        socket.on('close', abortUpstream);

        req.on('data', chunk => {
            if (rejected) return;
            bodyBytes += chunk.length;
            if (bodyBytes > maxBodyBytes) {
                rejected = true;
                res.writeHead(413, {
                    'Content-Type': 'text/plain',
                    Connection: 'close',
                });
                res.end('request body too large');
                destroySocket(socket);
                return;
            }
            bodyChunks.push(Buffer.from(chunk));
        });

        req.on('end', () => {
            if (rejected) return;
            const body =
                bodyChunks.length === 1
                    ? bodyChunks[0]
                    : Buffer.concat(bodyChunks);

            /* Strip ALL hop-by-hop headers before forwarding (RFC 7230 §6.1).
             * Previously we only stripped `proxy-connection`, which left
             * Upgrade, TE, Trailer, and friends as a vector for protocol
             * confusion at the upstream. */
            const headers = buildForwardedHeaders(req.headers, target.host);
            /* Override declared content-length with the actual buffered size
             * — if the client lied, what we send is what we have. */
            headers['content-length'] = body.length;

            upstream = transport.request(
                {
                    protocol: target.protocol,
                    hostname: target.hostname,
                    port: target.port || undefined,
                    method: 'POST',
                    path: '/tool-call',
                    headers,
                },
                upstreamRes => {
                    if (rejected) {
                        upstreamRes.resume();
                        return;
                    }
                    /* Strip hop-by-hop on the response path. Upstream's Connection /
                     * Keep-Alive / Upgrade headers describe the proxy <-> upstream
                     * link, not what we should tell the sandbox client. */
                    const respHeaders: http.OutgoingHttpHeaders = {};
                    for (const [k, v] of Object.entries(upstreamRes.headers)) {
                        if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
                        if (v == null) continue;
                        respHeaders[k] = v;
                    }
                    respHeaders.Connection = 'close';
                    res.writeHead(upstreamRes.statusCode || 502, respHeaders);
                    upstreamRes.pipe(res);
                },
            );
            activeUpstreams += 1;

            upstream.on('close', () => {
                upstreamClosed = true;
                activeUpstreams = Math.max(0, activeUpstreams - 1);
                releaseActiveRequest();
            });

            upstream.setTimeout(activeRequestTimeoutMs, () => {
                upstream?.destroy(new Error('tool-call upstream timeout'));
            });

            upstream.on('error', error => {
                if (rejected) return;
                log.error('tool-call socket proxy upstream error', error);
                if (!res.headersSent) {
                    res.writeHead(502, {
                        'Content-Type': 'text/plain',
                        Connection: 'close',
                    });
                }
                res.end('bad gateway');
            });

            upstream.end(body);
        });
    });

    server.maxConnections = maxConnections;
    server.headersTimeout = headerTimeoutMs;
    server.keepAliveTimeout = 1;
    /* Bound the entire request reception (first byte -> last body byte) to
     * the body-upload window. Prevents slow-loris drip attacks: socket-idle
     * timers reset on every byte, so a malicious client could otherwise
     * stretch body upload to activeRequestTimeoutMs (default 30s) by
     * sending one byte just under the idle threshold. */
    server.requestTimeout = requestBodyTimeoutMs;
    server.timeout = activeRequestTimeoutMs;

    server.on('connection', socket => {
        /* Rate-limit BEFORE the concurrency check. The concurrency check
         * (`activeSockets.size`) tells us how many connections are alive
         * RIGHT NOW; the rate limiter tells us how fast new ones are being
         * created. The audit's flood passes the concurrency check trivially
         * (most connections accepted, processed, and destroyed faster than
         * the count grows) but creates thousands of socket structs in the
         * process. Rate-limiting at connect-time is what bounds the kernel
         * slab pressure that surfaces as EMFILE in subsequent loader open()
         * calls — see createTokenBucket comment for the full mechanism. */
        if (!connectionRateLimiter.tryConsume()) {
            connectionRateDroppedCount += 1;
            destroySocket(socket);
            return;
        }
        if (activeSockets.size >= maxConnections) {
            log.warn(
                'tool-call socket proxy connection limit reached; dropping connection',
            );
            destroySocket(socket);
            return;
        }

        activeSockets.add(socket);
        const headerReceiveDeadline = setTimeout(() => {
            headerReceiveDeadlines.delete(socket);
            destroySocket(socket);
        }, headerTimeoutMs);
        headerReceiveDeadlines.set(socket, headerReceiveDeadline);

        socket.setTimeout(idleSocketTimeoutMs, () => destroySocket(socket));
        socket.on('close', () => {
            clearHeaderReceiveDeadline(socket);
            activeSockets.delete(socket);
        });
        socket.on('error', () => {
            clearHeaderReceiveDeadline(socket);
            activeSockets.delete(socket);
        });
    });

    server.on('clientError', (_error, socket) => {
        destroySocket(socket as net.Socket);
    });

    try {
        fs.unlinkSync(socketPath);
    } catch {
        // Missing stale socket is fine.
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            if (opts.socketUid != null && opts.socketGid != null) {
                fs.chownSync(socketPath, opts.socketUid, opts.socketGid);
            }
            fs.chmodSync(socketPath, socketMode);
            log.log(`tool-call socket proxy listening on ${socketPath}`);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath, listenBacklog);
    });

    return {
        server,
        close: async () => {
            for (const socket of activeSockets) {
                destroySocket(socket);
            }
            await new Promise<void>(resolve => {
                server.close(() => {
                    try {
                        fs.unlinkSync(socketPath);
                    } catch {
                        // Socket was already removed.
                    }
                    resolve();
                });
            });
        },
        activeConnections: () => activeSockets.size,
        activeRequests: () => activeRequests,
        activeUpstreams: () => activeUpstreams,
        connectionRateTokens: () => connectionRateLimiter.tokens(),
        connectionRateDropped: () => connectionRateDroppedCount,
    };
}

if (require.main === module) {
    const socketPath = process.env.TCS_SOCKET || '/tmp/tcs.sock';
    const rawTarget = process.env.SANDBOX_FORWARD_TARGET || '';
    const socketUid = process.env.TCS_SOCKET_UID
        ? Number(process.env.TCS_SOCKET_UID)
        : undefined;
    const socketGid = process.env.TCS_SOCKET_GID
        ? Number(process.env.TCS_SOCKET_GID)
        : undefined;
    const maxConnections = parsePositiveInt(process.env.TCS_MAX_CONNECTIONS);
    const headerTimeoutMs = parsePositiveInt(process.env.TCS_HEADER_TIMEOUT_MS);
    /* Operator overrides for the connection-rate limiter — see
     * createTokenBucket comment for the kernel-slab-pressure motivation.
     * Defaults (burst=64, refill=20/sec) are sized for the SDK's tool-call
     * pattern (one connection per call) plus generous headroom; raise only
     * if a legitimate workload trips the dropped-connection counter. */
    const rateBurst = parsePositiveInt(process.env.TCS_CONNECTION_RATE_BURST);
    const rateRefillPerSec = parsePositiveInt(
        process.env.TCS_CONNECTION_RATE_REFILL_PER_SEC,
    );
    let handle: ToolCallSocketProxyHandle | undefined;
    let shuttingDown = false;

    const shutdown = (): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (!handle) {
            /* Signal arrived before startToolCallSocketProxy() resolved.
             * `process.exit` is terminal in Node, but the explicit `return` makes
             * the contract local: no `handle.close()` on `undefined` even if a
             * future runtime ever defers exit (atexit hook, async-cleanup mode). */
            process.exit(0);
            return;
        }
        void handle.close().finally(() => process.exit(0));
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    startToolCallSocketProxy({
        socketPath,
        rawTarget,
        socketUid,
        socketGid,
        maxConnections,
        headerTimeoutMs,
        connectionRateBurst: rateBurst,
        connectionRateRefillPerSec: rateRefillPerSec,
    })
        .then(started => {
            handle = started;
        })
        .catch(error => {
            console.error('tool-call socket proxy failed to start', error);
            process.exit(1);
        });
}
