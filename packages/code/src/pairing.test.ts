import assert from 'node:assert/strict';
import test from 'node:test';

import { pairBridgeWorker } from './pairing.js';

test('pairing binds a generated worker key to a single-use code', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      workerId: string;
      code: string;
      publicKey: string;
    };
    assert.equal(body.workerId, 'vm-1');
    assert.equal(body.code, 'one-time-code');
    assert.match(body.publicKey, /BEGIN PUBLIC KEY/);
    return Response.json({
      protocolVersion: 1,
      workerId: body.workerId,
      credential: 'issued-short-lived-credential-value',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  };

  const paired = await pairBridgeWorker({
    codeApiUrl: 'https://code.example/v1/',
    workerId: 'vm-1',
    code: 'one-time-code',
    fetchImpl,
  });

  assert.equal(paired.workerId, 'vm-1');
  assert.equal(paired.codeApiUrl, 'https://code.example/v1');
  assert.equal(paired.credential, 'issued-short-lived-credential-value');
  assert.match(paired.publicKey, /BEGIN PUBLIC KEY/);
  assert.match(paired.privateKey, /BEGIN PRIVATE KEY/);
});
