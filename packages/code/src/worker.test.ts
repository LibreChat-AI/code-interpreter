import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBridgeIdentity,
  verifyBridgeRequest,
} from './identity.js';
import { BridgeWorker, reconnectDelayMs } from './worker.js';

import type { BridgeAssignment } from './protocol.js';

const incarnationId = 'incarnation-00000001';

test('worker forwards a fenced assignment to the sandbox and settles the result', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/execute')) {
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ protocolVersion: 1, accepted: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1/',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2/',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });
  const assignment: BridgeAssignment = {
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 3,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    runtimeSessionId: 'rt-user-1',
    request: {
      body: { language: 'bash' },
      headers: { 'X-Execution-Manifest': 'signed' },
    },
  };

  await worker.executeAndSettle(assignment);

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    'http://127.0.0.1:2000/sessions/rt-user-1/api/v2/execute',
  );
  assert.equal(
    (requests[0].init?.headers as Record<string, string>)[
      'X-Runtime-Session-Id'
    ],
    'rt-user-1',
  );
  assert.match(requests[1].url, /assignments\/assignment-1\/settle$/);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    protocolVersion: 1,
    generation: 3,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    incarnationId,
    status: 'fulfilled',
    result: { session_id: 'run-1', files: [] },
  });
});

test('worker aborts sandbox execution at the absolute assignment deadline', async () => {
  let settlement: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/execute')) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    settlement = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ protocolVersion: 1, accepted: true });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-deadline',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 30).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(settlement?.status, 'rejected');
  assert.equal(settlement?.incarnationId, incarnationId);
});

test('worker continues after an expired assignment settlement conflict', async () => {
  const controller = new AbortController();
  let registrations = 0;
  let leases = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    reconnectDelayMs: 0,
    reconnectMaxDelayMs: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/workers/register')) {
        registrations += 1;
        if (registrations === 2) controller.abort();
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId,
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
        });
      }
      if (url.endsWith('/lease')) {
        leases += 1;
        return Response.json({
          protocolVersion: 1,
          assignment: leases === 1
            ? {
                protocolVersion: 1,
                assignmentId: 'assignment-expired',
                workerId: 'vm-1',
                incarnationId,
                generation: 1,
                leaseToken: 'lease-token-that-is-long-enough-for-testing',
                expiresAt: new Date(Date.now() + 10_000).toISOString(),
                request: { body: { language: 'bash' }, headers: {} },
              }
            : undefined,
        });
      }
      if (url.endsWith('/execute')) {
        return Response.json({ session_id: 'run-1', files: [] });
      }
      if (url.endsWith('/settle')) {
        return Response.json(
          { error: 'Bridge assignment has expired', code: 'ASSIGNMENT_EXPIRED' },
          { status: 409 },
        );
      }
      return Response.json({ cancelled: false });
    },
  });

  await worker.run(controller.signal);

  assert.equal(registrations, 2);
});

test('worker refreshes its registration during a long assignment', async () => {
  let registrations = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/workers/register')) {
      registrations += 1;
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 50,
      });
    }
    if (url.endsWith('/execute')) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return Response.json({ session_id: 'run-1', files: [] });
    }
    return Response.json({ protocolVersion: 1, accepted: true });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });
  await worker.register();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-heartbeat',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.ok(registrations >= 2);
});

