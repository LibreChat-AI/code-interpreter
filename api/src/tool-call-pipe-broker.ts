import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';

export const MAX_FRAME_BYTES = 1024 * 1024;
const HEADER_NAMES = ['x-execution-id', 'x-callback-token', 'x-tool-call-id'] as const;

/** One broker/channel per authorized invocation. The target and route come
 * from trusted runner configuration; the job supplies only PTC claims/body.
 * The upstream still authenticates those claims and enforces tool budgets. */
export function serveToolCallPipe(channel: Duplex, rawTarget: string, options: {
  requestTimeoutMs?: number; frameTimeoutMs?: number; maxActiveRequests?: number;
  onFailure?: () => void;
} = {}): () => void {
  const target = new URL(rawTarget.includes('://') ? rawTarget : `http://${rawTarget}`);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('invalid tool-call broker target');
  }
  const transport = target.protocol === 'https:' ? https : http;
  const requests = new Map<number, http.ClientRequest>();
  const timeout = options.requestTimeoutMs ?? 300_000;
  const frameTimeout = options.frameTimeoutMs ?? 5_000;
  const maxActive = options.maxActiveRequests ?? 16;
  let closed = false;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let header = Buffer.alloc(4);
  let offset = 0;
  let frame: Buffer | undefined;
  let tokens = 64;
  let lastRefill = Date.now();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(frameTimer);
    clearTimeout(drainTimer);
    for (const request of requests.values()) request.destroy();
    requests.clear();
    channel.destroy();
  };
  const fail = (): void => { close(); options.onFailure?.(); };
  const reply = (id: number, status: number, body: string): void => {
    if (closed) return;
    let bytes = Buffer.from(JSON.stringify({ id, status, body }));
    if (bytes.length > MAX_FRAME_BYTES) {
      bytes = Buffer.from(JSON.stringify({ id, status: 502, body: JSON.stringify({ success: false, error: 'tool-call response too large' }) }));
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length);
    if (!channel.write(Buffer.concat([prefix, bytes]))) {
      channel.pause();
      drainTimer ??= setTimeout(fail, frameTimeout);
    }
  };
  const reject = (id: number, status: number, error: string): void => reply(id, status, JSON.stringify({ success: false, error }));
  const accept = (bytes: Buffer): void => {
    // Charge every complete frame before JSON/claim validation, including
    // rejected concurrency requests. Exhaustion closes the capability rather
    // than generating an unlimited stream of cheap 429/400 replies.
    const now = Date.now();
    tokens = Math.min(64, tokens + Math.max(0, now - lastRefill) * 0.02);
    lastRefill = now;
    if (tokens < 1) { fail(); return; }
    tokens -= 1;
    let parsed: { id?: unknown; headers?: unknown; body?: unknown };
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail(); return; }
    if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.id)
      || (parsed.id as number) < 1 || requests.has(parsed.id as number)) { fail(); return; }
    const id = parsed.id as number;
    if (!parsed.headers || typeof parsed.headers !== 'object' || Array.isArray(parsed.headers) || typeof parsed.body !== 'string') {
      reject(id, 400, 'invalid tool-call frame'); return;
    }
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', connection: 'close' };
    for (const name of HEADER_NAMES) {
      const value = (parsed.headers as Record<string, unknown>)[name];
      if (typeof value !== 'string' || !value.replace(/[,\s]/g, '') || value.length > 8192 || /[^\x20-\x7e]/.test(value)) {
        reject(id, 400, 'missing or invalid tool-call claims'); return;
      }
      headers[name] = value;
    }
    if (requests.size >= maxActive) { reject(id, 429, 'tool-call request budget exceeded'); return; }
    const body = Buffer.from(parsed.body);
    headers['content-length'] = body.length;
    let deadline: ReturnType<typeof setTimeout>;
    let finished = false;
    const finish = (status: number, response: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      requests.delete(id);
      reply(id, status, response);
    };
    const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname,
      port: target.port || undefined, method: 'POST', path: '/tool-call', headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_FRAME_BYTES) {
          finish(502, JSON.stringify({ success: false, error: 'tool-call response too large' }));
          upstream.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => finish(response.statusCode ?? 502, Buffer.concat(chunks).toString('utf8')));
      response.on('error', () => finish(502, JSON.stringify({ success: false, error: 'tool-call upstream disconnected' })));
      response.on('aborted', () => finish(502, JSON.stringify({ success: false, error: 'tool-call upstream disconnected' })));
    });
    requests.set(id, upstream);
    deadline = setTimeout(() => {
      finish(504, JSON.stringify({ success: false, error: 'tool-call upstream timeout' }));
      upstream.destroy();
    }, timeout);
    upstream.on('error', () => finish(502, JSON.stringify({ success: false, error: 'tool-call upstream unavailable' })));
    upstream.end(body);
  };
  channel.on('data', (chunk: Buffer) => {
    let cursor = 0;
    while (cursor < chunk.length && !closed) {
      frameTimer ??= setTimeout(fail, frameTimeout);
      const buffer = frame ?? header;
      const count = Math.min(buffer.length - offset, chunk.length - cursor);
      chunk.copy(buffer, offset, cursor, cursor + count);
      offset += count;
      cursor += count;
      if (offset !== buffer.length) continue;
      offset = 0;
      if (!frame) {
        const length = header.readUInt32BE();
        if (length < 1 || length > MAX_FRAME_BYTES) { fail(); break; }
        frame = Buffer.allocUnsafe(length);
      } else {
        const complete = frame;
        frame = undefined;
        clearTimeout(frameTimer);
        frameTimer = undefined;
        accept(complete);
      }
    }
  });
  channel.on('drain', () => { clearTimeout(drainTimer); drainTimer = undefined; channel.resume(); });
  channel.on('error', fail);
  channel.on('end', fail);
  channel.on('close', close);
  return close;
}

// Node starts only after restore, on an authenticated job's execution path.
// Never create a persistent listener or snapshot Node's TLS process state.
if (require.main === module) {
  const target = process.env.SANDBOX_FORWARD_TARGET?.trim();
  if (!target || !process.argv[2]) throw new Error('tool-call pipe broker is not configured');
  const child = spawn(process.env.TCS_PIPE_BRIDGE || '/usr/local/bin/tool-call-pipe-bridge', process.argv.slice(2), {
    stdio: [0, 1, 2, 'pipe'],
  });
  const channel = child.stdio[3] as Duplex;
  const stop = serveToolCallPipe(channel, target, {
    requestTimeoutMs: Math.min(600_000, Math.max(5_000, Number(process.env.TCS_REQUEST_TIMEOUT_MS) || 300_000)),
    onFailure: () => child.kill('SIGKILL'),
  });
  child.on('error', () => { stop(); process.exitCode = 125; });
  child.on('exit', (code, signal) => { stop(); process.exitCode = code ?? (signal === 'SIGKILL' ? 137 : 125); });
  process.once('SIGTERM', () => { stop(); child.kill('SIGKILL'); });
  process.once('SIGINT', () => { stop(); child.kill('SIGKILL'); });
}
