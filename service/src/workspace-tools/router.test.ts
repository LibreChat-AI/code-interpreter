import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import express, { json } from 'express';
import rateLimitFactory from 'express-rate-limit';

import logger from '../logger';
import { env } from '../config';
import { apiKeyAuth } from '../middleware/auth';
import { workspaceToolOutcomeLogging } from './outcome';
import { applyPrincipal } from '../auth/principal';
import { BridgeStoreError } from '../bridge/store';
import { bridgeStoreStatus, createWorkspaceToolsRouter } from './router';

let server: Server | undefined;
let logCompleted: ReturnType<typeof Promise.withResolvers<void>>;
let logSpy: ReturnType<typeof spyOn<typeof logger, 'log'>>;

beforeEach(() => {
  logCompleted = Promise.withResolvers<void>();
  logSpy = spyOn(logger, 'log').mockImplementation(() => { logCompleted.resolve(); return logger; });
});

afterEach(() => {
  server?.close();
  server = undefined;
  logSpy.mockRestore();
});

test('maps invalid worker results to an upstream failure', () => {
  expect(bridgeStoreStatus(new BridgeStoreError('RESULT_INVALID', 'invalid worker result'))).toBe(502);
});

test('rejects new workspace dispatches while the service is shutting down', async () => {
  let dispatched = false;
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    applyPrincipal(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      principalSource: 'librechat_jwt',
      codeWorkerId: 'user-worker',
    });
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: 'remote-bridge',
      configuredWorkerId: 'shared-worker',
      dynamicWorkers: true,
      isShuttingDown: () => true,
      store: {
        async dispatchWorkspaceTool() {
          dispatched = true;
          throw new Error('must not dispatch');
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected TCP listener');
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    }),
  });

  expect(response.status).toBe(503);
  expect(dispatched).toBe(false);
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'warn',
    'Workspace tool request completed',
    expect.objectContaining({
      status: 503,
      errorCode: 'SERVICE_SHUTTING_DOWN',
      outcome: 'completed',
    }),
  );
});

test.each([
  ['SEARCH_TIMEOUT', 504],
  ['SEARCH_UNAVAILABLE', 503],
  ['LIST_TIMEOUT', 504],
  ['LIST_UNAVAILABLE', 503],
  ['WRITE_DISABLED', 403],
  ['WRITE_LIMIT_EXCEEDED', 413],
  ['WRITE_UNAVAILABLE', 503],
  ['EDIT_CONFLICT', 409],
  ['COMMAND_TIMEOUT', 504],
  ['COMMAND_UNAVAILABLE', 503],
  ['COMMAND_DISABLED', 403],
] as const)('maps worker %s rejections to HTTP %i', async (errorCode, expectedStatus) => {
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    applyPrincipal(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      principalSource: 'librechat_jwt',
      codeWorkerId: 'user-worker',
    });
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: 'remote-bridge',
      configuredWorkerId: 'shared-worker',
      dynamicWorkers: true,
      store: {
        async dispatchWorkspaceTool() {
          return {
            protocolVersion: 1,
            generation: 1,
            leaseToken: 'lease-token',
            incarnationId: 'incarnation-1',
            status: 'rejected',
            error: 'search failed',
            errorCode,
          };
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected TCP listener');
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'needle',
    }),
  });

  expect(response.status).toBe(expectedStatus);
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'warn',
    'Workspace tool request completed',
    expect.objectContaining({
      status: expectedStatus,
      errorCode,
      operation: 'search_text',
      workerId: 'user-worker',
      dispatchDurationMs: expect.any(Number),
      deadlineBudgetMs: 30_000,
    }),
  );
  await expect(response.json()).resolves.toMatchObject({
    code: errorCode,
  });
});

