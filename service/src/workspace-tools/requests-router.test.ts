import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, expect, test } from 'bun:test';
import express, { json } from 'express';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { applyPrincipal } from '../auth/principal';
import { RedisBridgeStore } from '../bridge/store';
import { createWorkspaceToolsRouter } from './router';
import { RedisWorkspaceRequests } from './requests';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });
const body = { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'README.md' };
const requestId = 'http-request-000001';

async function setup(durable = true, rejectSynchronous = false): Promise<string> {
  const redis = new RedisMock() as unknown as Redis;
  const bridge = new RedisBridgeStore(redis);
  await bridge.register({ protocolVersion: 1, workerId: 'worker', incarnationId: 'incarnation-00000001', capabilities: {
    sandboxProfile: 'native-srt', statefulWorkspace: false, runtimes: [],
    workspaceTools: { protocolVersion: 1, operations: ['read_file'], workspaces: [{ id: 'primary' }] },
  } });
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    if (req.header('X-Test-User') !== 'unauthenticated') applyPrincipal(req, {
      tenantId: 'tenant', userId: req.header('X-Test-User') ?? 'user', principalSource: 'local', codeWorkerId: 'worker',
    });
    next();
  });
  app.use(createWorkspaceToolsRouter({
    store: rejectSynchronous ? { async dispatchWorkspaceTool(): Promise<never> { throw new Error('Durable URL dispatched synchronously'); } } : bridge, requests: durable ? new RedisWorkspaceRequests(redis, bridge) : undefined,
    backend: 'remote-bridge', configuredWorkerId: 'worker', dynamicWorkers: false,
  }));
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Missing listener');
  return `http://127.0.0.1:${address.port}`;
}

function post(url: string, id = requestId, value = body): Promise<Response> {
  return fetch(`${url}/workspace-tools/requests`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-LibreChat-Workspace-Request-Id': id,
  }, body: JSON.stringify(value) });
}

test.each([false, true])('capability discovery explicitly distinguishes durable support (%s)', async durable => {
  const url = await setup(durable);
  expect(await (await fetch(`${url}/workspace-tools/capabilities`)).json()).toEqual({ durableWorkspaceRequests: durable ? 1 : 0 });
});

test('submission, duplicate lookup and cancellation use the same principal-scoped handle without exposing leases', async () => {
  const url = await setup();
  const accepted = await post(url);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ requestId, state: 'queued', queuePosition: 1 });
  const duplicate = await post(url);
  expect(duplicate.status).toBe(202);
  const status = await (await fetch(`${url}/workspace-tools/requests/${requestId}`)).json();
  expect(status).toMatchObject({ requestId, state: 'queued' });
  expect(status).not.toHaveProperty('assignment');
  expect(status).not.toHaveProperty('leaseToken');
  expect((await fetch(`${url}/workspace-tools/requests/${requestId}`, { headers: { 'X-Test-User': 'another' } })).status).toBe(404);
  const cancelled = await fetch(`${url}/workspace-tools/requests/${requestId}`, { method: 'DELETE' });
  expect(await cancelled.json()).toMatchObject({ requestId, cancelRequested: true });
});

test('missing IDs and conflicting requests fail without dispatching', async () => {
  const url = await setup();
  expect((await post(url, '')).status).toBe(400);
  expect((await post(url)).status).toBe(202);
  const conflict = await post(url, requestId, { ...body, path: 'different' });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'REQUEST_CONFLICT' });
});

test('unauthenticated request status and capability discovery are rejected', async () => {
  const url = await setup();
  for (const path of ['capabilities', `requests/${requestId}`]) {
    expect((await fetch(`${url}/workspace-tools/${path}`, { headers: { 'X-Test-User': 'unauthenticated' } })).status).toBe(401);
  }
});

test.each(['/workspace-tools/requests/', '/workspace-tools/REQUESTS'])('durable route aliases remain idempotent (%s)', async path => {
  const url = await setup(true, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-LibreChat-Workspace-Request-Id': requestId,
    }, body: JSON.stringify(body) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ requestId, state: 'queued', queuePosition: 1 });
  }
  expect(await (await fetch(`${url}/workspace-tools/requests/${requestId}`)).json()).toMatchObject({ state: 'queued' });
});
