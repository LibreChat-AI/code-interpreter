import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createBridgeIdentity,
  signBridgeRecovery,
  signBridgeRecoveryStart,
  signBridgeRequest,
  verifyBridgeRecovery,
  verifyBridgeRecoveryStart,
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

test('signed recovery starts bind operation, server, worker, time and nonce', () => {
  const identity = createBridgeIdentity();
  const start = {
    operation: 'credential.challenge' as const,
    serverId: 'https://code.example.test',
    workerId: 'vm-1',
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
  };
  const signature = signBridgeRecoveryStart(identity.privateKey, start);
  assert.equal(verifyBridgeRecoveryStart(identity.publicKey, start, signature), true);
  for (const modified of [
    { ...start, operation: 'credential.recover' as 'credential.challenge' },
    { ...start, serverId: 'https://other.example.test' },
    { ...start, workerId: 'vm-2' },
    { ...start, timestamp: new Date(Date.now() + 60_000).toISOString() },
    { ...start, nonce: randomBytes(32).toString('base64url') },
  ]) {
    assert.equal(verifyBridgeRecoveryStart(identity.publicKey, modified, signature), false);
  }

  const challenge = {
    operation: 'credential.recover' as const,
    serverId: start.serverId,
    workerId: start.workerId,
    enrollmentGeneration: randomBytes(18).toString('base64url'),
    challenge: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal(verifyBridgeRecovery(identity.publicKey, challenge, signature), false);
  assert.equal(
    verifyBridgeRecoveryStart(
      identity.publicKey, start, signBridgeRecovery(identity.privateKey, challenge),
    ),
    false,
  );
});