test('dispatches an authenticated workspace tool request to the principal-bound worker', async () => {
  let dispatchArgs: Record<string, unknown> | undefined;
  const app = express();
  app.use(json());
  app.use((_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body): typeof res => { setTimeout(() => send(body), 120); return res; };
    next();
  });
  app.use((req, _res, next) => {
    applyPrincipal(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      principalSource: 'librechat_jwt',
      codeWorkerId: 'user-worker',
    });
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: 'remote-bridge',
      configuredWorkerId: 'shared-worker',
      dynamicWorkers: true,
      store: {
        async dispatchWorkspaceTool(args) {
          dispatchArgs = args as unknown as Record<string, unknown>;
          return {
            protocolVersion: 1,
            generation: 1,
            leaseToken: 'lease-token',
            incarnationId: 'incarnation-1',
            status: 'fulfilled',
            result: {
              protocolVersion: 1,
              operation: 'read_file',
              workspaceId: 'primary',
              path: 'README.md',
              content: '# LibreChat',
              startLine: 1,
              endLine: 1,
              truncated: false,
            },
          };
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected TCP listener');
  }

  const request = {
    protocolVersion: 1,
    operation: 'read_file',
    workspaceId: 'primary',
    path: 'README.md',
  };
  const response = await fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LibreChat-Code-Worker-ID': 'user-worker',
    },
    body: JSON.stringify(request),
  });

  expect(response.status).toBe(200);
  const timing = Reflect.get(logSpy.mock.calls[0], 2) as { durationMs: number; dispatchDurationMs: number };
  expect(timing.durationMs - timing.dispatchDurationMs).toBeGreaterThanOrEqual(100);
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'info',
    'Workspace tool request completed',
    expect.objectContaining({
      status: 200,
      operation: 'read_file',
      workerId: 'user-worker',
      outcome: 'completed',
    }),
  );
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain('# LibreChat');
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain('tenant-1');
  await expect(response.json()).resolves.toMatchObject({
    operation: 'read_file',
    content: '# LibreChat',
  });
  expect(dispatchArgs).toMatchObject({
    workerId: 'user-worker',
    tenantId: 'tenant-1',
    requireTenantBinding: true,
    request,
  });
});

test.each([
  ['WORKER_UNAUTHORIZED', 403],
  ['ASSIGNMENT_INVALID', 400],
  ['RESULT_INVALID', 502],
  ['ASSIGNMENT_EXPIRED', 504],
  ['WORKER_OFFLINE', 503],
  ['WORKER_BUSY', 503],
  ['WORKER_MISMATCH', 409],
] as const)('logs store rejection %s with actual HTTP %i', async (errorCode, expectedStatus) => {
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    applyPrincipal(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      principalSource: 'librechat_jwt',
      codeWorkerId: 'user-worker',
    });
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: 'remote-bridge',
      configuredWorkerId: 'user-worker',
      dynamicWorkers: true,
      timeoutMs: 300_000,
      store: {
        async dispatchWorkspaceTool() {
          throw new BridgeStoreError(errorCode, 'private diagnostic details');
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  const response = await fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
    }),
  });
  expect(response.status).toBe(expectedStatus);
  await response.text();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'warn',
    'Workspace tool request completed',
    expect.objectContaining({
      operation: 'list_files',
      workerId: 'user-worker',
      status: expectedStatus,
      errorCode,
      outcome: 'completed',
      deadlineBudgetMs: 300_000,
      dispatchDurationMs: expect.any(Number),
    }),
  );
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private diagnostic details');
});

test.each([
  ['unauthenticated', 401, 'UNAUTHENTICATED'],
  ['invalid request', 400, 'INVALID_WORKSPACE_TOOL_REQUEST'],
  ['selection denied', 403, 'WORKER_SELECTION_REJECTED'],
  ['invalid worker', 400, 'WORKER_SELECTION_REJECTED'],
  ['no backend', 503, 'WORKSPACE_BACKEND_UNAVAILABLE'],
] as const)('logs early %s without dispatching', async (scenario, status, errorCode) => {
  const app = express();
  app.use(json());
  app.use((req, _res, next) => {
    const workerId = scenario === 'invalid worker' ? 'bad/worker' : 'user-worker';
    if (scenario !== 'unauthenticated')
      applyPrincipal(req, {
        userId: 'user-1',
        tenantId: 'tenant-1',
        principalSource: 'librechat_jwt',
        codeWorkerId:
          scenario === 'no backend' ? undefined : workerId,
      });
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: scenario === 'no backend' ? 'http' : 'remote-bridge',
      configuredWorkerId: 'user-worker',
      dynamicWorkers: true,
      store: {
        async dispatchWorkspaceTool() {
          throw new Error('Must not dispatch');
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  const response = await fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(scenario === 'selection denied' ? { 'X-LibreChat-Code-Worker-ID': 'forged-worker' } : {}),
    },
    body: JSON.stringify(
      scenario === 'invalid request'
        ? { operation: 'private-untrusted-operation' }
        : {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
        },
    ),
  });
  expect(response.status).toBe(status);
  await response.text();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'warn',
    'Workspace tool request completed',
    expect.objectContaining({
      status,
      errorCode,
      dispatchDurationMs: undefined,
    }),
  );
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain('forged-worker');
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private-untrusted-operation');
});

