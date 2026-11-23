import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';

import type * as t from './types';
import type { CodeApiPrincipal } from './auth/principal';

import { applyPrincipal } from './auth/principal';
import { storageKeyForUpload } from './file-object-resolver';
import { INTERNAL_SERVICE_TOKEN_ENV, INTERNAL_SERVICE_TOKEN_HEADER } from './internal-service-auth';
import { resolveSessionKey } from './session-key';
import { recordSessionOwnership } from './session-ownership';
import { probeFileServerStore, STORE_PROBE_PATH } from './store-pairing';
import { startTestRedis } from './test/redis';
import { UPLOAD_SESSION_UNKNOWN } from './upload-record';
import { authorizeWorkspaceImportSource } from './workspace-tools/import';

/**
 * Runs the real file server against a real Redis. Only the object store is
 * stood in for: S3 is the one dependency that cannot be started here, and
 * the stub answers just the calls a zero-byte upload makes.
 */

type TestRedis = Awaited<ReturnType<typeof startTestRedis>>;

const TOKEN = 'file-server-test-internal-token';
const SESSION = 'sessAAAAAAAAAAAAAAAAA';
const OBJECT = 'fileAAAAAAAAAAAAAAAAA';
const owner: CodeApiPrincipal = { userId: 'user-1', tenantId: 'tenant-1', principalSource: 'librechat_jwt' };
/** Uploads only where the file server must refuse, so its session key is never legitimately logged. */
const refused: CodeApiPrincipal = { userId: 'user-2', tenantId: 'tenant-1', principalSource: 'librechat_jwt' };
const EMPTY_LISTING = '<?xml version="1.0" encoding="UTF-8"?>' +
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name>' +
  '<Prefix></Prefix><Marker></Marker><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>';

const originalToken = process.env[INTERNAL_SERVICE_TOKEN_ENV];
const storedObjects: string[] = [];
let fileServerRedis: TestRedis;
let otherRedis: TestRedis;
let objectStore: ReturnType<typeof Bun.serve>;
let fileServer: ChildProcess;
let fileServerUrl: string;
let fileServerLog = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function requestFrom(principal: CodeApiPrincipal): t.AuthenticatedRequest {
  const req = { headers: {} } as t.AuthenticatedRequest;
  applyPrincipal(req, principal);
  return req;
}

const sessionKeyOf = (principal: CodeApiPrincipal): string =>
  resolveSessionKey(requestFrom(principal), { kind: 'user', id: principal.userId });

/** The file server's output reaches this process after its HTTP response can. */
async function fileServerLogged(text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fileServerLog.includes(text)) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

function putObject(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${fileServerUrl}/sessions/${SESSION}/objects/${OBJECT}`, {
    method: 'PUT',
    headers: {
      [INTERNAL_SERVICE_TOKEN_HEADER]: TOKEN,
      'Content-Type': 'text/plain',
      'X-Original-Filename': encodeURIComponent('notes.txt'),
      ...headers,
    },
    body,
  });
}

beforeAll(async () => {
  process.env[INTERNAL_SERVICE_TOKEN_ENV] = TOKEN;
  const [redisPort, fileServerPort] = await Promise.all([freePort(), freePort()]);
  [fileServerRedis, otherRedis] = await Promise.all([startTestRedis({ tcpPort: redisPort }), startTestRedis()]);
  objectStore = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'HEAD') return new Response(null, { status: 200 });
      if (req.method === 'GET') return new Response(EMPTY_LISTING, { headers: { 'Content-Type': 'application/xml' } });
      if (req.method !== 'PUT') return new Response(null, { status: 501 });
      await req.arrayBuffer();
      storedObjects.push(decodeURIComponent(url.pathname));
      return new Response(null, { headers: { ETag: '"stub-etag"' } });
    },
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(redisPort),
    REDIS_TLS: 'false',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: String(objectStore.port),
    MINIO_USE_SSL: 'false',
    MINIO_USE_IRSA: 'false',
    MINIO_NO_PORT: 'false',
    MINIO_ACCESS_KEY: 'test-access-key',
    MINIO_SECRET_KEY: 'test-secret-key',
    MINIO_BUCKET: 'test-bucket',
    MINIO_REGION: 'us-east-1',
    FILE_SERVER_HOST: '127.0.0.1',
    FILE_SERVER_PORT: String(fileServerPort),
    OTEL_TRACING_ENABLED: 'false',
    [INTERNAL_SERVICE_TOKEN_ENV]: TOKEN,
  };
  delete env.REDIS_PASSWORD;
  delete env.AWS_WEB_IDENTITY_TOKEN_FILE;
  delete env.AWS_ROLE_ARN;
  fileServer = spawn(process.execPath, [path.join(__dirname, 'file-server.ts')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fileServer.stdout?.on('data', (chunk: Buffer) => { fileServerLog += chunk.toString(); });
  fileServer.stderr?.on('data', (chunk: Buffer) => { fileServerLog += chunk.toString(); });

  fileServerUrl = `http://127.0.0.1:${fileServerPort}`;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (fileServer.exitCode != null) break;
    const ready = await fetch(`${fileServerUrl}/ready`).then(res => res.ok, () => false);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`File server did not become ready:\n${fileServerLog}`);
}, 30_000);

