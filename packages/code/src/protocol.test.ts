import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeWorkerPath } from './protocol.js';

test('bridgeWorkerPath encodes worker-controlled path segments', () => {
  assert.equal(
    bridgeWorkerPath('vm/example worker'),
    '/bridge/workers/vm%2Fexample%20worker',
  );
});
