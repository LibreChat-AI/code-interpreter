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

test('pairing propagates cancellation and never follows a code-bearing redirect', async () => {
  const controller = new AbortController();
  const paired = await pairBridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    code: 'one-time-code',
    signal: controller.signal,
    fetchImpl: async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.signal, controller.signal);
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'issued-short-lived-credential-value',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    },
  });
  assert.equal(paired.workerId, 'vm-1');
});

for (const payload of [
  null,
  [],
  'not a response',
  { protocolVersion: 2 },
  { protocolVersion: 1, workerId: 'another-worker' },
]) {
  test(`pairing rejects malformed response ${JSON.stringify(payload)}`, async () => {
    await assert.rejects(
      pairBridgeWorker({
        codeApiUrl: 'https://code.example/v1',
        workerId: 'vm-1',
        code: 'one-time-code',
        fetchImpl: async () => Response.json(payload),
      }),
      /invalid/,
    );
  });
}

test('non-JSON pairing failures have a bounded diagnosis without echoing response contents', async () => {
  await assert.rejects(
    pairBridgeWorker({
      codeApiUrl: 'https://code.example/v1',
      workerId: 'vm-1',
      code: 'one-time-code',
      fetchImpl: async () =>
        new Response('private upstream response', { status: 502 }),
    }),
    error => {
      assert.match(String(error), /invalid pairing response/);
      assert.ok(!String(error).includes('private upstream response'));
      return true;
    },
  );
});
