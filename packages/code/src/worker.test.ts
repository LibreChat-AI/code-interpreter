import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeWorker } from './worker.js';

import type { BridgeAssignment } from './protocol.js';

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
    incarnationId: 'incarnation-00000001',
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
    incarnationId: 'incarnation-00000001',
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
    incarnationId: 'incarnation-00000001',
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
    return new Response(
      JSON.stringify({ protocolVersion: 1, accepted: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
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
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 30).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(settlement?.status, 'rejected');
  assert.equal(settlement?.incarnationId, 'incarnation-00000001');
});

test('worker refreshes its registration during a long assignment', async () => {
  let registrations = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workers/register')) {
      registrations += 1;
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId: 'incarnation-00000001',
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 50,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/execute')) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ protocolVersion: 1, accepted: true, body: init?.body }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
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
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.ok(registrations >= 2);
});
