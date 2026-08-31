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
        JSON.stringify({ protocolVersion: 1, assignment }),
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
