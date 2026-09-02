import assert from 'node:assert/strict';
import test from 'node:test';

import { EndpointRuntimeSupervisor } from './runtime.js';

test('endpoint runtime supervisor resolves an isolated endpoint for stateful work', async () => {
  const supervisor = new EndpointRuntimeSupervisor({
    endpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2/',
    statefulWorkspace: true,
  });

  const lease = await supervisor.acquire({
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
    generation: 1,
    leaseToken: 'lease-token',
    expiresAt: new Date().toISOString(),
    runtimeSessionId: 'rt/user 1',
    request: { body: {}, headers: {} },
  });

  assert.equal(lease.sessionId, 'rt/user 1');
  assert.equal(
    lease.endpoint,
    'http://127.0.0.1:2000/sessions/rt%2Fuser%201/api/v2',
  );
});

test('endpoint runtime supervisor refuses stateful work without an isolated route', async () => {
  const supervisor = new EndpointRuntimeSupervisor({
    endpoint: 'http://127.0.0.1:2000/api/v2',
    statefulWorkspace: true,
  });

  await assert.rejects(
    supervisor.acquire({
      protocolVersion: 1,
      assignmentId: 'assignment-1',
      workerId: 'worker-1',
      incarnationId: 'incarnation-1',
      generation: 1,
      leaseToken: 'lease-token',
      expiresAt: new Date().toISOString(),
      runtimeSessionId: 'rt-1',
      request: { body: {}, headers: {} },
    }),
    /runtime supervisor endpoint containing/,
  );
});

test('endpoint runtime supervisor gives stateless work an ephemeral session route', async () => {
  const supervisor = new EndpointRuntimeSupervisor({
    endpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    statefulWorkspace: false,
  });

  const lease = await supervisor.acquire({
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
    generation: 1,
    leaseToken: 'lease-token',
    expiresAt: new Date().toISOString(),
    request: { body: {}, headers: {} },
  });

  assert.equal(lease.sessionId, 'assignment-assignment-1');
  assert.equal(
    lease.endpoint,
    'http://127.0.0.1:2000/sessions/assignment-assignment-1/api/v2',
  );
});
