import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, expect, test } from 'bun:test';
import express, { json } from 'express';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';

import type * as t from '../types';
import type { CodeApiPrincipal } from '../auth/principal';
import type { WorkspaceImportFileRequest, WorkspaceToolRequest } from '../../../packages/code/src/protocol';

import { applyPrincipal } from '../auth/principal';
import { RedisBridgeStore } from '../bridge/store';
import { resolveSessionKey } from '../session-key';
import { recordSessionOwnership } from '../session-ownership';
import { openEgressGrant, openEgressHandle, prepareSandboxEgress } from '../egress-grant';
import { createWorkspaceToolsRouter } from './router';
import { RedisWorkspaceRequests } from './requests';
import {
  WorkspaceImportError,
  authorizeWorkspaceImportSource,
  createWorkspaceImportService,
} from './import';

const SECRET = 'workspace-import-test-secret-of-sufficient-length';
const SESSION = 'sessAAAAAAAAAAAAAAAAA';
const OBJECT = 'fileAAAAAAAAAAAAAAAAA';
const OTHER_SESSION = 'sessBBBBBBBBBBBBBBBBB';
const OTHER_OBJECT = 'fileBBBBBBBBBBBBBBBBB';
const owner: CodeApiPrincipal = { userId: 'user-1', tenantId: 'tenant-1', principalSource: 'librechat_jwt', codeWorkerId: 'worker' };
const stranger: CodeApiPrincipal = { userId: 'user-2', tenantId: 'tenant-1', principalSource: 'librechat_jwt', codeWorkerId: 'worker' };

const importBody = (overrides: Record<string, unknown> = {}): WorkspaceImportFileRequest => ({
  protocolVersion: 1,
  operation: 'import_file',
  workspaceId: 'primary',
  path: 'uploads/report.pdf',
  source: { storage_session_id: SESSION, id: OBJECT },
  bytes: 4096,
  sha256: 'a'.repeat(64),
  ...overrides,
});

function principalRequest(principal: CodeApiPrincipal): t.AuthenticatedRequest {
  const req = { headers: {} } as t.AuthenticatedRequest;
  applyPrincipal(req, principal);
  return req;
}

/** Uploads as LibreChat's code-environment upload does: user-kind session key plus upload record. */
async function upload(redis: Redis, principal: CodeApiPrincipal, sessionId: string, objectId: string): Promise<void> {
  const sessionKey = resolveSessionKey(principalRequest(principal), { kind: 'user', id: principal.userId });
  await recordSessionOwnership(redis, sessionId, sessionKey);
  await redis.set(`upload:${sessionKey}${sessionId}${objectId}`, '1');
}

function importService(redis: Redis, minted: string[] = [], revoked: string[] = [], maxBytes = 1024 * 1024) {
  return createWorkspaceImportService({
    maxBytes,
    store: redis,
    async createGrant({ payload, claims }) {
      const grantId = `grant-${minted.length + 1}`;
      minted.push(grantId);
      return { grant_id: grantId, ...prepareSandboxEgress({ payload, claims, grantId, secret: SECRET }) };
    },
    async revokeGrant(grantId) {
      revoked.push(grantId);
    },
  });
}

// ioredis-mock instances share one keyspace across test files; clear it like the bridge suites do.
const redis = new RedisMock() as unknown as Redis;
let server: Server | undefined;
afterEach(async () => {
  server?.close();
  server = undefined;
  await redis.flushall();
});

async function listen(app: express.Express): Promise<string> {
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Missing listener');
  return `http://127.0.0.1:${address.port}`;
}

function appFor(router: express.Router): express.Express {
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    applyPrincipal(req, req.header('X-Test-User') === 'user-2' ? stranger : owner);
    next();
  });
  app.use(router);
  return app;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
}

test('ownership follows the download rule and rejects another principal\'s object', async () => {
  await upload(redis, owner, SESSION, OBJECT);
  await upload(redis, stranger, OTHER_SESSION, OTHER_OBJECT);
  const req = principalRequest(owner);

  expect(await authorizeWorkspaceImportSource({ req, store: redis, source: { storage_session_id: SESSION, id: OBJECT } }))
    .toBe(resolveSessionKey(req, { kind: 'user', id: 'user-1' }));
  const denials = [
    { storage_session_id: OTHER_SESSION, id: OTHER_OBJECT },
    { storage_session_id: SESSION, id: OTHER_OBJECT },
    { storage_session_id: OTHER_SESSION, id: OBJECT },
  ];
  for (const source of denials) {
    const error = await authorizeWorkspaceImportSource({ req, store: redis, source }).catch(caught => caught);
    expect(error).toBeInstanceOf(WorkspaceImportError);
    expect(error).toMatchObject({ status: 403, code: 'IMPORT_SOURCE_UNAUTHORIZED' });
  }
  const malformed = await authorizeWorkspaceImportSource({
    req, store: redis, source: { storage_session_id: '../escape', id: OBJECT },
  }).catch(caught => caught);
  expect(malformed).toMatchObject({ status: 400, code: 'INVALID_WORKSPACE_TOOL_REQUEST' });

  await redis.del(`session:${SESSION}`);
  const expired = await authorizeWorkspaceImportSource({ req, store: redis, source: { storage_session_id: SESSION, id: OBJECT } })
    .catch(caught => caught);
  expect(expired).toMatchObject({ status: 403, code: 'IMPORT_SOURCE_UNAUTHORIZED' });
});

