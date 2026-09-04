import { afterEach, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';

import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const store = new RedisBridgeStore(redis);
const incarnationId = 'incarnation-00000001';

afterEach(async () => {
  await redis.flushall();
});

test('dispatches a workspace tool only to a worker advertising its workspace and operation', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file'],
        workspaces: [{ id: 'primary', name: 'LibreChat' }],
      },
    },
  });
  const request = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'read_file' as const,
    workspaceId: 'primary',
    path: 'README.md',
  };
  const completion = store.dispatchWorkspaceTool({
    workerId: 'workspace-worker',
    tenantId: 'tenant-1',
    request,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });

  const assignment = await store.lease('workspace-worker', incarnationId, 1_000);
  expect(assignment).toMatchObject({
    executionKind: 'workspace_tool',
    request,
  });
  await store.settle('workspace-worker', assignment?.assignmentId ?? '', {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    generation: assignment?.generation ?? 0,
    leaseToken: assignment?.leaseToken ?? '',
    incarnationId,
    status: 'fulfilled',
    result: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
      content: '# LibreChat',
      startLine: 1,
      endLine: 1,
      truncated: false,
    },
  });

  await expect(completion).resolves.toMatchObject({
    status: 'fulfilled',
    result: { content: '# LibreChat' },
  });
});

test('rejects a workspace tool that the selected worker did not advertise', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file'],
        workspaces: [{ id: 'primary' }],
      },
    },
  });

  await expect(
    store.dispatchWorkspaceTool({
      workerId: 'workspace-worker',
      request: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operation: 'search_text',
        workspaceId: 'primary',
        query: 'needle',
      },
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await redis.keys('codeapi:bridge:v1:assignment:*')).toHaveLength(0);
});

test('rejects an operation omitted from the selected workspace capability', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file', 'write_file'],
        workspaces: [
          { id: 'readonly', operations: ['read_file'] },
          { id: 'writable', operations: ['read_file', 'write_file'] },
        ],
      },
    },
  });

  await expect(
    store.dispatchWorkspaceTool({
      workerId: 'workspace-worker',
      request: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operation: 'write_file',
        workspaceId: 'readonly',
        path: 'notes.txt',
        content: 'blocked',
      },
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await redis.keys('codeapi:bridge:v1:assignment:*')).toHaveLength(0);
});

test('rejects create-only writes from workers without the negotiated mode', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['write_file'],
        workspaces: [{ id: 'primary' }],
      },
    },
  });

  await expect(
    store.dispatchWorkspaceTool({
      workerId: 'workspace-worker',
      request: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        content: 'create me',
        overwrite: false,
      },
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await redis.keys('codeapi:bridge:v1:assignment:*')).toHaveLength(0);
});

test('rejects batch edits from workers without the negotiated mode', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['edit_file'],
        workspaces: [{ id: 'primary' }],
      },
    },
  });

  await expect(
    store.dispatchWorkspaceTool({
      workerId: 'workspace-worker',
      request: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
  expect(await redis.keys('codeapi:bridge:v1:assignment:*')).toHaveLength(0);
});

test('rejects a fulfilled workspace settlement that violates the result contract', async () => {
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'workspace-worker',
    incarnationId,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
      workspaceTools: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        operations: ['read_file'],
        workspaces: [{ id: 'primary' }],
      },
    },
  });
  const completion = store.dispatchWorkspaceTool({
    workerId: 'workspace-worker',
    request: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
    },
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const assignment = await store.lease('workspace-worker', incarnationId, 1_000);
  await store.settle('workspace-worker', assignment?.assignmentId ?? '', {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    generation: assignment?.generation ?? 0,
    leaseToken: assignment?.leaseToken ?? '',
    incarnationId,
    status: 'fulfilled',
    result: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'README.md',
      content: 'safe',
      startLine: 1,
      endLine: 1,
      truncated: false,
      root: '/Users/operator/private',
    } as never,
  });

  await expect(completion).rejects.toMatchObject({
    code: 'RESULT_INVALID',
  });
});
