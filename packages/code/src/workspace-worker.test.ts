import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeProtocolError } from './protocol.js';
import { BridgeWorker, BridgeWorkspaceQuarantinedError } from './worker.js';
import { WorkspaceToolError } from './workspace.js';

const incarnationId = 'incarnation-00000001';

const listWorkspaceCapabilities = {
  protocolVersion: 1 as const,
  operations: [
    'read_file' as const,
    'search_text' as const,
    'list_files' as const,
  ],
  workspaces: [{ id: 'primary' }],
};

function registrationResponse(supportsList: boolean): Response {
  return Response.json({
    protocolVersion: 1,
    workerId: 'vm-1',
    incarnationId,
    registeredAt: new Date().toISOString(),
    leaseTtlMs: 60_000,
    ...(supportsList
      ? {
          supportedWorkspaceToolOperations: [
            'read_file',
            'search_text',
            'list_files',
          ],
        }
      : {}),
  });
}

function listWorkspaceExecutor() {
  return {
    capabilities: listWorkspaceCapabilities,
    async execute() {
      return {
        protocolVersion: 1 as const,
        operation: 'list_files' as const,
        workspaceId: 'primary',
        paths: [],
        truncated: false,
      };
    },
  };
}

function mutationQuarantine(
  onQuarantine?: (reason: string) => void,
  onArm?: (reason: string) => void,
  onClear?: () => void,
) {
  return {
    async assertAvailable() {},
    async arm(reason: string) {
      onArm?.(reason);
    },
    async clear() {
      onClear?.();
    },
    async quarantine(reason: string) {
      onQuarantine?.(reason);
    },
  };
}

test('worker keeps v1 registration compatible until list_files support is advertised', async () => {
  const registrations: string[][] = [];
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
      workspaceTools: listWorkspaceCapabilities,
    },
    workspaceTools: listWorkspaceExecutor(),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        capabilities: { workspaceTools?: { operations: string[] } };
      };
      registrations.push(body.capabilities.workspaceTools?.operations ?? []);
      return registrationResponse(false);
    },
  });

  await worker.register();

  assert.deepEqual(registrations, [['read_file', 'search_text']]);
});

test('worker re-registers list_files after the Code API advertises support', async () => {
  const registrations: string[][] = [];
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
      workspaceTools: listWorkspaceCapabilities,
    },
    workspaceTools: listWorkspaceExecutor(),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        capabilities: { workspaceTools?: { operations: string[] } };
      };
      registrations.push(body.capabilities.workspaceTools?.operations ?? []);
      return registrationResponse(true);
    },
  });

  await worker.register();

  assert.deepEqual(registrations, [
    ['read_file', 'search_text'],
    ['read_file', 'search_text', 'list_files'],
  ]);
});

test('worker omits restricted workspaces that legacy registration would widen', async () => {
  const registrations: Array<{
    operations: string[];
    workspaces: Array<Record<string, unknown>>;
  }> = [];
  let executed = false;
  let settlement: Record<string, unknown> | undefined;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['read_file' as const, 'search_text' as const],
    workspaces: [
      { id: 'read-only', operations: ['read_file' as const] },
      {
        id: 'searchable',
        operations: ['read_file' as const, 'search_text' as const],
      },
    ],
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
        executed = true;
        throw new Error('must not execute an omitted workspace');
      },
    },
    fetchImpl: async (_input, init) => {
      if (String(_input).endsWith('/settle')) {
        settlement = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ protocolVersion: 1, accepted: true });
      }
      const body = JSON.parse(String(init?.body)) as {
        capabilities: {
          workspaceTools: {
            operations: string[];
            workspaces: Array<Record<string, unknown>>;
          };
        };
      };
      registrations.push(body.capabilities.workspaceTools);
      return registrationResponse(false);
    },
  });

  await worker.register();

  assert.deepEqual(registrations, [
    {
      protocolVersion: 1,
      operations: ['read_file', 'search_text'],
      workspaces: [{ id: 'searchable' }],
    },
  ]);
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-legacy-omitted-workspace',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'read-only',
      query: 'needle',
    },
  });
  assert.equal(executed, false);
  assert.equal(settlement?.status, 'rejected');
  assert.match(String(settlement?.error), /workspace is not advertised/i);
});

