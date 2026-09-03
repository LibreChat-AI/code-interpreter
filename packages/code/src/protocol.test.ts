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
      paths: ['src/app.ts', 'src/./app.ts'],
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

test('workspace mutations accept bounded UTF-8 requests and exact result shapes', () => {
  const writeRequest = {
    protocolVersion: 1 as const,
    operation: 'write_file' as const,
    workspaceId: 'primary',
    path: 'notes.txt',
    content: 'hello',
    overwrite: false,
  };
  assert.equal(isWorkspaceToolRequest(writeRequest), true);
  assert.equal(
    isWorkspaceToolRequest({ ...writeRequest, overwrite: 'false' }),
    false,
  );
  assert.equal(
    isWorkspaceToolRequest({
      ...writeRequest,
      content: 'x'.repeat(1024 * 1024 + 1),
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(writeRequest, {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      created: true,
      bytesWritten: 5,
    }),
    true,
  );
  assert.equal(
    isWorkspaceToolResult(writeRequest, {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      created: false,
      bytesWritten: 5,
    }),
    false,
  );

  const editRequest = {
    protocolVersion: 1 as const,
    operation: 'edit_file' as const,
    workspaceId: 'primary',
    path: 'notes.txt',
    oldText: 'hello',
    newText: 'goodbye',
  };
  assert.equal(isWorkspaceToolRequest(editRequest), true);
  assert.equal(isWorkspaceToolRequest({ ...editRequest, oldText: '' }), false);
  assert.equal(
    isWorkspaceToolResult(editRequest, {
      protocolVersion: 1,
      operation: 'edit_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      replacements: 1,
      bytesWritten: 7,
    }),
    true,
  );
});

test('workspace commands require bounded sandbox inputs and outputs', () => {
  const request = {
    protocolVersion: 1 as const,
    operation: 'execute_command' as const,
    workspaceId: 'primary',
    command: 'npm test',
    cwd: 'packages/code',
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
  };
  assert.equal(isWorkspaceToolRequest(request), true);
  assert.equal(isWorkspaceToolRequest({ ...request, command: '   ' }), false);
  assert.equal(
    isWorkspaceToolRequest({ ...request, command: `echo\0secret` }),
    false,
  );
  assert.equal(
    isWorkspaceToolRequest({ ...request, cwd: '../outside' }),
    false,
  );
  assert.equal(
    isWorkspaceToolRequest({ ...request, timeoutMs: 300_001 }),
    false,
  );
  assert.equal(
    isWorkspaceToolRequest({ ...request, maxOutputBytes: 1024 * 1024 + 1 }),
    false,
  );

  const result = {
    protocolVersion: 1 as const,
    operation: 'execute_command' as const,
    workspaceId: 'primary',
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    truncated: false,
    timedOut: false,
  };
  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      stdout: 'x'.repeat(1025),
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      exitCode: null,
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      exitCode: null,
      timedOut: true,
    }),
    true,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      hostCwd: '/Users/operator/project',
    }),
    false,
  );
});

test('workspace capabilities allow per-workspace operation restrictions', () => {
  const capabilities = {
    statefulWorkspace: true,
    sandboxProfile: 'nsjail',
    runtimes: ['bash'],
    workspaceTools: {
      protocolVersion: 1,
      operations: ['read_file', 'write_file'],
      workspaces: [
        { id: 'readonly', operations: ['read_file'] },
        { id: 'writable', operations: ['read_file', 'write_file'] },
      ],
    },
  };
  assert.equal(isValidBridgeWorkerCapabilities(capabilities), true);
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...capabilities,
      workspaceTools: {
        ...capabilities.workspaceTools,
        workspaces: [{ id: 'invalid', operations: ['edit_file'] }],
      },
    }),
    false,
  );
});
