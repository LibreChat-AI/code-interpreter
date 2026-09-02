import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeWorkerPath,
  isValidBridgeWorkerCapabilities,
  isValidBridgeWorkerId,
  isWorkspaceToolRequest,
  isWorkspaceToolResult,
} from './protocol.js';

test('bridgeWorkerPath encodes worker-controlled path segments', () => {
  assert.equal(
    bridgeWorkerPath('vm/example worker'),
    '/bridge/workers/vm%2Fexample%20worker',
  );
});

test('bridge worker IDs reject path, whitespace, and oversized values', () => {
  assert.equal(isValidBridgeWorkerId('engineering-vm:1'), true);
  assert.equal(isValidBridgeWorkerId('engineering/vm'), false);
  assert.equal(isValidBridgeWorkerId('engineering vm'), false);
  assert.equal(isValidBridgeWorkerId('a'.repeat(129)), false);
});

test('bridge worker capabilities enforce registration limits', () => {
  const valid = {
    statefulWorkspace: true,
    sandboxProfile: 'nsjail',
    runtimes: ['bash'],
    policyDigest: 'a'.repeat(64),
  };
  assert.equal(isValidBridgeWorkerCapabilities(valid), true);
  assert.equal(
    isValidBridgeWorkerCapabilities({ ...valid, sandboxProfile: '' }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      sandboxProfile: 'a'.repeat(129),
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      runtimes: Array.from({ length: 33 }, () => 'bash'),
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      runtimes: ['a'.repeat(65)],
    }),
    false,
  );
});

test('bridge worker capabilities accept only bounded public workspace descriptors', () => {
  const valid = {
    statefulWorkspace: true,
    sandboxProfile: 'nsjail',
    runtimes: ['bash'],
    workspaceTools: {
      protocolVersion: 1,
      operations: ['read_file', 'search_text'],
      workspaces: [{ id: 'primary', name: 'LibreChat' }],
    },
  };

  assert.equal(isValidBridgeWorkerCapabilities(valid), true);
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        workspaces: [{ id: 'primary', root: '/Users/operator/private' }],
      },
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        workspaces: [{ id: '../escape' }],
      },
    }),
    false,
  );
});

test('workspace file listing accepts only bounded portable requests and results', () => {
  const request = {
    protocolVersion: 1 as const,
    operation: 'list_files' as const,
    workspaceId: 'primary',
    path: 'src',
    maxResults: 20,
  };
  assert.equal(isWorkspaceToolRequest(request), true);
  assert.equal(
    isWorkspaceToolRequest({ ...request, path: '../outside' }),
    false,
  );
  assert.equal(isWorkspaceToolRequest({ ...request, maxResults: 501 }), false);

  const result = {
    protocolVersion: 1 as const,
    operation: 'list_files' as const,
    workspaceId: 'primary',
    paths: ['src/app.ts', 'src/worker.ts'],
    truncated: false,
  };
  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      paths: ['/Users/operator/private'],
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, { ...result, paths: ['outside.txt'] }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      paths: ['src/app.ts', 'src/app.ts'],
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      root: '/private/workspace',
    }),
    false,
  );
});