test('the grant reads exactly one object, briefly, and can upload nothing', async () => {
  await upload(redis, owner, SESSION, OBJECT);
  const imports = importService(redis);
  const req = principalRequest(owner);
  const sessionKey = await imports.authorize(req, importBody());
  const before = Math.floor(Date.now() / 1000);
  const prepared = await imports.prepare({ req, request: importBody(), sessionKey, ttlSeconds: 60 });

  const grant = openEgressGrant(prepared.request.egressGrant, SECRET);
  expect(grant.input_files).toEqual([{ id: OBJECT, session_id: SESSION, name: 'report.pdf' }]);
  expect(grant.read_sessions).toEqual([SESSION]);
  expect(grant).toMatchObject({ max_upload_bytes: 0, max_output_files: 0, max_requests: 2, session_key: sessionKey });
  expect(grant.exp - before).toBeGreaterThanOrEqual(90);
  expect(grant.exp - before).toBeLessThanOrEqual(91);
  expect(prepared.request.source.id).not.toBe(OBJECT);
  expect(prepared.request.source.storage_session_id).not.toBe(SESSION);
  expect(openEgressHandle(prepared.request.source.id, SECRET)).toMatchObject({ typ: 'object', object_id: OBJECT, session_id: SESSION });
  expect(openEgressHandle(prepared.request.source.storage_session_id, SECRET)).toMatchObject({ typ: 'session', dir: 'read', session_id: SESSION });
  const { egressGrant: _grant, source: _source, ...unchanged } = prepared.request;
  const { source: _callerSource, ...callerFields } = importBody();
  expect(unchanged).toEqual(callerFields);
});

test('a synchronous import relays the granted request and revokes its grant', async () => {
  await upload(redis, owner, SESSION, OBJECT);
  await upload(redis, stranger, OTHER_SESSION, OTHER_OBJECT);
  const minted: string[] = [];
  const revoked: string[] = [];
  const dispatched: Array<{ request: WorkspaceToolRequest; executionTimeoutMs?: number }> = [];
  const url = await listen(appFor(createWorkspaceToolsRouter({
    backend: 'remote-bridge', configuredWorkerId: 'worker', dynamicWorkers: false, timeoutMs: 120_000,
    imports: importService(redis, minted, revoked, 8192),
    store: { async dispatchWorkspaceTool(args) {
      dispatched.push({ request: args.request, executionTimeoutMs: args.executionTimeoutMs });
      const request = args.request as WorkspaceImportFileRequest;
      return { protocolVersion: 1, generation: 1, leaseToken: 'lease', incarnationId: 'incarnation', status: 'fulfilled', result: {
        protocolVersion: 1, operation: 'import_file', workspaceId: 'primary', path: request.path,
        created: true, bytesWritten: request.bytes, sha256: request.sha256,
      } };
    } },
  })));
  const endpoint = `${url}/workspace-tools/execute`;

  const response = await post(endpoint, importBody());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ operation: 'import_file', created: true, bytesWritten: 4096 });
  expect(dispatched).toHaveLength(1);
  const relayed = dispatched[0]!.request as WorkspaceImportFileRequest;
  expect(typeof relayed.egressGrant).toBe('string');
  expect(relayed.source.id).not.toBe(OBJECT);
  expect(dispatched[0]!.executionTimeoutMs).toBe(120_000);
  await Bun.sleep(0);
  expect(revoked).toEqual(minted);

  const callerGrant = await post(endpoint, { ...importBody(), egressGrant: 'ceg1.forged' });
  expect(callerGrant.status).toBe(400);
  const foreign = await post(endpoint, importBody({ source: { storage_session_id: OTHER_SESSION, id: OTHER_OBJECT } }));
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ code: 'IMPORT_SOURCE_UNAUTHORIZED' });
  const stolen = await post(endpoint, importBody(), { 'X-Test-User': 'user-2' });
  expect(stolen.status).toBe(403);
  const oversized = await post(endpoint, importBody({ bytes: 8193 }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });
  expect(dispatched).toHaveLength(1);
  expect(minted).toHaveLength(1);
});

