import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { recoverWorkerCredential } from './credential-recovery.js';
import {
  createBridgeIdentity,
  verifyBridgeRecovery,
  verifyBridgeRecoveryStart,
  verifyBridgeRequest,
} from './identity.js';
import { BridgeProtocolError } from './protocol.js';
import { BridgeWorker } from './worker.js';
import type { BridgeWorkerOptions } from './worker.js';

const workerId = 'recovery:vm';
const codeApiUrl = 'https://code.example/proxy/v1';
const incarnationId = 'worker-recovery-incarnation';
const oldCredential = 'expired-short-lived-credential-value';
const newCredential = 'recovered-short-lived-credential-value';
const capabilities = {
  statefulWorkspace: false,
  sandboxProfile: 'nsjail',
  runtimes: ['bash'],
};

function challenge() {
  return {
    protocolVersion: 1 as const,
    operation: 'credential.recover' as const,
    serverId: 'https://code.example',
    workerId,
    enrollmentGeneration: randomBytes(18).toString('base64url'),
    challenge: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function credential() {
  return {
    protocolVersion: 1 as const,
    workerId,
    credential: newCredential,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

function identity() {
  return {
    ...createBridgeIdentity(),
    credential: oldCredential,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

function workerOptions(
  overrides: Partial<BridgeWorkerOptions> = {},
): BridgeWorkerOptions {
  return {
    codeApiUrl,
    workerId,
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: identity(),
    capabilities,
    ...overrides,
  };
}

function expired() {
  return Response.json(
    {
      code: 'CREDENTIAL_INVALID',
      error: 'Worker credential is invalid or expired',
    },
    { status: 401 },
  );
}

test('startup recovers the enrolled key and persists before registering with the new credential', async () => {
  const key = identity();
  const recovered = credential();
  const issued = challenge();
  const requests: string[] = [];
  let persisted = false;
  const controller = new AbortController();
  const worker = new BridgeWorker(
    workerOptions({
      identity: key,
      onIdentityChange: next => {
        assert.equal(key.credential, oldCredential);
        assert.equal(next.privateKey, key.privateKey);
        assert.equal(next.credential, newCredential);
        persisted = true;
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body));
        requests.push(url);
        if (url.endsWith('/refresh')) return expired();
        if (url.endsWith('/challenge') || url.endsWith('/recover')) {
          assert.equal(
            (init?.headers as Record<string, string>).Authorization,
            undefined,
          );
          assert.equal(init?.redirect, 'error');
          assert.ok(!String(init?.body).includes(key.privateKey));
          assert.ok(!String(init?.body).includes(oldCredential));
          assert.match(
            url,
            /\/proxy\/v1\/bridge\/workers\/recovery%3Avm\/credentials\//,
          );
        }
        if (url.endsWith('/challenge')) {
          assert.equal(body.serverId, 'https://code.example');
          assert.equal(body.operation, 'credential.challenge');
          assert.equal(body.workerId, workerId);
          assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
          assert.equal(
            verifyBridgeRecoveryStart(key.publicKey, body, body.signature),
            true,
          );
          return Response.json(issued);
        }
        if (url.endsWith('/recover')) {
          assert.equal(
            verifyBridgeRecovery(key.publicKey, body, body.signature),
            true,
          );
          assert.deepEqual(
            { ...body, signature: undefined },
            { ...issued, signature: undefined },
          );
          return Response.json(recovered);
        }
        assert.equal(persisted, true);
        const headers = init!.headers as Record<string, string>;
        assert.equal(headers.Authorization, `Bridge ${newCredential}`);
        assert.equal(
          verifyBridgeRequest(
            key.publicKey,
            {
              credential: newCredential,
              method: 'POST',
              path: new URL(url).pathname,
              timestamp: headers['X-LibreChat-Code-Timestamp'],
              nonce: headers['X-LibreChat-Code-Nonce'],
              body: String(init!.body),
            },
            headers['X-LibreChat-Code-Signature'],
          ),
          true,
        );
        if (url.endsWith('/register'))
          return Response.json({
            protocolVersion: 1,
            workerId,
            incarnationId,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
          });
        controller.abort();
        return Response.json({ protocolVersion: 1, serverElapsedMs: 0 });
      },
    }),
  );
  await worker.run(controller.signal);
  assert.equal(key.credential, newCredential);
  assert.equal(requests.filter(url => url.endsWith('/challenge')).length, 1);
  assert.equal(requests.filter(url => url.endsWith('/recover')).length, 1);
  assert.ok(
    !requests.some(
      url =>
        url.includes('pairing') ||
        url.includes('reset') ||
        url.includes('revoke'),
    ),
  );
});

test('ordinary successful refresh does not probe recovery and static workers do not recover', async () => {
  let calls = 0;
  const worker = new BridgeWorker(
    workerOptions({
      fetchImpl: async input => {
        assert.ok(String(input).endsWith('/refresh'));
        calls++;
        return Response.json(credential());
      },
    }),
  );
  await worker.refreshCredential();
  assert.equal(calls, 1);
  const staticWorker = new BridgeWorker(
    workerOptions({
      identity: undefined,
      token: 'legacy',
      fetchImpl: async () => {
        assert.fail('static worker has no credential refresh');
      },
    }),
  );
  await staticWorker.refreshCredential();
});

for (const [status, code] of [
  [401, undefined],
  [401, 'PROOF_INVALID'],
  [401, 'PROOF_REPLAYED'],
  [403, 'CREDENTIAL_INVALID'],
  [409, 'WORKER_FENCED'],
  [429, 'RECOVERY_RATE_LIMITED'],
  [503, undefined],
] as const) {
  test(`refresh failure ${status}/${code} never triggers recovery`, async () => {
    let calls = 0;
    const worker = new BridgeWorker(
      workerOptions({
        fetchImpl: async input => {
          calls++;
          assert.ok(String(input).endsWith('/refresh'));
          return Response.json({ code }, { status });
        },
      }),
    );
    await assert.rejects(
      worker.refreshCredential(),
      error => error instanceof BridgeProtocolError && error.status === status,
    );
    assert.equal(calls, 1);
  });
}

test('active workers never bootstrap recovery after registration', async () => {
  const key = identity();
  let recoveries = 0;
  const worker = new BridgeWorker(
    workerOptions({
      identity: key,
      fetchImpl: async input => {
        const url = String(input);
        if (url.endsWith('/register'))
          return Response.json({
            protocolVersion: 1,
            workerId,
            incarnationId,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
          });
        if (!url.endsWith('/refresh')) recoveries++;
        return expired();
      },
    }),
  );
  await worker.register();
  await assert.rejects(worker.refreshCredential(), {
    status: 401,
    code: 'CREDENTIAL_INVALID',
  });
  assert.equal(recoveries, 0);
});

for (const status of [404, 405, 401, 403, 429, 503]) {
  test(`recovery failure ${status} preserves enrollment, key and old local credential`, async () => {
    const key = identity();
    const original = { ...key };
    let persisted = false;
    const worker = new BridgeWorker(
      workerOptions({
        identity: key,
        onIdentityChange: () => {
          persisted = true;
        },
        fetchImpl: async input => {
          if (String(input).endsWith('/refresh')) return expired();
          assert.ok(String(input).endsWith('/challenge'));
          return status === 404
            ? new Response('upstream secret', { status })
            : Response.json(
                { code: status === 401 ? 'ENROLLMENT_INVALID' : undefined },
                { status },
              );
        },
      }),
    );
    await assert.rejects(worker.refreshCredential(), error => {
      assert.ok(error instanceof BridgeProtocolError);
      assert.equal(
        error.status,
        status === 404 || status === 405 ? 401 : status,
      );
      assert.ok(!error.message.includes('upstream secret'));
      if (status === 401)
        assert.match(error.message, /revoked.*pairing|pairing.*revoked/i);
      if (status === 404)
        assert.match(
          error.message,
          /enable durable enrollment or approve a new pairing/,
        );
      return true;
    });
    assert.deepEqual(key, original);
    assert.equal(persisted, false);
  });
}

for (const codeApiUrl of [
  'http://code.example/v1',
  'https://user:password@code.example/v1',
  'https://code.example/v1?token=secret',
  'https://code.example/v1#fragment',
]) {
  test('recovery refuses unsafe server context without disclosing identity', async () => {
    await assert.rejects(
      recoverWorkerCredential({
        codeApiUrl,
        workerId,
        privateKey: identity().privateKey,
        validThroughMs: Date.now(),
        signal: AbortSignal.timeout(1000),
        fetchImpl: async () => {
          assert.fail('must not fetch');
        },
      }),
      { code: 'RECOVERY_UNAVAILABLE', status: 401 },
    );
  });
}

const badChallenges: Array<
  [string, (value: ReturnType<typeof challenge>) => unknown]
> = [
  ['null', () => null],
  ['array', () => []],
  ['wrong version', value => ({ ...value, protocolVersion: 2 })],
  [
    'wrong operation',
    value => ({ ...value, operation: 'credential.challenge' }),
  ],
  ['other server', value => ({ ...value, serverId: 'https://other.example' })],
  ['other machine', value => ({ ...value, workerId: 'other-worker' })],
  ['bad generation', value => ({ ...value, enrollmentGeneration: 'short' })],
  ['bad challenge', value => ({ ...value, challenge: 'short' })],
  [
    'expired',
    value => ({ ...value, expiresAt: new Date(Date.now() - 1).toISOString() }),
  ],
  [
    'unbounded lifetime',
    value => ({ ...value, expiresAt: '2099-01-01T00:00:00Z' }),
  ],
  ['invalid date', value => ({ ...value, expiresAt: 'not a date' })],
];
for (const [name, alter] of badChallenges) {
  test(`recovery refuses ${name} challenge before signing completion`, async () => {
    let calls = 0;
    await assert.rejects(
      recoverWorkerCredential({
        codeApiUrl,
        workerId,
        privateKey: identity().privateKey,
        validThroughMs: Date.now(),
        signal: AbortSignal.timeout(1000),
        fetchImpl: async () => {
          calls++;
          return Response.json(alter(challenge()));
        },
      }),
      /invalid machine recovery challenge/,
    );
    assert.equal(calls, 1);
  });
}

for (const value of [
  null,
  [],
  { ...credential(), workerId: 'another-worker' },
  { ...credential(), credential: 'short' },
  { ...credential(), credential: 'x'.repeat(4097) },
  { ...credential(), expiresAt: 'bad' },
  { ...credential(), expiresAt: new Date(0).toISOString() },
]) {
  test('invalid recovered credentials are never adopted or persisted', async () => {
    const key = identity();
    const worker = new BridgeWorker(
      workerOptions({
        identity: key,
        onIdentityChange: () => {
          assert.fail('must not persist');
        },
        fetchImpl: async input => {
          if (String(input).endsWith('/refresh')) return expired();
          if (String(input).endsWith('/challenge'))
            return Response.json(challenge());
          return Response.json(value);
        },
      }),
    );
    await assert.rejects(
      worker.refreshCredential(),
      /invalid recovered worker credential/,
    );
    assert.equal(key.credential, oldCredential);
  });
}

test('oversized and non-JSON recovery responses have bounded, sanitized failures', async () => {
  for (const source of ['sensitive upstream contents', 'x'.repeat(8193)]) {
    await assert.rejects(
      recoverWorkerCredential({
        codeApiUrl,
        workerId,
        privateKey: identity().privateKey,
        validThroughMs: Date.now(),
        signal: AbortSignal.timeout(1000),
        fetchImpl: async () => new Response(source),
      }),
      error => {
        assert.ok(!String(error).includes('sensitive upstream contents'));
        assert.match(
          String(error),
          /invalid machine recovery response|exceeds 8 KiB/,
        );
        return true;
      },
    );
  }
});

test('failed persistence never adopts a recovered credential; retry proves the same key with a new nonce', async () => {
  const key = identity();
  const nonces = new Set<string>();
  let attempts = 0;
  const worker = new BridgeWorker(
    workerOptions({
      identity: key,
      onIdentityChange: () => {
        if (++attempts === 1) throw new Error('disk unavailable');
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/refresh')) return expired();
        if (String(input).endsWith('/challenge')) {
          const body = JSON.parse(String(init?.body));
          assert.equal(nonces.has(body.nonce), false);
          nonces.add(body.nonce);
          assert.equal(
            verifyBridgeRecoveryStart(key.publicKey, body, body.signature),
            true,
          );
          return Response.json(challenge());
        }
        return Response.json(credential());
      },
    }),
  );
  await assert.rejects(worker.refreshCredential(), /disk unavailable/);
  assert.equal(key.credential, oldCredential);
  await worker.refreshCredential();
  assert.equal(key.credential, newCredential);
  assert.equal(attempts, 2);
  assert.equal(nonces.size, 2);
});

test('concurrent callers share recovery and one cancellation cannot abort another waiter', async () => {
  let release!: () => void;
  let notify!: () => void;
  const started = new Promise<void>(resolve => {
    notify = resolve;
  });
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = new AbortController();
  let challenges = 0;
  let aborted = false;
  const worker = new BridgeWorker(
    workerOptions({
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/refresh')) return expired();
        if (String(input).endsWith('/challenge')) {
          challenges++;
          return Response.json(challenge());
        }
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
        });
        notify();
        await ready;
        return Response.json(credential());
      },
    }),
  );
  const firstRefresh = worker.refreshCredential(first.signal);
  await started;
  const secondRefresh = worker.refreshCredential();
  first.abort();
  await assert.rejects(firstRefresh, { name: 'AbortError' });
  assert.equal(aborted, false);
  release();
  await secondRefresh;
  assert.equal(challenges, 1);
  assert.equal(aborted, false);
});

test('last waiter cancellation aborts recovery without persisting or registering', async () => {
  const controller = new AbortController();
  let notify!: () => void;
  const started = new Promise<void>(resolve => {
    notify = resolve;
  });
  let transportAborted = false;
  const worker = new BridgeWorker(
    workerOptions({
      onIdentityChange: () => {
        assert.fail('must not persist');
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/refresh')) return expired();
        assert.ok(String(input).endsWith('/challenge'));
        notify();
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener(
            'abort',
            () => {
              transportAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          ),
        );
      },
    }),
  );
  const pending = worker.refreshCredential(controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(transportAborted, true);
});

test('challenge and recovery share the remaining credential-refresh deadline', async () => {
  let challengeSignal: AbortSignal | null | undefined;
  const worker = new BridgeWorker(
    workerOptions({
      credentialRefreshTransportTimeoutMs: 100,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/refresh')) return expired();
        if (String(input).endsWith('/challenge')) {
          challengeSignal = init?.signal;
          return Response.json(challenge());
        }
        assert.equal(init?.signal, challengeSignal);
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        );
      },
    }),
  );
  // Keep the event loop alive because AbortSignal.timeout timers are unref'ed.
  const timer = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(worker.refreshCredential(), { name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(challengeSignal?.aborted, true);
});

test('revoked enrollment terminates startup instead of retrying or issuing a pairing', async () => {
  let calls = 0;
  const worker = new BridgeWorker(
    workerOptions({
      onError: () => {
        assert.fail('terminal auth failure must not reconnect');
      },
      fetchImpl: async input => {
        calls++;
        if (String(input).endsWith('/refresh')) return expired();
        assert.ok(String(input).endsWith('/challenge'));
        return Response.json({ code: 'ENROLLMENT_INVALID' }, { status: 401 });
      },
    }),
  );
  await assert.rejects(worker.run(), {
    status: 401,
    code: 'ENROLLMENT_INVALID',
  });
  assert.equal(calls, 2);
});

test('recovery retries transient startup failure without replacing the enrolled key', async () => {
  let challenges = 0;
  let failures = 0;
  const key = identity();
  const controller = new AbortController();
  const worker = new BridgeWorker(
    workerOptions({
      identity: key,
      reconnectDelayMs: 1,
      reconnectMaxDelayMs: 1,
      onError: error => {
        assert.ok(error instanceof BridgeProtocolError);
        assert.equal(error.status, 503);
        failures++;
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/refresh')) return expired();
        if (url.endsWith('/challenge')) {
          const body = JSON.parse(String(init?.body));
          assert.equal(
            verifyBridgeRecoveryStart(key.publicKey, body, body.signature),
            true,
          );
          return ++challenges === 1
            ? Response.json({}, { status: 503 })
            : Response.json(challenge());
        }
        if (url.endsWith('/recover')) return Response.json(credential());
        if (url.endsWith('/register'))
          return Response.json({
            protocolVersion: 1,
            workerId,
            incarnationId,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
          });
        controller.abort();
        return Response.json({ protocolVersion: 1, serverElapsedMs: 0 });
      },
    }),
  );
  await worker.run(controller.signal);
  assert.equal(challenges, 2);
  assert.equal(failures, 1);
  assert.equal(key.credential, newCredential);
});

test('revocation between challenge and completion cannot restore access', async () => {
  let persisted = false;
  const worker = new BridgeWorker(
    workerOptions({
      onIdentityChange: () => {
        persisted = true;
      },
      fetchImpl: async input => {
        if (String(input).endsWith('/refresh')) return expired();
        if (String(input).endsWith('/challenge'))
          return Response.json(challenge());
        assert.ok(String(input).endsWith('/recover'));
        return Response.json({ code: 'ENROLLMENT_INVALID' }, { status: 401 });
      },
    }),
  );
  await assert.rejects(worker.run(), {
    code: 'ENROLLMENT_INVALID',
    status: 401,
  });
  assert.equal(persisted, false);
});

test('successful credential recovery never clears an existing workspace quarantine', async () => {
  let checks = 0;
  const worker = new BridgeWorker(
    workerOptions({
      workspaceMutationQuarantine: {
        assertAvailable: async () => {
          checks++;
          throw new BridgeProtocolError(
            'Workspace requires inspection',
            409,
            'WORKER_QUARANTINED',
          );
        },
        arm: async () => {
          assert.fail('must not arm');
        },
        clear: async () => {
          assert.fail('must not clear');
        },
        quarantine: async () => {
          assert.fail('must not change quarantine');
        },
      },
      fetchImpl: async input => {
        if (String(input).endsWith('/refresh')) return expired();
        if (String(input).endsWith('/challenge'))
          return Response.json(challenge());
        assert.ok(String(input).endsWith('/recover'));
        return Response.json(credential());
      },
    }),
  );
  await assert.rejects(worker.run(), { code: 'WORKER_QUARANTINED' });
  assert.equal(checks, 1);
});
