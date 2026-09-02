import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { startFileRelay } from './relay.js';

import type { AddressInfo } from 'node:net';

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test('file relay streams an authorized object download from its fixed upstream', async () => {
  const upstream = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/sessions/storage-1/objects/file-1');
    assert.equal(req.headers['x-codeapi-egress-grant'], 'grant-1');
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': "attachment; filename*=UTF-8''canonical.txt",
      'X-Read-Only': 'true',
    });
    res.end('input-data');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/storage-1/objects/file-1`,
      {
        headers: {
          'X-LibreChat-Code-Relay-Token': 'relay-secret',
          'X-CodeAPI-Egress-Grant': 'grant-1',
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-read-only'), 'true');
    assert.equal(
      response.headers.get('content-disposition'),
      "attachment; filename*=UTF-8''canonical.txt",
    );
    assert.equal(await response.text(), 'input-data');
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay forwards an authorized generated-file upload', async () => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/sessions/output-1/objects/generated-1');
    assert.equal(req.headers['x-codeapi-egress-grant'], 'grant-2');
    assert.equal(req.headers['x-original-filename'], 'report.txt');
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'generated-data');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"stored":true}');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/output-1/objects/generated-1`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'X-LibreChat-Code-Relay-Token': 'relay-secret',
          'X-CodeAPI-Egress-Grant': 'grant-2',
          'X-Original-Filename': 'report.txt',
        },
        body: 'generated-data',
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"stored":true}');
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay permits only the normalized session object listing', async () => {
  const upstream = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/sessions/storage-1/objects?detail=normalized');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/storage-1/objects?detail=normalized`,
      {
        headers: {
          'X-LibreChat-Code-Relay-Token': 'relay-secret',
          'X-CodeAPI-Egress-Grant': 'grant-1',
        },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay health is available only with its private relay token', async () => {
  const upstream = createServer((_req, res) => res.writeHead(500).end());
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const unauthorized = await fetch(`${relay.url}/health`);
    assert.equal(unauthorized.status, 401);
    const healthy = await fetch(`${relay.url}/health`, {
      headers: { 'X-LibreChat-Code-Relay-Token': 'relay-secret' },
    });
    assert.equal(healthy.status, 200);
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay rejects object traffic without an execution grant before contacting upstream', async () => {
  let upstreamRequests = 0;
  const upstream = createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200).end('should-not-run');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/storage-1/objects/file-1`,
      { headers: { 'X-LibreChat-Code-Relay-Token': 'relay-secret' } },
    );
    assert.equal(response.status, 403);
    assert.equal(upstreamRequests, 0);
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay never follows upstream redirects', async () => {
  let upstreamRequests = 0;
  const upstream = createServer((req, res) => {
    upstreamRequests += 1;
    if (req.url === '/admin') {
      res.writeHead(200).end('sensitive');
      return;
    }
    res.writeHead(302, { Location: '/admin' }).end();
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/storage-1/objects/file-1`,
      {
        redirect: 'manual',
        headers: {
          'X-LibreChat-Code-Relay-Token': 'relay-secret',
          'X-CodeAPI-Egress-Grant': 'grant-1',
        },
      },
    );
    assert.equal(response.status, 302);
    assert.equal(upstreamRequests, 1);
    assert.equal(response.headers.get('location'), null);
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay bounds concurrent upstream transfers', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let seen = 0;
  const upstream = createServer(async (_req, res) => {
    seen += 1;
    if (seen === 1) await firstStarted;
    res.writeHead(200).end('ok');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
    maxConcurrentRequests: 1,
  });
  const headers = {
    'X-LibreChat-Code-Relay-Token': 'relay-secret',
    'X-CodeAPI-Egress-Grant': 'grant-1',
  };

  try {
    const first = fetch(`${relay.url}/sessions/storage-1/objects/file-1`, {
      headers,
    });
    while (seen === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await fetch(
      `${relay.url}/sessions/storage-1/objects/file-2`,
      { headers },
    );
    assert.equal(second.status, 503);
    releaseFirst?.();
    assert.equal((await first).status, 200);
    assert.equal(seen, 1);
  } finally {
    releaseFirst?.();
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('file relay rejects an oversized chunked upstream response', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(Buffer.alloc(768));
    res.end(Buffer.alloc(768));
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startFileRelay({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl,
    token: 'relay-secret',
    maxBytes: 1024,
    timeoutMs: 1_000,
  });

  try {
    const response = await fetch(
      `${relay.url}/sessions/storage-1/objects/file-1`,
      {
        headers: {
          'X-LibreChat-Code-Relay-Token': 'relay-secret',
          'X-CodeAPI-Egress-Grant': 'grant-1',
        },
      },
    );
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