test('worker promotes only operations understood by an older Code API', async () => {
  const registrations: Array<{
    operations: string[];
    workspaces: Array<Record<string, unknown>>;
  }> = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: [
      'read_file' as const,
      'search_text' as const,
      'list_files' as const,
      'write_file' as const,
      'edit_file' as const,
    ],
    workspaces: [
      {
        id: 'primary',
        operations: [
          'read_file' as const,
          'search_text' as const,
          'list_files' as const,
          'write_file' as const,
          'edit_file' as const,
        ],
      },
    ],
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
        throw new Error('not executed');
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        capabilities: {
          workspaceTools: {
            operations: string[];
            workspaces: Array<Record<string, unknown>>;
          };
        };
      };
      registrations.push(body.capabilities.workspaceTools);
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: [
          'read_file',
          'search_text',
          'list_files',
        ],
      });
    },
  });

  await worker.register();

  assert.deepEqual(registrations, [
    {
      protocolVersion: 1,
      operations: ['read_file', 'search_text'],
      workspaces: [{ id: 'primary' }],
    },
    {
      protocolVersion: 1,
      operations: ['read_file', 'search_text', 'list_files'],
      workspaces: [
        {
          id: 'primary',
          operations: ['read_file', 'search_text', 'list_files'],
        },
      ],
    },
  ]);
});

test('worker retains per-workspace restrictions during partial mutation promotion', async () => {
  const registrations: Array<{
    operations: string[];
    workspaces: Array<Record<string, unknown>>;
  }> = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: [
      'read_file' as const,
      'search_text' as const,
      'list_files' as const,
      'write_file' as const,
      'edit_file' as const,
    ],
    workspaces: [
      {
        id: 'readonly',
        operations: [
          'read_file' as const,
          'search_text' as const,
          'list_files' as const,
        ],
      },
      {
        id: 'writable',
        operations: [
          'read_file' as const,
          'search_text' as const,
          'list_files' as const,
          'write_file' as const,
          'edit_file' as const,
        ],
      },
    ],
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
        throw new Error('not executed');
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        capabilities: {
          workspaceTools: {
            operations: string[];
            workspaces: Array<Record<string, unknown>>;
          };
        };
      };
      registrations.push(body.capabilities.workspaceTools);
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: [
          'read_file',
          'search_text',
          'list_files',
          'write_file',
        ],
      });
    },
  });

  await worker.register();

  assert.deepEqual(registrations[1], {
    protocolVersion: 1,
    operations: ['read_file', 'search_text', 'list_files', 'write_file'],
    workspaces: [
      {
        id: 'readonly',
        operations: ['read_file', 'search_text', 'list_files'],
      },
      {
        id: 'writable',
        operations: [
          'read_file',
          'search_text',
          'list_files',
          'write_file',
        ],
      },
    ],
  });
});

test('worker retains per-workspace restrictions during read-only promotion', async () => {
  const registrations: Array<{
    operations: string[];
    workspaces: Array<Record<string, unknown>>;
  }> = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['read_file' as const, 'list_files' as const],
    workspaces: [
      { id: 'read-only', operations: ['read_file' as const] },
      {
        id: 'listable',
        operations: ['read_file' as const, 'list_files' as const],
      },
    ],
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
        throw new Error('not executed');
      },
    },
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        capabilities: {
          workspaceTools: {
            operations: string[];
            workspaces: Array<Record<string, unknown>>;
          };
        };
      };
      registrations.push(body.capabilities.workspaceTools);
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: ['read_file', 'list_files'],
      });
    },
  });

  await worker.register();

  assert.deepEqual(registrations[1]?.workspaces, [
    { id: 'read-only', operations: ['read_file'] },
    { id: 'listable', operations: ['read_file', 'list_files'] },
  ]);
});

