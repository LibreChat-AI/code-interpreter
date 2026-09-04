import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeWorkerPath,
  comparePortableRelativePaths,
  isValidBridgeWorkerCapabilities,
  isValidBridgeWorkerId,
  isWorkspaceToolRequest,
  isWorkspaceToolResult,
} from './protocol.js';
import type {
  WorkspaceEditFileRequest,
  WorkspacePreviewEditRequest,
} from './protocol.js';

const validSingleEditRequest: WorkspaceEditFileRequest = {
  protocolVersion: 1,
  operation: 'edit_file',
  workspaceId: 'primary',
  path: 'notes.txt',
  oldText: 'before',
  newText: 'after',
};
const validBatchEditRequest: WorkspaceEditFileRequest = {
  protocolVersion: 1,
  operation: 'edit_file',
  workspaceId: 'primary',
  path: 'notes.txt',
  edits: [{ oldText: 'before', newText: 'after' }],
};
// @ts-expect-error An edit request must choose a complete single or batch form.
const invalidEmptyEditRequest: WorkspaceEditFileRequest = {
  protocolVersion: 1,
  operation: 'edit_file',
  workspaceId: 'primary',
  path: 'notes.txt',
};
// @ts-expect-error Single and batch edit forms are mutually exclusive.
const invalidMixedEditRequest: WorkspaceEditFileRequest = {
  ...validSingleEditRequest,
  edits: validBatchEditRequest.edits,
};
void invalidEmptyEditRequest;
void invalidMixedEditRequest;

// @ts-expect-error A preview request must choose a complete single or batch form.
const invalidEmptyPreviewRequest: WorkspacePreviewEditRequest = {
  protocolVersion: 1,
  operation: 'preview_edit',
  workspaceId: 'primary',
  path: 'notes.txt',
};
// @ts-expect-error Single and batch preview forms are mutually exclusive.
const invalidMixedPreviewRequest: WorkspacePreviewEditRequest = {
  protocolVersion: 1,
  operation: 'preview_edit',
  workspaceId: 'primary',
  path: 'notes.txt',
  oldText: 'before',
  newText: 'after',
  edits: [{ oldText: 'before', newText: 'after' }],
};
void invalidEmptyPreviewRequest;
void invalidMixedPreviewRequest;

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
        operations: ['read_file', 'write_file'],
        writeFileModes: ['replace', 'create'],
      },
    }),
    true,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        operations: ['read_file', 'preview_edit'],
        editFileModes: ['single', 'batch'],
      },
    }),
    true,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        operations: ['read_file', 'edit_file'],
        editFileModes: ['single', 'batch'],
        editFileFeatures: ['expected_base_sha256'],
      },
    }),
    true,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        editFileFeatures: ['expected_base_sha256'],
      },
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        operations: ['read_file', 'list_files'],
        listFileFeatures: ['after_path'],
      },
    }),
    true,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        listFileFeatures: ['after_path'],
      },
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        editFileModes: ['batch'],
      },
    }),
    false,
  );
  assert.equal(
    isValidBridgeWorkerCapabilities({
      ...valid,
      workspaceTools: {
        ...valid.workspaceTools,
        writeFileModes: ['create'],
      },
    }),
    false,
  );
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
    afterPath: 'src/app.ts',
  };
  assert.equal(isWorkspaceToolRequest(request), true);
  assert.equal(
    isWorkspaceToolRequest({ ...request, path: '../outside' }),
    false,
  );
  assert.equal(isWorkspaceToolRequest({ ...request, maxResults: 501 }), false);
  assert.equal(
    isWorkspaceToolRequest({ ...request, afterPath: 'outside/app.ts' }),
    false,
  );

  const result = {
    protocolVersion: 1 as const,
    operation: 'list_files' as const,
    workspaceId: 'primary',
    paths: ['src/worker.ts', 'src/z.ts'],
    truncated: true,
    nextAfterPath: 'src/z.ts',
  };
  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      paths: ['src/\uE000.ts', 'src/\u{10000}.ts'],
      truncated: false,
      nextAfterPath: undefined,
    }),
    true,
  );
  assert.equal(
    isWorkspaceToolResult(request, { ...result, nextAfterPath: 'src/worker.ts' }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      paths: ['src/z.ts', 'src/worker.ts'],
      nextAfterPath: 'src/worker.ts',
    }),
    false,
  );
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
      paths: ['src//worker.ts'],
      nextAfterPath: 'src//worker.ts',
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

test('workspace path ordering matches sorted depth-first traversal', () => {
  assert.ok(comparePortableRelativePaths('src/app.ts', 'src.ts') < 0);
  assert.ok(comparePortableRelativePaths('src/app.ts', 'src/worker.ts') < 0);
  assert.ok(comparePortableRelativePaths('src.ts', 'src/app.ts') > 0);
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
  const batchEditRequest = {
    protocolVersion: 1 as const,
    operation: 'edit_file' as const,
    workspaceId: 'primary',
    path: 'notes.txt',
    edits: [
      { oldText: 'hello', newText: 'goodbye' },
      { oldText: 'world', newText: 'BYOM' },
    ],
  };
  assert.equal(isWorkspaceToolRequest(batchEditRequest), true);
  assert.equal(
    isWorkspaceToolRequest({ ...batchEditRequest, oldText: 'mixed' }),
    false,
  );
  assert.equal(isWorkspaceToolRequest({ ...batchEditRequest, edits: [] }), false);
  assert.equal(
    isWorkspaceToolRequest({
      ...batchEditRequest,
      edits: Array.from({ length: 101 }, () => ({ oldText: 'a', newText: 'b' })),
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolRequest({
      ...batchEditRequest,
      edits: [{ oldText: 'a'.repeat(600_000), newText: 'b'.repeat(600_000) }],
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(batchEditRequest, {
      protocolVersion: 1,
      operation: 'edit_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      replacements: 2,
      bytesWritten: 12,
    }),
    true,
  );
  const previewRequest = {
    ...batchEditRequest,
    operation: 'preview_edit' as const,
  };
  assert.equal(isWorkspaceToolRequest(previewRequest), true);
  assert.equal(
    isWorkspaceToolResult(previewRequest, {
      protocolVersion: 1,
      operation: 'preview_edit',
      workspaceId: 'primary',
      path: 'notes.txt',
      content: 'goodbye BYOM',
      hasUtf8Bom: false,
      baseSha256: 'a'.repeat(64),
      replacements: 2,
      bytesWritten: 12,
    }),
    true,
  );
  assert.equal(
    isWorkspaceToolRequest({
      ...editRequest,
      expectedBaseSha256: 'b'.repeat(64),
    }),
    true,
  );
  assert.equal(
    isWorkspaceToolRequest({
      ...editRequest,
      expectedBaseSha256: 'not-a-sha',
    }),
    false,
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