test('logs a disconnected dispatch once without inventing HTTP 200', async () => {
  const app = express();
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const settlementGate = Promise.withResolvers<void>();
  let dispatchAborted = false;
  let closeConnection = (): void => { throw new Error('connection not ready'); };
  app.use(json());
  app.use((req, res, next) => {
    applyPrincipal(req, { userId: 'user-1', tenantId: 'tenant-1', principalSource: 'librechat_jwt', codeWorkerId: 'user-worker' });
    closeConnection = (): void => { res.destroy(); };
    res.once('close', () => closed.resolve());
    next();
  });
  app.use(
    createWorkspaceToolsRouter({
      backend: 'remote-bridge',
      configuredWorkerId: 'user-worker',
      dynamicWorkers: true,
      store: {
        async dispatchWorkspaceTool({ signal }) {
          started.resolve();
          return await new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                dispatchAborted = true;
                void settlementGate.promise.then(() => reject(new BridgeStoreError('ASSIGNMENT_EXPIRED', 'caller left')));
              },
              { once: true },
            );
          });
        },
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${address.port}/workspace-tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' }),
  });
  await started.promise;
  closeConnection();
  await expect(response).rejects.toThrow();
  await closed.promise;
  expect(dispatchAborted).toBe(true);
  expect(logSpy).not.toHaveBeenCalled();
  settlementGate.resolve();
  await logCompleted.promise;
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    'warn',
    'Workspace tool request completed',
    expect.objectContaining({
      outcome: 'disconnected',
      errorCode: 'ASSIGNMENT_EXPIRED',
      status: undefined,
      operation: 'list_files',
      workerId: 'user-worker',
    }),
  );
});

test.each(['auth', 'limit'] as const)('logs requests rejected by upstream %s middleware', async (stage) => {
  const originalLocalMode = env.LOCAL_MODE;
  const originalProvider = process.env.CODEAPI_AUTH_PROVIDER;
  env.LOCAL_MODE = false;
  process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
  try {
    const app = express();
    app.use('/v1/workspace-tools/execute', workspaceToolOutcomeLogging);
    app.use(json());
    if (stage === 'auth') app.use(apiKeyAuth);
    else app.use(rateLimitFactory({ windowMs: 60_000, max: 1 }));
    let reachedHandler = false;
    app.post('/v1/workspace-tools/execute', (_req, res) => {
      reachedHandler = true;
      res.json({ ok: true });
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
    const request = (): Promise<Response> => fetch(`http://127.0.0.1:${address.port}/v1/workspace-tools/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (stage === 'limit') {
      await (await request()).text();
      logSpy.mockClear();
      reachedHandler = false;
    }
    const response = await request();
    await response.text();
    expect(response.status).toBe(stage === 'auth' ? 401 : 429);
    expect(reachedHandler).toBe(false);
    expect(logSpy.mock.calls.filter(([, message]) => message === 'Workspace tool request completed')).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith('warn', 'Workspace tool request completed', expect.objectContaining({
      status: response.status, errorCode: stage === 'auth' ? 'UNAUTHENTICATED' : 'RATE_LIMITED',
      dispatchDurationMs: undefined, outcome: 'completed',
    }));
  } finally {
    env.LOCAL_MODE = originalLocalMode;
    if (originalProvider == null) delete process.env.CODEAPI_AUTH_PROVIDER;
    else process.env.CODEAPI_AUTH_PROVIDER = originalProvider;
  }
});