test('worker retains a compatible registration when list_files promotion times out', async () => {
  let registrationRequests = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    registrationTransportTimeoutMs: 20,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: listWorkspaceCapabilities,
    },
    workspaceTools: listWorkspaceExecutor(),
    fetchImpl: async (_input, init) => {
      registrationRequests += 1;
      if (registrationRequests === 1) return registrationResponse(true);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      });
    },
  });

  const registration = await worker.register();

  assert.equal(registration.workerId, 'vm-1');
  assert.equal(registrationRequests, 2);
});

test('worker preserves bounded workspace rejection codes', async () => {
  let settlement: Record<string, unknown> | undefined;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['search_text' as const],
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
        throw new WorkspaceToolError(
          'Workspace search timed out',
          'SEARCH_TIMEOUT',
        );
      },
    },
    fetchImpl: async (_input, init) => {
      settlement = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-timeout',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
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

  assert.equal(settlement?.status, 'rejected');
  assert.equal(settlement?.errorCode, 'SEARCH_TIMEOUT');
});

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

test('worker stops after Code API rejects a fulfilled workspace mutation', async () => {
  let quarantinedReason: string | undefined;
  let armed = 0;
  let cleared = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      async execute(request) {
        return {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: request.workspaceId,
          path: 'notes.txt',
          bytesWritten: 7,
          created: true,
        };
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      (reason) => {
        quarantinedReason = reason;
      },
      () => {
        armed += 1;
      },
      () => {
        cleared += 1;
      },
    ),
    fetchImpl: async () =>
      Response.json({ error: 'assignment was fenced' }, { status: 409 }),
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-rejected',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.match(
    quarantinedReason ?? '',
    /rejected a fulfilled workspace mutation/i,
  );
  assert.equal(armed, 1);
  assert.equal(cleared, 0);
});

test('worker stops after a fulfilled workspace mutation settlement remains ambiguous', async () => {
  let quarantinedReason: string | undefined;
  let cleared = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['edit_file' as const],
    workspaces: [{ id: 'primary', operations: ['edit_file' as const] }],
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
      async execute(request) {
        return {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: request.workspaceId,
          path: 'notes.txt',
          bytesWritten: 6,
          replacements: 1,
        };
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      (reason) => {
        quarantinedReason = reason;
      },
      undefined,
      () => {
        cleared += 1;
      },
    ),
    fetchImpl: async () => {
      throw new TypeError('connection reset');
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-edit-ambiguous',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 50).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        oldText: 'before',
        newText: 'after',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.match(quarantinedReason ?? '', /ambiguous workspace mutation/i);
  assert.equal(cleared, 0);
});

test('worker clears its pre-armed quarantine only after mutation settlement is accepted', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      async execute(request) {
        lifecycle.push('execute');
        return {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: request.workspaceId,
          path: 'notes.txt',
          bytesWritten: 7,
          created: true,
        };
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      undefined,
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-write-success',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      content: 'written',
    },
  });

  assert.deepEqual(lifecycle, ['arm', 'execute', 'settle', 'clear']);
});

test('worker retains quarantine when a mutation executor fails ambiguously', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
        lifecycle.push('execute');
        throw new Error('unknown executor state');
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      () => lifecycle.push('quarantine'),
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-unknown',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.deepEqual(lifecycle, ['arm', 'execute', 'quarantine']);
});

test('worker retains quarantine for typed errors from untrusted mutation executors', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
        lifecycle.push('execute');
        throw new WorkspaceToolError(
          'post-commit durability failed',
          'WRITE_UNAVAILABLE',
        );
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      () => lifecycle.push('quarantine'),
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-typed-error',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.deepEqual(lifecycle, ['arm', 'execute', 'quarantine']);
});