test('a caller that disconnects while its grant is minted never dispatches, and the grant is revoked', async () => {
  await upload(redis, owner, SESSION, OBJECT);
  const minted: string[] = [];
  const revoked: string[] = [];
  const base = importService(redis, minted, revoked);
  const grantRequested = Promise.withResolvers<void>();
  const releaseGrant = Promise.withResolvers<void>();
  let dispatched = 0;
  const url = await listen(appFor(createWorkspaceToolsRouter({
    backend: 'remote-bridge', configuredWorkerId: 'worker', dynamicWorkers: false,
    imports: { ...base, async prepare(args) {
      grantRequested.resolve();
      await releaseGrant.promise;
      return base.prepare(args);
    } },
    store: { async dispatchWorkspaceTool(): Promise<never> { dispatched++; throw new Error('must not dispatch'); } },
  })));
  const caller = new AbortController();
  const response = post(`${url}/workspace-tools/execute`, importBody(), {}, caller.signal).catch(() => undefined);
  await grantRequested.promise;
  caller.abort();
  await response;
  await Bun.sleep(50);
  releaseGrant.resolve();
  for (let attempt = 0; attempt < 100 && revoked.length === 0; attempt++) await Bun.sleep(10);
  expect(dispatched).toBe(0);
  expect(revoked).toEqual(minted);
  expect(minted).toHaveLength(1);
});

test('a Code API that cannot mint grants refuses import_file without dispatching', async () => {
  let dispatched = 0;
  const url = await listen(appFor(createWorkspaceToolsRouter({
    backend: 'remote-bridge', configuredWorkerId: 'worker', dynamicWorkers: false,
    store: { async dispatchWorkspaceTool(): Promise<never> { dispatched++; throw new Error('must not dispatch'); } },
  })));
  const response = await post(`${url}/workspace-tools/execute`, importBody());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
  expect(dispatched).toBe(0);
});

test('a durable import fingerprints the caller request and mints its grant once', async () => {
  await upload(redis, owner, SESSION, OBJECT);
  const bridge = new RedisBridgeStore(redis);
  await bridge.register({ protocolVersion: 1, workerId: 'worker', incarnationId: 'incarnation-00000001', capabilities: {
    sandboxProfile: 'anthropic-srt', statefulWorkspace: false, runtimes: [],
    workspaceTools: { protocolVersion: 1, operations: ['read_file', 'import_file'], workspaces: [{ id: 'primary' }] },
  } });
  const minted: string[] = [];
  const revoked: string[] = [];
  const url = await listen(appFor(createWorkspaceToolsRouter({
    backend: 'remote-bridge', configuredWorkerId: 'worker', dynamicWorkers: false,
    imports: importService(redis, minted, revoked),
    requests: new RedisWorkspaceRequests(redis, bridge),
    store: { async dispatchWorkspaceTool(): Promise<never> { throw new Error('durable requests never dispatch synchronously'); } },
  })));
  const headers = { 'X-LibreChat-Workspace-Request-Id': 'import-request-000001' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post(`${url}/workspace-tools/requests`, importBody(), headers);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: 'queued', workspaceId: 'primary' });
  }
  expect(minted).toHaveLength(1);

  // A retry of the same request answers from its record even once the upload is gone.
  await redis.del(`session:${SESSION}`);
  const retried = await post(`${url}/workspace-tools/requests`, importBody(), headers);
  expect(retried.status).toBe(202);
  expect(minted).toHaveLength(1);

  const keys = (await redis.keys('codeapi:workspace-requests:v1:*')).filter(key => !key.endsWith(':active'));
  const records = await Promise.all(keys.map(key => redis.hget(key, 'record')));
  const stored = records.flatMap(record => record == null ? [] : [JSON.parse(record).request as WorkspaceImportFileRequest]);
  expect(stored.length).toBeGreaterThan(0);
  for (const request of stored) {
    expect(openEgressGrant(request.egressGrant!, SECRET).grant_id).toBe(minted[0]);
    expect(request.source.id).not.toBe(OBJECT);
  }

  // Racing submissions of one new request ID: only the adopted grant survives.
  const raceHeaders = { 'X-LibreChat-Workspace-Request-Id': 'import-request-000002' };
  await upload(redis, owner, SESSION, OBJECT);
  const before = minted.length;
  const raced = await Promise.all([0, 1].map(() => post(`${url}/workspace-tools/requests`, importBody(), raceHeaders)));
  expect(raced.map(response => response.status)).toEqual([202, 202]);
  const racedGrants = minted.slice(before);
  expect(racedGrants.length).toBeGreaterThan(0);
  expect(revoked).toHaveLength(racedGrants.length - 1);

  const mintedBeforeConflict = minted.length;
  const conflict = await post(`${url}/workspace-tools/requests`, importBody({ bytes: 1 }), headers);
  expect(conflict.status).toBe(409);
  expect(minted).toHaveLength(mintedBeforeConflict);
});
