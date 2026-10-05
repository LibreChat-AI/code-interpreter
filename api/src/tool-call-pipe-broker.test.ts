import { afterEach, describe, expect, test } from 'bun:test';
import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { MAX_FRAME_BYTES, serveToolCallPipe } from './tool-call-pipe-broker';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

async function setup(handler: http.RequestListener, options = {}): Promise<{
  client: net.Socket; replies: () => Promise<any>; send: (value: unknown) => void;
}> {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(() => { upstream.closeAllConnections(); upstream.close(); });
  const server = net.createServer(channel => {
    cleanups.push(serveToolCallPipe(channel, `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`, options));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => server.close());
  const client = net.createConnection((server.address() as net.AddressInfo).port, '127.0.0.1');
  await once(client, 'connect');
  cleanups.push(() => client.destroy());
  let buffered = Buffer.alloc(0);
  const queued: any[] = [];
  const waiters: ((response: any) => void)[] = [];
  client.on('data', bytes => {
    buffered = Buffer.concat([buffered, typeof bytes === 'string' ? Buffer.from(bytes) : bytes]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE()) {
      const size = buffered.readUInt32BE();
      const value = JSON.parse(buffered.subarray(4, 4 + size).toString());
      buffered = buffered.subarray(4 + size);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else queued.push(value);
    }
  });
  return { client, replies: () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiters.push(resolve)),
    send: value => { const frame = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(frame.length); client.write(Buffer.concat([prefix, frame])); } };
}

const claims = { 'x-execution-id': 'exec', 'x-callback-token': 'token', 'x-tool-call-id': 'call' };
const frame = (id: number) => ({ id, headers: claims, body: '{"tool_name":"echo","input":{}}' });

describe('per-invocation tool-call pipe broker', () => {
  test('forwards only its fixed route and whitelisted claims, preserving JSON errors', async () => {
    let observed = false;
    const harness = await setup((req, res) => {
      observed = true;
      expect(req.url).toBe('/tool-call');
      expect(req.method).toBe('POST');
      expect(req.headers['x-callback-token']).toBe('token');
      expect(req.headers['x-forged']).toBeUndefined();
      req.resume();
      res.writeHead(404).end('{"success":false,"error":"Session not found"}');
    });
    harness.send({ ...frame(7), path: '/admin', headers: { ...claims, 'x-forged': 'secret' } });
    expect(await harness.replies()).toEqual({ id: 7, status: 404, body: '{"success":false,"error":"Session not found"}' });
    expect(observed).toBe(true);
  });

  test('isolates identical frame IDs across invocation channels', async () => {
    const first = await setup((_req, res) => res.end('first'));
    const second = await setup((_req, res) => res.end('second'));
    first.send(frame(1));
    second.send(frame(1));
    const replies = await Promise.all([first.replies(), second.replies()]);
    expect(replies.map(reply => reply.body)).toEqual(['first', 'second']);
  });

  test('rejects missing claims before opening an upstream connection', async () => {
    let count = 0;
    const harness = await setup((_req, res) => { count++; res.end(); });
    harness.send({ ...frame(1), headers: { ...claims, 'x-callback-token': ', , ' } });
    expect((await harness.replies()).status).toBe(400);
    expect(count).toBe(0);
  });

  test('returns redirects without following them', async () => {
    let count = 0;
    const harness = await setup((_req, res) => { count++; res.writeHead(302, { Location: '/credential-sink' }).end('redirect'); });
    harness.send(frame(1));
    expect((await harness.replies()).status).toBe(302);
    expect(count).toBe(1);
  });

  test('bounds outstanding upstream calls and aborts them when the channel closes', async () => {
    let upstreamClosed = false;
    let received: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const harness = await setup((req, _res) => {
      req.socket.once('close', () => { upstreamClosed = true; });
      req.resume(); received();
    }, { maxActiveRequests: 1 });
    harness.send(frame(1));
    await started;
    harness.send(frame(2));
    expect((await harness.replies()).status).toBe(429);
    harness.client.destroy();
    for (let n = 0; n < 100 && !upstreamClosed; n++) await Bun.sleep(5);
    expect(upstreamClosed).toBe(true);
  });

  test('enforces an absolute deadline on a stalled upstream', async () => {
    const harness = await setup(req => req.resume(), { requestTimeoutMs: 30 });
    harness.send(frame(1));
    expect((await harness.replies()).status).toBe(504);
  });

  test('rejects oversized upstream responses without buffering an unbounded body', async () => {
    const harness = await setup((_req, res) => res.end(Buffer.alloc(MAX_FRAME_BYTES + 1, 'x')));
    harness.send(frame(1));
    const response = await harness.replies();
    expect(response.status).toBe(502);
    expect(response.body).toContain('too large');
  });

  test('closes an oversized frame before any upstream request', async () => {
    let count = 0;
    const harness = await setup((_req, res) => { count++; res.end(); });
    const ended = once(harness.client, 'close');
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(MAX_FRAME_BYTES + 1);
    harness.client.write(prefix);
    await ended;
    expect(count).toBe(0);
  });

  test('bounds a partial-header slow writer', async () => {
    const harness = await setup((_req, res) => res.end(), { frameTimeoutMs: 30 });
    const ended = once(harness.client, 'close');
    harness.client.write(Buffer.from([0]));
    await ended;
  });
});