test('worker clears quarantine after an atomic executor rejection is settled', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      mutationFailuresAreAtomic: true,
      async execute() {
        lifecycle.push('execute');
        throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      () => lifecycle.push('quarantine'),
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-write-clean-rejection',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'missing/outside.txt',
      content: 'blocked',
    },
  });
  assert.deepEqual(lifecycle, ['arm', 'execute', 'settle', 'clear']);
});

test('worker retains quarantine when an atomic executor cannot confirm durability', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      mutationFailuresAreAtomic: true,
      async execute() {
        lifecycle.push('execute');
        throw new WorkspaceToolError(
          'Workspace mutation durability could not be confirmed',
          'WRITE_UNAVAILABLE',
          true,
        );
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      () => lifecycle.push('quarantine'),
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-uncertain-durability',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.deepEqual(lifecycle, ['arm', 'execute', 'quarantine']);
});

test('worker retains quarantine when a mutation executor returns an invalid result', async () => {
  const lifecycle: string[] = [];
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
        lifecycle.push('execute');
        return { malformed: true } as never;
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(
      () => lifecycle.push('quarantine'),
      () => lifecycle.push('arm'),
      () => lifecycle.push('clear'),
    ),
    fetchImpl: async () => {
      lifecycle.push('settle');
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-invalid-result',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.deepEqual(lifecycle, ['arm', 'execute', 'quarantine']);
});

test('worker heartbeats through the marker armed by its active mutation', async () => {
  let availabilityChecks = 0;
  let registrations = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      async execute(request) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: request.workspaceId,
          path: 'notes.txt',
          bytesWritten: 7,
          created: true,
        };
      },
    },
    workspaceMutationQuarantine: {
      async assertAvailable() {
        availabilityChecks += 1;
      },
      async arm() {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      async clear() {},
      async quarantine() {},
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/register')) {
        registrations += 1;
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId,
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 50,
          supportedWorkspaceToolOperations: ['write_file'],
        });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.register();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-workspace-write-heartbeat',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      content: 'written',
    },
  });

  assert.ok(registrations >= 2);
  assert.equal(availabilityChecks, 1);
});

test('worker stops when cancellation races a completed workspace mutation', async () => {
  const controller = new AbortController();
  let settlementAttempts = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
      async execute(request) {
        controller.abort(new Error('shutdown'));
        return {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: request.workspaceId,
          path: 'notes.txt',
          bytesWritten: 7,
          created: true,
        };
      },
    },
    workspaceMutationQuarantine: mutationQuarantine(),
    fetchImpl: async () => {
      settlementAttempts += 1;
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle(
      {
        protocolVersion: 1,
        assignmentId: 'assignment-workspace-write-cancelled',
        workerId: 'vm-1',
        incarnationId,
        generation: 4,
        leaseToken: 'lease-token-that-is-long-enough-for-testing',
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        executionKind: 'workspace_tool',
        request: {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: 'primary',
          path: 'notes.txt',
          content: 'written',
        },
      },
      controller.signal,
    ),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(settlementAttempts, 0);
});

test('worker refuses registration while durable mutation quarantine is active', async () => {
  let registrations = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
        throw new Error('not executed');
      },
    },
    workspaceMutationQuarantine: {
      async assertAvailable() {
        throw new BridgeProtocolError(
          'workspace quarantined',
          undefined,
          'WORKER_QUARANTINED',
        );
      },
      async arm() {},
      async clear() {},
      async quarantine() {},
    },
    fetchImpl: async () => {
      registrations += 1;
      return registrationResponse(true);
    },
  });

  await assert.rejects(worker.register(), (error: unknown) => {
    assert.equal((error as BridgeProtocolError).code, 'WORKER_QUARANTINED');
    return true;
  });
  assert.equal(registrations, 0);
});

