import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeWorker } from './worker.js';

const incarnationId = 'incarnation-00000001';

test('worker executes a workspace tool assignment locally without acquiring a sandbox', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const workspaceRequests: object[] = [];
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    runtimeSupervisor: {
      async acquire() {
        throw new Error('workspace tools must not acquire a sandbox');
      },
      async reset() {},
      async quarantine() {},
    },
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: 1,
        operations: ['read_file', 'search_text'],
        workspaces: [{ id: 'primary', name: 'LibreChat' }],
      },
    },
    workspaceTools: {
      capabilities: {
        protocolVersion: 1,
        operations: ['read_file', 'search_text'],
        workspaces: [{ id: 'primary', name: 'LibreChat' }],
      },
      async execute(request) {
        workspaceRequests.push(request);
        return {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
          content: '# LibreChat',
          startLine: 1,
          endLine: 1,
          truncated: false,
        };
      },
    },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
  });

  assert.deepEqual(workspaceRequests, [
    {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    protocolVersion: 1,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    incarnationId,
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
  });
});

test('worker refuses to advertise workspace tools without a matching executor', () => {
  assert.throws(
    () =>
      new BridgeWorker({
        codeApiUrl: 'https://code.example/v1',
        token: 'worker-secret',
        workerId: 'vm-1',
        incarnationId,
        sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: ['bash'],
          workspaceTools: {
            protocolVersion: 1,
            operations: ['read_file'],
            workspaces: [{ id: 'primary' }],
          },
        },
      }),
    /workspace tool capabilities require a matching executor/i,
  );
});

test('worker compares workspace capabilities structurally', () => {
  assert.doesNotThrow(
    () =>
      new BridgeWorker({
        codeApiUrl: 'https://code.example/v1',
        token: 'worker-secret',
        workerId: 'vm-1',
        incarnationId,
        sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: ['bash'],
          workspaceTools: {
            protocolVersion: 1,
            operations: ['read_file'],
            workspaces: [{ id: 'primary', name: 'LibreChat' }],
          },
        },
        workspaceTools: {
          capabilities: {
            operations: ['read_file'],
            workspaces: [{ name: 'LibreChat', id: 'primary' }],
            protocolVersion: 1,
          },
          async execute() {
            throw new Error('not executed');
          },
        },
      }),
  );
});

test('worker rejects a workspace result returned after its deadline', async () => {
  const settlements: Array<Record<string, unknown>> = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['read_file' as const],
    workspaces: [{ id: 'primary' }],
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: workspaceCapabilities,
    },
    workspaceTools: {
      capabilities: workspaceCapabilities,
      async execute(request, signal) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: request.workspaceId,
          path: 'README.md',
          content: '# late',
          startLine: 1,
          endLine: 1,
          truncated: false,
        };
      },
    },
    fetchImpl: async (_input, init) => {
      if (init?.body != null) {
        settlements.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-deadline',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 20).toISOString(),
    remainingMs: 20,
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
  });

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.status, 'rejected');
  assert.match(String(settlements[0]?.error), /aborted|expired/i);
});

test('worker drains a completed cancellation poll before fulfilling workspace work', async () => {
  const settlements: Array<Record<string, unknown>> = [];
  let finishExecution: (() => void) | undefined;
  let finishCancellation: (() => void) | undefined;
  let markPollStarted: (() => void) | undefined;
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['read_file' as const],
    workspaces: [{ id: 'primary' }],
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: workspaceCapabilities,
    },
    workspaceTools: {
      capabilities: workspaceCapabilities,
      async execute(request) {
        await new Promise<void>((resolve) => {
          finishExecution = resolve;
        });
        return {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: request.workspaceId,
          path: 'README.md',
          content: '# cancelled',
          startLine: 1,
          endLine: 1,
          truncated: false,
        };
      },
    },
    cancellationPollIntervalMs: 1,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/cancellation')) {
        markPollStarted?.();
        return await new Promise<Response>((resolve) => {
          finishCancellation = () =>
            resolve(Response.json({ protocolVersion: 1, cancelled: true }));
        });
      }
      if (String(input).endsWith('/settle') && init?.body != null) {
        settlements.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  const completion = worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-cancelled',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    remainingMs: 5_000,
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
  });

  await pollStarted;
  finishExecution?.();
  finishCancellation?.();
  await completion;

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.status, 'rejected');
  assert.match(String(settlements[0]?.error), /aborted/i);
});

test('worker rejects workspace operations outside its advertised capability', async () => {
  let executions = 0;
  let settlement: Record<string, unknown> | undefined;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['read_file' as const],
    workspaces: [{ id: 'primary' }],
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: workspaceCapabilities,
    },
    workspaceTools: {
      capabilities: workspaceCapabilities,
      async execute() {
        executions += 1;
        throw new Error('must not execute');
      },
    },
    fetchImpl: async (_input, init) => {
      settlement = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'needle',
    },
  });

  assert.equal(executions, 0);
  assert.equal(settlement?.status, 'rejected');
  assert.match(String(settlement?.error), /operation is not advertised/i);
});
