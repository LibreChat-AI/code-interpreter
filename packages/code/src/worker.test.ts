import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeIdentity, verifyBridgeRequest } from './identity.js';
import {
  BridgeWorker,
  BridgeWorkspaceQuarantinedError,
  reconnectDelayMs,
} from './worker.js';

import type { BridgeAssignment } from './protocol.js';
import type { RuntimeSupervisor } from './runtime.js';

const incarnationId = 'incarnation-00000001';

test('worker invokes lifecycle hooks only after its incarnation registers', async () => {
  const registered: string[] = [];
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
    fetchImpl: async () =>
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
      }),
    onRegistered: async (registration) => {
      registered.push(registration.incarnationId);
    },
  });

  await worker.register();

  assert.deepEqual(registered, [incarnationId]);
});

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

test('worker delegates runtime acquisition, release, and reset to its supervisor', async () => {
  const calls: string[] = [];
  const supervisor: RuntimeSupervisor = {
    async acquire(assignment) {
      calls.push(`acquire:${assignment.runtimeSessionId}`);
      return {
        endpoint: 'http://127.0.0.1:3000/runtime',
        sessionId: assignment.runtimeSessionId,
        async release() {
          calls.push(`release:${assignment.runtimeSessionId}`);
        },
      };
    },
    async reset(runtimeSessionId) {
      calls.push(`reset:${runtimeSessionId}`);
    },
    async quarantine() {},
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    runtimeSupervisor: supervisor,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'oci',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/execute')) {
        assert.equal(url, 'http://127.0.0.1:3000/runtime/execute');
        return Response.json({ session_id: 'run-1', files: [] });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  const assignment: BridgeAssignment = {
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    runtimeSessionId: 'rt-user-1',
    request: { body: { language: 'bash' }, headers: {} },
  };

  await worker.executeAndSettle(assignment);
  await worker.resetWorkspace('rt-user-1');

  assert.deepEqual(calls, [
    'acquire:rt-user-1',
    'release:rt-user-1',
    'reset:rt-user-1',
  ]);
});

test('worker asks its supervisor to quarantine an ambiguous stateful runtime', async () => {
  const quarantined: Array<{ sessionId: string; reason: string }> = [];
  const supervisor: RuntimeSupervisor = {
    async acquire() {
      return { endpoint: 'http://127.0.0.1:3000/runtime', sessionId: 'rt-user-1' };
    },
    async reset() {},
    async quarantine(sessionId, reason) {
      quarantined.push({ sessionId, reason });
    },
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    runtimeSupervisor: supervisor,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'oci',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        throw new TypeError('connection reset');
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-1',
      workerId: 'vm-1',
      incarnationId,
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );

  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0]?.sessionId, 'rt-user-1');
  assert.match(quarantined[0]?.reason ?? '', /ambiguous sandbox execution/);
});

test('worker acknowledges a discarded workspace through the reset endpoint', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      assert.match(String(input), /workers\/vm-1\/workspaces\/reset$/);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ protocolVersion: 1, reset: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await worker.resetWorkspace('rt-user-1');
  assert.deepEqual(requestBody, {
    protocolVersion: 1,
    incarnationId: 'incarnation-00000001',
    runtimeSessionId: 'rt-user-1',
    confirmDiscarded: true,
  });
});

test('worker bounds a stalled workspace reset request', async () => {
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    resetTransportTimeoutMs: 20,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  });

  await assert.rejects(worker.resetWorkspace('rt-user-1'), {
    name: 'AbortError',
  });
});