test('worker never executes a mutation when durable quarantine cannot be armed', async () => {
  let executions = 0;
  let requests = 0;
  const workspaceCapabilities = {
    protocolVersion: 1 as const,
    operations: ['write_file' as const],
    workspaces: [{ id: 'primary', operations: ['write_file' as const] }],
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
        throw new Error('not executed');
      },
    },
    workspaceMutationQuarantine: {
      async assertAvailable() {},
      async arm() {
        throw new Error('disk unavailable');
      },
      async clear() {},
      async quarantine() {},
    },
    fetchImpl: async () => {
      requests += 1;
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-workspace-write-unarmed',
      workerId: 'vm-1',
      incarnationId,
      generation: 4,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      executionKind: 'workspace_tool',
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'written',
      },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(executions, 0);
  assert.equal(requests, 0);
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

test('worker drains a cancellation response body before fulfilling workspace work', async () => {
  const settlements: Array<Record<string, unknown>> = [];
  let finishExecution: (() => void) | undefined;
  let markHeadersReceived: (() => void) | undefined;
  const headersReceived = new Promise<void>((resolve) => {
    markHeadersReceived = resolve;
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
        const response = new Response(
          new ReadableStream({
            start(controller) {
              let finished = false;
              init?.signal?.addEventListener(
                'abort',
                () => {
                  if (finished) return;
                  finished = true;
                  controller.error(new DOMException('aborted', 'AbortError'));
                },
                { once: true },
              );
              setTimeout(() => {
                if (!init?.signal?.aborted && !finished) {
                  finished = true;
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ protocolVersion: 1, cancelled: true }),
                    ),
                  );
                  controller.close();
                }
              }, 0);
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
        markHeadersReceived?.();
        return response;
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
    assignmentId: 'assignment-workspace-cancelled-body',
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

  await headersReceived;
  finishExecution?.();
  await completion;

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.status, 'rejected');
  assert.match(String(settlements[0]?.error), /aborted/i);
});

test('worker rechecks its deadline after draining cancellation', async () => {
  const settlements: Array<Record<string, unknown>> = [];
  let finishExecution: (() => void) | undefined;
  let releaseBody: (() => void) | undefined;
  let markHeadersReceived: (() => void) | undefined;
  const headersReceived = new Promise<void>((resolve) => {
    markHeadersReceived = resolve;
  });
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve;
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
          content: '# late',
          startLine: 1,
          endLine: 1,
          truncated: false,
        };
      },
    },
    cancellationPollIntervalMs: 1,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/cancellation')) {
        markHeadersReceived?.();
        return {
          ok: true,
          status: 200,
          async json() {
            await bodyReleased;
            const blockedUntil = Date.now() + 60;
            while (Date.now() < blockedUntil) {
              // Model synchronous body parsing that crosses the deadline.
            }
            return { protocolVersion: 1, cancelled: false };
          },
        } as Response;
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
    assignmentId: 'assignment-workspace-drain-deadline',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 50).toISOString(),
    remainingMs: 50,
    executionKind: 'workspace_tool',
    request: {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
  });

  await headersReceived;
  finishExecution?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseBody?.();
  await completion;

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.status, 'rejected');
  assert.match(String(settlements[0]?.error), /expired/i);
});

test('worker preserves a drained 404 cancellation response', async () => {
  const settlements: Array<Record<string, unknown>> = [];
  let finishExecution: (() => void) | undefined;
  let releaseBody: (() => void) | undefined;
  let markHeadersReceived: (() => void) | undefined;
  const headersReceived = new Promise<void>((resolve) => {
    markHeadersReceived = resolve;
  });
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve;
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
        markHeadersReceived?.();
        return {
          ok: false,
          status: 404,
          async json() {
            await bodyReleased;
            return {};
          },
        } as Response;
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
    assignmentId: 'assignment-workspace-cancelled-404',
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

  await headersReceived;
  finishExecution?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseBody?.();
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
    operations: ['read_file' as const, 'search_text' as const],
    workspaces: [
      { id: 'primary', operations: ['read_file' as const] },
    ],
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
