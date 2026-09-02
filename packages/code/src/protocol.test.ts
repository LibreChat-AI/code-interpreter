import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeWorkerPath,
  isValidBridgeWorkerCapabilities,
  isValidBridgeWorkerId,
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
