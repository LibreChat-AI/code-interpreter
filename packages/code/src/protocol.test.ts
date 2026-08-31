import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeWorkerPath, isValidBridgeWorkerId } from './protocol.js';

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
