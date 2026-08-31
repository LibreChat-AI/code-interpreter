import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeWorker, BridgeWorkspaceQuarantinedError } from './worker.js';

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
  const fetchImpl: typeof fetch = async (input) => {
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