test('worker continues after an assignment-scoped settlement conflict', async () => {
  const controller = new AbortController();
  let registrations = 0;
  let leases = 0;
  let leaseAcknowledged = false;
  let observedError: unknown;
  const assignment: BridgeAssignment = {
    protocolVersion: 1,
    assignmentId: 'expired-settlement',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    remainingMs: 5_000,
    request: { body: { language: 'bash' }, headers: {} },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workers/register')) {
      registrations += 1;
      if (registrations === 2) controller.abort();
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId: 'incarnation-00000001',
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (init?.signal?.aborted === true) {
      throw new DOMException('aborted', 'AbortError');
    }
    if (url.endsWith('/lease')) {
      leases += 1;
      return new Response(
        JSON.stringify({ protocolVersion: 1, serverElapsedMs: 0, assignment }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/ack')) {
      leaseAcknowledged = true;
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/execute')) {
      assert.equal(leaseAcknowledged, true);
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        error: 'Bridge assignment has expired',
        code: 'ASSIGNMENT_EXPIRED',
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
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
    reconnectDelayMs: 0,
    fetchImpl,
    onError: (error) => {
      observedError = error;
    },
  });

  await worker.run(controller.signal);
  assert.equal(registrations, 2);
  assert.equal(leases, 1);
  assert.equal(
    observedError instanceof Error ? observedError.message : undefined,
    'Bridge assignment has expired',
  );
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
          leaseTtlMs: 100,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/execute')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        accepted: true,
        body: init?.body,
      }),
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
  await new Promise((resolve) => setTimeout(resolve, 45));
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

test('worker schedules registration freshness from request start', async () => {
  let registrations = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/workers/register')) {
      registrations += 1;
      if (registrations === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/cancelled')) {
      return new Response(
        JSON.stringify({ protocolVersion: 1, cancelled: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
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
    registrationTransportTimeoutMs: 100,
    cancellationPollIntervalMs: 100,
    fetchImpl,
  });
  await worker.register();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-registration-transit',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.ok(registrations >= 2);
});

test('worker continues cancellation polling after a stalled response', async () => {
  let cancellationAttempts = 0;
  let settlementAttempted = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/execute')) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    if (url.endsWith('/cancellation')) {
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    settlementAttempted = true;
    return new Response(JSON.stringify({ protocolVersion: 1, accepted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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
    cancellationPollIntervalMs: 5,
    cancellationTransportTimeoutMs: 10,
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'cancel-after-stall',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    remainingMs: 1_000,
    request: { body: { language: 'bash' }, headers: {} },
  });
  assert.equal(cancellationAttempts, 2);
  assert.equal(settlementAttempted, true);
});

test('worker routes a hintless assignment to an ephemeral template session', async () => {
  let executeUrl = '';
  let runtimeSessionHeader = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/execute')) {
      executeUrl = url;
      runtimeSessionHeader = (init?.headers as Record<string, string>)[
        'X-Runtime-Session-Id'
      ];
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
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'hintless-assignment',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(
    executeUrl,
    'http://127.0.0.1:2000/sessions/assignment-hintless-assignment/api/v2/execute',
  );
  assert.equal(runtimeSessionHeader, 'assignment-hintless-assignment');
});

test('worker quarantines a fulfilled stateful settlement rejected by Code API', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/execute')) {
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'assignment was fenced' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'fenced-settlement',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );
});

test('worker surfaces a definite stateless settlement rejection directly', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/execute')) {
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'assignment was fenced' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
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

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'fenced-stateless-settlement',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      request: { body: { language: 'bash' }, headers: {} },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'BridgeProtocolError' &&
      error.message === 'assignment was fenced',
  );
});

test('worker preserves status for a non-JSON settlement rejection', async () => {
  let settlementAttempts = 0;
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
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      settlementAttempts += 1;
      return new Response('<html>assignment fenced</html>', {
        status: 409,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'non-json-fenced-settlement',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      request: { body: { language: 'bash' }, headers: {} },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'BridgeProtocolError' &&
      'status' in error &&
      error.status === 409,
  );
  assert.equal(settlementAttempts, 1);
});

test('worker retries an ambiguous settlement before the deadline', async () => {
  let settlementAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/execute')) {
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    settlementAttempts += 1;
    if (settlementAttempts === 1) throw new TypeError('connection reset');
    return new Response(
      JSON.stringify({ protocolVersion: 1, accepted: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'retry-settlement',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    runtimeSessionId: 'rt-user-1',
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(settlementAttempts, 2);
});

test('worker quarantines stateful reuse after settlement stays ambiguous', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/execute')) {
      return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new TypeError('connection reset');
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'ambiguous-settlement',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 50).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );
});

test('worker keeps a definite stateful rejection nonfatal when settlement is ambiguous', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/execute')) {
      return new Response(JSON.stringify({ error: 'syntax_error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new TypeError('connection reset');
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
    rejectionAckGraceMs: 0,
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'rejected-ambiguous-settlement',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 50).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    (error: unknown) =>
      error instanceof TypeError &&
      !(error instanceof BridgeWorkspaceQuarantinedError),
  );
});

test('worker retries a known-clean rejection after shutdown until acknowledged', async () => {
  const controller = new AbortController();
  let settlementAttempts = 0;
  let registrations = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/workers/register')) {
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
    if (String(input).endsWith('/execute')) {
      return new Response(JSON.stringify({ error: 'syntax_error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    settlementAttempts += 1;
    if (settlementAttempts === 1) {
      controller.abort();
      throw new TypeError('connection reset');
    }
    return new Response(JSON.stringify({ protocolVersion: 1, accepted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    rejectionAckGraceMs: 500,
    fetchImpl,
  });

  await worker.register();
  await worker.executeAndSettle(
    {
      protocolVersion: 1,
      assignmentId: 'late-clean-rejection',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 20).toISOString(),
      remainingMs: 20,
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    },
    controller.signal,
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(settlementAttempts, 2);
  assert.ok(registrations > 1);
});

test('worker preserves a definite rejection when its heartbeat fails', async () => {
  let registrations = 0;
  let rejectedSettlement = false;
  let settlementAttempts = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/workers/register')) {
        registrations += 1;
        if (registrations === 2) {
          throw new TypeError('registration unavailable');
        }
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
      if (String(input).endsWith('/execute')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ error: 'syntax_error' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      settlementAttempts += 1;
      rejectedSettlement =
        JSON.parse(String(init?.body) || '{}').status === 'rejected';
      if (settlementAttempts === 1) {
        return new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await worker.register();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'clean-rejection-after-heartbeat-error',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    remainingMs: 1_000,
    runtimeSessionId: 'rt-user-1',
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.ok(registrations >= 3);
  assert.equal(rejectedSettlement, true);
  assert.equal(settlementAttempts, 2);
});

test('worker quarantines a stateful workspace after a sandbox 5xx response', async () => {
  let settlementAttempted = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        return new Response(JSON.stringify({ error: 'upstream failed' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      settlementAttempted = true;
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'ambiguous-5xx',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      remainingMs: 1_000,
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(settlementAttempted, false);
});

test('worker treats a non-JSON sandbox 4xx as a definite rejection', async () => {
  let rejectedSettlement = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/execute')) {
        return new Response('<html>not found</html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      rejectedSettlement =
        JSON.parse(String(init?.body) || '{}').status === 'rejected';
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'non-json-404',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    remainingMs: 1_000,
    runtimeSessionId: 'rt-user-1',
    request: { body: { language: 'bash' }, headers: {} },
  });
  assert.equal(rejectedSettlement, true);
});

test('worker quarantines a stateful workspace after the sandbox request aborts', async () => {
  let settlementAttempted = false;
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
    settlementAttempted = true;
    return new Response(JSON.stringify({ protocolVersion: 1, accepted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'aborted-execution',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 30).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(settlementAttempted, false);
});

test('worker surfaces quarantine when shutdown aborts stateful execution', async () => {
  const controller = new AbortController();
  let executeStarted = false;
  const assignment: BridgeAssignment = {
    protocolVersion: 1,
    assignmentId: 'shutdown-execution',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    remainingMs: 5_000,
    runtimeSessionId: 'rt-user-1',
    request: { body: { language: 'bash' }, headers: {} },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/workers/register')) {
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId: 'incarnation-00000001',
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/lease')) {
      return new Response(
        JSON.stringify({ protocolVersion: 1, serverElapsedMs: 0, assignment }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/execute')) {
      executeStarted = true;
      setTimeout(() => controller.abort(), 10);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify({ protocolVersion: 1, accepted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await assert.rejects(
    worker.run(controller.signal),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(executeStarted, true);
});

test('worker does not start execution after shutdown is already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('shutdown', 'AbortError'));
  let executeStarted = false;
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
    fetchImpl: async () => {
      executeStarted = true;
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(
    worker.executeAndSettle(
      {
        protocolVersion: 1,
        assignmentId: 'shutdown-before-execution',
        workerId: 'vm-1',
        incarnationId: 'incarnation-00000001',
        generation: 1,
        leaseToken: 'lease-token-that-is-long-enough-for-testing',
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        remainingMs: 5_000,
        request: { body: { language: 'bash' }, headers: {} },
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(executeStarted, false);
});

test('worker does not start settlement after shutdown is already aborted', async () => {
  const controller = new AbortController();
  let settlementAttempted = false;
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
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        throw new DOMException('aborted', 'AbortError');
      }
      settlementAttempted = true;
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(
    worker.executeAndSettle(
      {
        protocolVersion: 1,
        assignmentId: 'shutdown-before-settlement',
        workerId: 'vm-1',
        incarnationId: 'incarnation-00000001',
        generation: 1,
        leaseToken: 'lease-token-that-is-long-enough-for-testing',
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        remainingMs: 5_000,
        request: { body: { language: 'bash' }, headers: {} },
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(settlementAttempted, false);
});

test('worker bounds a stalled lease transport beyond its long poll', async () => {
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
    leaseWaitMs: 10,
    leaseTransportGraceMs: 20,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  });

  await assert.rejects(worker.lease(), { name: 'AbortError' });
});

test('worker subtracts lease response transit from the server budget', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
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
      fetchImpl: async (input) => {
        if (String(input).endsWith('/ack')) {
          return new Response(
            JSON.stringify({ protocolVersion: 1, accepted: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        now += 50;
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            serverElapsedMs: 20,
            assignment: {
              protocolVersion: 1,
              assignmentId: 'transit-budget',
              workerId: 'vm-1',
              incarnationId: 'incarnation-00000001',
              generation: 1,
              leaseToken: 'lease-token-that-is-long-enough-for-testing',
              expiresAt: new Date(0).toISOString(),
              remainingMs: 1_000,
              request: { body: { language: 'bash' }, headers: {} },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const assignment = await worker.lease();
    assert.equal(assignment?.remainingMs, 970);
  } finally {
    Date.now = originalNow;
  }
});

test('worker rejects a lease whose acknowledgement exhausts its budget', async () => {
  const originalNow = Date.now;
  let now = 100_000;
  let abandonedSettlement: Record<string, unknown> | undefined;
  let registrations = 0;
  let settlementAttempts = 0;
  Date.now = () => now;
  try {
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
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/workers/register')) {
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
        if (String(input).endsWith('/ack')) {
          now += 10;
          return new Response(
            JSON.stringify({ protocolVersion: 1, accepted: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (String(input).endsWith('/settle')) {
          settlementAttempts += 1;
          abandonedSettlement = JSON.parse(
            String(init?.body),
          ) as Record<string, unknown>;
          if (settlementAttempts === 1) {
            return new Response(JSON.stringify({ error: 'unavailable' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({ protocolVersion: 1, accepted: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            serverElapsedMs: 0,
            assignment: {
              protocolVersion: 1,
              assignmentId: 'expired-after-ack',
              workerId: 'vm-1',
              incarnationId: 'incarnation-00000001',
              generation: 1,
              leaseToken: 'lease-token-that-is-long-enough-for-testing',
              expiresAt: new Date(0).toISOString(),
              remainingMs: 10,
              request: { body: { language: 'bash' }, headers: {} },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(worker.lease(), /expired during lease acknowledgement/);
    assert.equal(abandonedSettlement?.status, 'rejected');
    assert.ok(registrations > 0);
    assert.equal(settlementAttempts, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('worker rejects an assignment after ambiguous acknowledgement delivery', async () => {
  let rejectedSettlement = false;
  let acknowledgementAttempts = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    rejectionAckGraceMs: 500,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/ack')) {
        acknowledgementAttempts += 1;
        throw new TypeError('acknowledgement response lost');
      }
      if (String(input).endsWith('/settle')) {
        rejectedSettlement =
          JSON.parse(String(init?.body) || '{}').status === 'rejected';
        return new Response(
          JSON.stringify({ protocolVersion: 1, accepted: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (String(input).endsWith('/workers/register')) {
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'vm-1',
            incarnationId: 'incarnation-00000001',
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          serverElapsedMs: 0,
          assignment: {
            protocolVersion: 1,
            assignmentId: 'ambiguous-ack',
            workerId: 'vm-1',
            incarnationId: 'incarnation-00000001',
            generation: 1,
            leaseToken: 'lease-token-that-is-long-enough-for-testing',
            expiresAt: new Date(Date.now() + 1_000).toISOString(),
            remainingMs: 1_000,
            runtimeSessionId: 'rt-user-1',
            request: { body: { language: 'bash' }, headers: {} },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(worker.lease(), /acknowledgement response lost/);
  assert.equal(acknowledgementAttempts, 1);
  assert.equal(rejectedSettlement, true);
});

test('worker clamps rejected settlement errors to the protocol limit', async () => {
  let rejection = '';
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/execute')) {
        return new Response(JSON.stringify({ error: 'x'.repeat(5_000) }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const settlement = JSON.parse(String(init?.body)) as { error: string };
      rejection = settlement.error;
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'long-rejection',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    remainingMs: 1_000,
    runtimeSessionId: 'rt-long-rejection',
    request: { body: { language: 'bash' }, headers: {} },
  });
  assert.equal(rejection.length, 4_096);
});

test('worker quarantines an explicitly dirty stateful sandbox response', async () => {
  let settlementAttempted = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        return new Response(
          JSON.stringify({
            error: 'session_workspace_dirty',
            message: 'restore required',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      settlementAttempted = true;
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'dirty-execution',
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      generation: 1,
      leaseToken: 'lease-token-that-is-long-enough-for-testing',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      runtimeSessionId: 'rt-user-1',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    BridgeWorkspaceQuarantinedError,
  );
  assert.equal(settlementAttempted, false);
});

test('worker bounds a stalled registration below its lease TTL', async () => {
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
    registrationTransportTimeoutMs: 20,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  });

  await assert.rejects(worker.register(), { name: 'AbortError' });
});

test('worker preserves status for a non-JSON registration rejection', async () => {
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
    fetchImpl: async () =>
      new Response('<html>unauthorized</html>', {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      }),
  });

  await assert.rejects(
    worker.register(),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'BridgeProtocolError' &&
      'status' in error &&
      error.status === 401,
  );
});

test('worker uses the server-relative lease budget despite VM clock skew', async () => {
  let settlementAttempted = false;
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
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) {
        return new Response(JSON.stringify({ session_id: 'run-1', files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      settlementAttempted = true;
      return new Response(
        JSON.stringify({ protocolVersion: 1, accepted: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'skewed-clock-assignment',
    workerId: 'vm-1',
    incarnationId: 'incarnation-00000001',
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(0).toISOString(),
    remainingMs: 1_000,
    request: { body: { language: 'bash' }, headers: {} },
  });
  assert.equal(settlementAttempted, true);
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

test('paired worker rotates credentials throughout a long assignment', async () => {
  const key = createBridgeIdentity();
  let refreshCount = 0;
  const identity = {
    privateKey: key.privateKey,
    credential: 'credential-before-long-running-assignment',
    expiresAt: new Date(Date.now() + 5).toISOString(),
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/credentials/refresh')) {
      refreshCount += 1;
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: `rotated-long-assignment-credential-${refreshCount}`,
        expiresAt: new Date(Date.now() + 30).toISOString(),
      });
    }
    if (url.endsWith('/execute')) {
      await new Promise((resolve) => setTimeout(resolve, 55));
      return Response.json({ session_id: 'run-long-rotation', files: [] });
    }
    return Response.json({ protocolVersion: 1, accepted: true });
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    credentialRefreshWindowMs: 10,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl,
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-credential-maintenance',
    workerId: 'vm-1',
    incarnationId,
    generation: 5,
    leaseToken: 'assignment-credential-maintenance-token',
    expiresAt: new Date(Date.now() + 500).toISOString(),
    remainingMs: 500,
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.ok(refreshCount >= 2);
  assert.match(identity.credential, /^rotated-long-assignment-credential-/);
});

test('paired worker cancels a stalled credential refresh after execution', async () => {
  const key = createBridgeIdentity();
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let refreshAborted = false;
  const identity = {
    privateKey: key.privateKey,
    credential: 'credential-before-stalled-refresh',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    credentialRefreshWindowMs: 100,
    credentialRefreshTransportTimeoutMs: 10_000,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/credentials/refresh')) {
        refreshStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              refreshAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      if (url.endsWith('/execute')) {
        await started;
        return Response.json({
          session_id: 'run-stalled-refresh',
          files: [],
        });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  queueMicrotask(() => {
    identity.expiresAt = new Date(Date.now() + 50).toISOString();
  });
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-stalled-refresh',
    workerId: 'vm-1',
    incarnationId,
    generation: 6,
    leaseToken: 'assignment-stalled-refresh-token',
    expiresAt: new Date(Date.now() + 2_000).toISOString(),
    remainingMs: 2_000,
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(refreshAborted, true);
});

test('paired worker refreshes conservatively before server clock calibration', async () => {
  const key = createBridgeIdentity();
  let refreshCount = 0;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-before-idle-clock-skew-refresh',
      expiresAt: new Date(Date.now() + 65_000).toISOString(),
    },
    credentialRefreshWindowMs: 10_000,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async () => {
      refreshCount += 1;
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'credential-after-idle-clock-skew-refresh',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    },
  });

  await worker.refreshCredential();

  assert.equal(refreshCount, 1);
});

test('paired worker charges initial credential refresh against the assignment deadline', async () => {
  const key = createBridgeIdentity();
  let sandboxStarted = false;
  let rejected = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-before-deadline-refresh',
      expiresAt: new Date(Date.now() + 5).toISOString(),
    },
    credentialRefreshWindowMs: 10,
    credentialRefreshTransportTimeoutMs: 10_000,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/credentials/refresh')) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      if (url.endsWith('/execute')) {
        sandboxStarted = true;
      }
      if (url.endsWith('/settle')) {
        rejected =
          JSON.parse(String(init?.body)).status === 'rejected';
      }
      return Response.json({
        protocolVersion: 1,
        accepted: true,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
      });
    },
  });

  await assert.rejects(
    worker.executeAndSettle({
      protocolVersion: 1,
      assignmentId: 'assignment-deadline-refresh',
      workerId: 'vm-1',
      incarnationId,
      generation: 7,
      leaseToken: 'assignment-deadline-refresh-token',
      expiresAt: new Date(Date.now() + 30).toISOString(),
      remainingMs: 30,
      runtimeSessionId: 'rt-deadline-refresh',
      request: { body: { language: 'bash' }, headers: {} },
    }),
    { name: 'AbortError' },
  );

  assert.equal(sandboxStarted, false);
  assert.equal(rejected, true);
});

test('paired worker rechecks the deadline after request serialization', async () => {
  const key = createBridgeIdentity();
  let sandboxStarted = false;
  let rejected = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint:
      'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-valid-during-serialization',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
    credentialRefreshWindowMs: 10,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/execute')) {
        sandboxStarted = true;
      }
      if (url.endsWith('/settle')) {
        rejected =
          JSON.parse(String(init?.body)).status === 'rejected';
      }
      return Response.json({
        protocolVersion: 1,
        accepted: true,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
      });
    },
  });
  const slowBody = {
    get language(): string {
      const blockedUntilMs = Date.now() + 25;
      while (Date.now() < blockedUntilMs) {
        // Deliberately consume the remaining synchronous request budget.
      }
      return 'bash';
    },
  };

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-serialization-deadline',
    workerId: 'vm-1',
    incarnationId,
    generation: 8,
    leaseToken: 'assignment-serialization-deadline-token',
    expiresAt: new Date(Date.now() + 10).toISOString(),
    remainingMs: 10,
    runtimeSessionId: 'rt-serialization-deadline',
    request: { body: slowBody, headers: {} },
  });

  assert.equal(sandboxStarted, false);
  assert.equal(rejected, true);
});

test('paired worker keeps endpoint validation failures known-clean', async () => {
  const key = createBridgeIdentity();
  let sandboxStarted = false;
  let rejected = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-for-invalid-endpoint',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/execute')) sandboxStarted = true;
      if (url.endsWith('/settle')) {
        rejected =
          JSON.parse(String(init?.body)).status === 'rejected';
      }
      return Response.json({
        protocolVersion: 1,
        accepted: true,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
      });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-invalid-endpoint',
    workerId: 'vm-1',
    incarnationId,
    generation: 9,
    leaseToken: 'assignment-invalid-endpoint-token',
    expiresAt: new Date(Date.now() + 500).toISOString(),
    remainingMs: 500,
    runtimeSessionId: 'rt-invalid-endpoint',
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(sandboxStarted, false);
  assert.equal(rejected, true);
});

test('paired worker rechecks shutdown after persisting a refreshed identity', async () => {
  const key = createBridgeIdentity();
  const controller = new AbortController();
  let sandboxStarted = false;
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity: {
      privateKey: key.privateKey,
      credential: 'credential-before-shutdown-refresh',
      expiresAt: new Date(Date.now() + 5).toISOString(),
    },
    credentialRefreshWindowMs: 10,
    capabilities: {
      statefulWorkspace: true,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/execute')) sandboxStarted = true;
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        credential: 'credential-persisted-during-shutdown',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    },
    onIdentityChange: () => {
      controller.abort();
    },
  });

  await assert.rejects(
    worker.executeAndSettle(
      {
        protocolVersion: 1,
        assignmentId: 'assignment-shutdown-refresh',
        workerId: 'vm-1',
        incarnationId,
        generation: 10,
        leaseToken: 'assignment-shutdown-refresh-token',
        expiresAt: new Date(Date.now() + 500).toISOString(),
        remainingMs: 500,
        runtimeSessionId: 'rt-shutdown-refresh',
        request: { body: { language: 'bash' }, headers: {} },
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );

  assert.equal(sandboxStarted, false);
});

test('paired worker retries transient refresh failures before credential expiry', async () => {
  const key = createBridgeIdentity();
  let refreshCount = 0;
  const identity = {
    privateKey: key.privateKey,
    credential: 'credential-before-transient-refresh',
    expiresAt: new Date(Date.now() + 40).toISOString(),
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    credentialRefreshWindowMs: 15,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/credentials/refresh')) {
        refreshCount += 1;
        if (refreshCount === 1) {
          return Response.json(
            { error: 'temporarily unavailable' },
            { status: 503 },
          );
        }
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          credential: 'credential-after-transient-refresh',
          expiresAt: new Date(Date.now() + 500).toISOString(),
        });
      }
      if (url.endsWith('/execute')) {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return Response.json({
          session_id: 'run-transient-refresh',
          files: [],
        });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-transient-refresh',
    workerId: 'vm-1',
    incarnationId,
    generation: 7,
    leaseToken: 'assignment-transient-refresh-token',
    expiresAt: new Date(Date.now() + 500).toISOString(),
    remainingMs: 500,
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(refreshCount, 2);
  assert.equal(identity.credential, 'credential-after-transient-refresh');
});

test('paired worker preserves its refresh margin when the server clock is ahead', async () => {
  const key = createBridgeIdentity();
  const serverClockOffsetMs = 55;
  let refreshCount = 0;
  const identity = {
    privateKey: key.privateKey,
    credential: 'credential-before-clock-skew-refresh',
    expiresAt: new Date(Date.now() + serverClockOffsetMs + 20).toISOString(),
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    identity,
    credentialRefreshWindowMs: 10,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'nsjail',
      runtimes: ['bash'],
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/credentials/refresh')) {
        refreshCount += 1;
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          credential: 'credential-after-clock-skew-refresh',
          expiresAt: new Date(
            Date.now() + serverClockOffsetMs + 500,
          ).toISOString(),
        });
      }
      if (url.endsWith('/execute')) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return Response.json({
          session_id: 'run-clock-skew-refresh',
          files: [],
        });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  const remainingMs = 500;

  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-clock-skew-refresh',
    workerId: 'vm-1',
    incarnationId,
    generation: 8,
    leaseToken: 'assignment-clock-skew-refresh-token',
    expiresAt: new Date(
      Date.now() + serverClockOffsetMs + remainingMs,
    ).toISOString(),
    remainingMs,
    request: { body: { language: 'bash' }, headers: {} },
  });

  assert.equal(refreshCount, 1);
  assert.equal(identity.credential, 'credential-after-clock-skew-refresh');
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