beforeEach(async () => {
  storedObjects.length = 0;
  await Promise.all([fileServerRedis.flushall(), otherRedis.flushall()]);
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env[INTERNAL_SERVICE_TOKEN_ENV];
  else process.env[INTERNAL_SERVICE_TOKEN_ENV] = originalToken;
  if (fileServer.exitCode == null) {
    const exited = new Promise(resolve => fileServer.once('exit', resolve));
    fileServer.kill('SIGKILL');
    await exited;
  }
  await objectStore.stop(true);
  await Promise.all([fileServerRedis.closeTestServer(), otherRedis.closeTestServer()]);
});

test('records an upload under the session key the API registered in the shared Redis', async () => {
  const sessionKey = sessionKeyOf(owner);
  await recordSessionOwnership(fileServerRedis, SESSION, sessionKey);

  const response = await putObject('');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ filename: 'notes.txt', fileId: OBJECT });
  expect(storedObjects).toEqual([`/test-bucket/${storageKeyForUpload(SESSION, OBJECT, '.txt', true)}`]);
  expect(await fileServerRedis.keys('upload:*')).toEqual([`upload:${sessionKey}${SESSION}${OBJECT}`]);
  expect(await authorizeWorkspaceImportSource({
    req: requestFrom(owner),
    source: { storage_session_id: SESSION, id: OBJECT },
    store: fileServerRedis,
  })).toBe(sessionKey);
  expect(await probeFileServerStore({ store: fileServerRedis, fileServerUrl })).toEqual({ status: 'shared' });
});

test('refuses an upload whose session was registered in another Redis', async () => {
  const sessionKey = sessionKeyOf(refused);
  await recordSessionOwnership(otherRedis, SESSION, sessionKey);

  const response = await putObject('report bytes');

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Upload session is not registered with this file server',
    code: UPLOAD_SESSION_UNKNOWN,
  });
  expect(storedObjects).toEqual([]);
  expect(await fileServerRedis.keys('upload:*')).toEqual([]);
  expect(await otherRedis.keys('upload:*')).toEqual([]);
  expect(await fileServerLogged('must use the same Redis as this file server')).toBe(true);
  expect(fileServerLog).not.toContain(sessionKey);
  await expect(authorizeWorkspaceImportSource({
    req: requestFrom(refused),
    source: { storage_session_id: SESSION, id: OBJECT },
    store: otherRedis,
  })).rejects.toMatchObject({ status: 403, code: 'IMPORT_SOURCE_UNAUTHORIZED' });
  expect(await probeFileServerStore({ store: otherRedis, fileServerUrl })).toEqual({ status: 'split' });
});

test('refuses a multipart upload for an unknown session instead of reporting an empty success', async () => {
  const form = new FormData();
  form.append('file', new Blob(['report bytes'], { type: 'text/plain' }), `${OBJECT}___notes.txt`);

  const response = await fetch(`${fileServerUrl}/sessions/${SESSION}/objects`, {
    method: 'POST',
    headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: TOKEN },
    body: form,
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: UPLOAD_SESSION_UNKNOWN });
  expect(storedObjects).toEqual([]);
  expect(await fileServerRedis.keys('upload:*')).toEqual([]);
});

test('answers the store probe only for an authenticated caller and a well-formed probe id', async () => {
  await fileServerRedis.set(`session:${SESSION}`, 'someone');
  const post = (probe: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${fileServerUrl}${STORE_PROBE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ probe }),
    });

  const unauthenticated = await post('0'.repeat(32));
  expect(unauthenticated.status).toBe(401);

  const arbitraryKey = await post(`session:${SESSION}`, { [INTERNAL_SERVICE_TOKEN_HEADER]: TOKEN });
  expect(arbitraryKey.status).toBe(400);

  const absent = await post('0'.repeat(32), { [INTERNAL_SERVICE_TOKEN_HEADER]: TOKEN });
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ visible: false });
});

test('reports an internal token the file server rejects as unknown, not as a mismatch', async () => {
  process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'a-different-internal-token';
  try {
    expect(await probeFileServerStore({ store: fileServerRedis, fileServerUrl }))
      .toEqual({ status: 'unknown', reason: 'unauthorized' });
  } finally {
    process.env[INTERNAL_SERVICE_TOKEN_ENV] = TOKEN;
  }
});