test('paired worker proves possession on bridge requests', async () => {
  const key = createBridgeIdentity();
  let bridgeRequest: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    bridgeRequest = { url: String(input), init };
    return Response.json({
      protocolVersion: 1,
      workerId: 'vm-1',
      incarnationId,
      registeredAt: new Date().toISOString(),
      leaseTtlMs: 60_000,
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'issued-short-lived-credential-value',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.register();

  assert.ok(bridgeRequest);
  const headers = bridgeRequest.init?.headers as Record<string, string>;
  const body = String(bridgeRequest.init?.body);
  assert.equal(
    verifyBridgeRequest(
      key.publicKey,
      {
        credential: 'issued-short-lived-credential-value',
        method: 'POST',
        path: '/v1/bridge/workers/register',
        timestamp: headers['X-LibreChat-Code-Timestamp'],
        nonce: headers['X-LibreChat-Code-Nonce'],
        body,
      },
      headers['X-LibreChat-Code-Signature'],
    ),
    true,
  );
});

test('paired worker rotates an expiring credential before registration', async () => {
  const key = createBridgeIdentity();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let persistedCredential = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/credentials/refresh')) {
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'rotated-short-lived-credential-value',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return Response.json({
      protocolVersion: 1,
      workerId: 'vm-1',
      incarnationId,
      registeredAt: new Date().toISOString(),
      leaseTtlMs: 60_000,
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'original-short-lived-credential-value',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
    onIdentityChange: (identity) => {
      persistedCredential = identity.credential;
    },
  });

  await worker.refreshCredential();
  await worker.register();

  assert.equal(persistedCredential, 'rotated-short-lived-credential-value');
  assert.equal(
    (requests[1].init?.headers as Record<string, string>).Authorization,
    'Bridge rotated-short-lived-credential-value',
  );
});

test('paired worker retries persistence before adopting a rotated credential', async () => {
  const key = createBridgeIdentity();
  const identity = {
    privateKey: key.privateKey,
    credential: 'original-short-lived-credential-value',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  let persistenceAttempts = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async () =>
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'rotated-short-lived-credential-value',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    onIdentityChange: () => {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error('disk unavailable');
    },
  });

  await assert.rejects(worker.refreshCredential(), /disk unavailable/);
  assert.equal(identity.credential, 'original-short-lived-credential-value');
  await worker.refreshCredential();
  assert.equal(identity.credential, 'rotated-short-lived-credential-value');
  assert.equal(persistenceAttempts, 2);
});

test('paired worker refreshes before an assignment that outlives its credential', async () => {
  const key = createBridgeIdentity();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/credentials/refresh')) {
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'assignment-safe-rotated-credential-value',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    }
    if (url.endsWith('/execute')) {
      return Response.json({ session_id: 'run-long', files: [] });
    }
    return Response.json({ protocolVersion: 1, accepted: true });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-too-short-for-assignment',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-long',
    workerId: 'vm-1',
    incarnationId,
    generation: 4,
    leaseToken: 'assignment-long-lease-token-value',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.match(requests[0], /credentials\/refresh$/);
  assert.equal(requests[1], 'http://127.0.0.1:2000/api/v2/execute');
});

test('worker shutdown interrupts reconnect backoff', async () => {
  const controller = new AbortController();
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async () => {
      throw new Error('offline');
    },
    reconnectDelayMs: 30_000,
    reconnectMaxDelayMs: 30_000,
    onError: () => failed(),
  });

  const run = worker.run(controller.signal);
  await failure;
  controller.abort();
  await run;
});

test('sandbox completion does not cancel an in-flight credential rotation', async () => {
  const key = createBridgeIdentity();
  const identity = {
    privateKey: key.privateKey,
    credential: 'credential-before-in-flight-rotation',
    expiresAt: new Date(Date.now() + 40).toISOString(),
  };
  let refreshStarted!: () => void;
  const refreshStartedPromise = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let refreshCount = 0;
  let settleAuthorization = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/credentials/refresh')) {
      refreshCount += 1;
      if (refreshCount > 1) {
        return Response.json({ error: 'stale credential' }, { status: 401 });
      }
      refreshStarted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'credential-after-in-flight-rotation',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (url.endsWith('/execute')) {
      await refreshStartedPromise;
      return Response.json({ session_id: 'run-rotation-race', files: [] });
    }
    settleAuthorization = (
      init?.headers as Record<string, string>
    ).Authorization;
    return Response.json({ protocolVersion: 1, accepted: true });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
    credentialRefreshWindowMs: 30,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-rotation-race',
    workerId: 'vm-1',
    incarnationId,
    generation: 5,
    leaseToken: 'assignment-rotation-race-lease-token',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(refreshCount, 1);
  assert.equal(identity.credential, 'credential-after-in-flight-rotation');
  assert.equal(
    settleAuthorization,
    'Bridge credential-after-in-flight-rotation',
  );
});

test('reconnect delay uses bounded exponential jitter', () => {
  assert.equal(reconnectDelayMs(0, 1_000, 30_000, () => 0), 500);
  assert.equal(reconnectDelayMs(0, 1_000, 30_000, () => 1), 1_000);
  assert.equal(reconnectDelayMs(10, 1_000, 30_000, () => 1), 30_000);
});
