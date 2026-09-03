import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, expect, test } from 'bun:test';
import express, { json } from 'express';

import { applyPrincipal } from '../auth/principal';
import { BridgeStoreError } from '../bridge/store';
import { bridgeStoreStatus, createWorkspaceToolsRouter } from './router';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
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
  await expect(response.json()).resolves.toMatchObject({ code: errorCode });
});

test('dispatches an authenticated workspace tool request to the principal-bound worker', async () => {
  let dispatchArgs: Record<string, unknown> | undefined;
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
