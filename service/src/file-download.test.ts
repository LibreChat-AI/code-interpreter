import { expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:http';
import express from 'express';
import { sendFileDownload } from './file-download';

async function serverFor(stream: Readable) {
  const app = express();
  app.get('/', (req, res) => { void sendFileDownload(stream, res, req.header('x-codeapi-input-version')).catch(() => res.destroy()); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('serves metadata from the downloaded version and rejects a stale preflight', async () => {
  for (const expected of ['current', 'stale']) {
    const stream = Object.assign(Readable.from(['bytes']), { headers: {
      'x-amz-meta-codeapi-version': 'current', 'x-amz-meta-read-only': 'true',
      'x-amz-meta-original-filename': 'verified.txt',
    } });
    const server = await serverFor(stream);
    try {
      const response = await fetch(server.url, { headers: { 'X-CodeAPI-Input-Version': expected } });
      expect(response.status).toBe(expected === 'current' ? 200 : 409);
      if (expected === 'current') {
        expect(response.headers.get('x-read-only')).toBe('true');
        expect(response.headers.get('content-disposition')).toContain('verified.txt');
        expect(await response.text()).toBe('bytes');
      } else await response.text();
    } finally { await server.close(); }
  }
});

test('downstream cancellation stops the storage stream under backpressure', async () => {
  let produced = 0;
  const stream = new Readable({ read() { if (++produced <= 1000) this.push(Buffer.alloc(64 * 1024)); else this.push(null); } });
  const response = Object.assign(new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { setTimeout(callback, 10); },
  }), { setHeader() {} });
  const transfer = sendFileDownload(stream, response as unknown as express.Response);
  const timer = setTimeout(() => response.destroy(), 25);
  try {
    await expect(transfer).rejects.toThrow();
    expect(stream.destroyed).toBe(true);
    expect(produced).toBeLessThan(1000);
  } finally { clearTimeout(timer); }
});
