import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBridgeIdentity,
  signBridgeRequest,
  verifyBridgeRequest,
} from './identity.js';

test('worker identity proves possession for the exact HTTP request', () => {
  const identity = createBridgeIdentity();
  const request = {
    credential: 'short-lived-credential',
    method: 'POST',
    path: '/v1/bridge/workers/vm-1/lease',
    timestamp: new Date().toISOString(),
    nonce: 'single-use-request-nonce',
    body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
  };

  const signature = signBridgeRequest(identity.privateKey, request);

  assert.equal(
    verifyBridgeRequest(identity.publicKey, request, signature),
    true,
  );
  assert.equal(
    verifyBridgeRequest(
      identity.publicKey,
      { ...request, body: JSON.stringify({ protocolVersion: 1, waitMs: 0 }) },
      signature,
    ),
    false,
  );
});
