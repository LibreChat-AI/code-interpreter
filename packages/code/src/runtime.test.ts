import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerRuntimeSupervisor, EndpointRuntimeSupervisor } from './runtime.js';

import type { ContainerRuntimeClient } from './runtime.js';

function assignment(runtimeSessionId?: string) {
  return {
    protocolVersion: 1 as const,
    assignmentId: 'assignment-1',
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
    generation: 1,
    leaseToken: 'lease-token',
    expiresAt: new Date().toISOString(),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    request: { body: {}, headers: {} },
  };
}

test('endpoint runtime supervisor resolves an isolated endpoint for stateful work', async () => {
  const supervisor = new EndpointRuntimeSupervisor({
    endpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2/',
    statefulWorkspace: true,
  });

  const lease = await supervisor.acquire(assignment('rt/user 1'));

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
    supervisor.acquire(assignment('rt-1')),
    /runtime supervisor endpoint containing/,
  );
});

test('endpoint runtime supervisor gives stateless work an ephemeral session route', async () => {
  const supervisor = new EndpointRuntimeSupervisor({
    endpoint: 'http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2',
    statefulWorkspace: false,
  });

  const lease = await supervisor.acquire(assignment());

  assert.equal(lease.sessionId, 'assignment-assignment-1');
  assert.equal(
    lease.endpoint,
    'http://127.0.0.1:2000/sessions/assignment-assignment-1/api/v2',
  );
});

test('docker runtime supervisor creates a networkless stateful runtime and executes through its loopback', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new Error('container missing');
      }
      if (args[0] === 'run') return 'container-id\n';
      if (args[0] === 'exec' && args.some(value => value.includes('/api/v2/health'))) return '200';
      if (args[0] === 'exec' && args.some(value => value.includes('/api/v2/execute'))) {
        const writeOut = args[args.indexOf('--write-out') + 1] ?? '';
        return `{"session_id":"run-1"}${writeOut.replace('%{http_code}', '200')}`;
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
  });

  const lease = await supervisor.acquire(assignment('rt-user-1'));

  const result = await lease.execute?.({ body: '{}', headers: { 'X-Test': '1' } });
  assert.equal(result?.status, 200);
  assert.equal(result?.body, '{"session_id":"run-1"}');
  assert.equal(lease.sessionId, 'rt-user-1');
  const run = calls.find(args => args[0] === 'run');
  assert.deepEqual(run?.slice(0, 10), [
    'run',
    '--detach',
    '--name',
    run?.[3] ?? '',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
  ]);
  assert.equal(run?.includes('rt-user-1'), false);
});

test('docker runtime supervisor rejects malformed runtime response framing', async () => {
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('container missing');
      if (args[0] === 'run') return 'container-id\n';
      if (args[0] === 'exec' && args.some(value => value.includes('/api/v2/health'))) return '200';
      if (args[0] === 'exec' && args.some(value => value.includes('/api/v2/execute'))) return 'not framed';
      if (args[0] === 'container' && args[1] === 'rm') return 'removed\n';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ image: 'example/code-runtime:latest', client });
  const lease = await supervisor.acquire(assignment('rt-user-1'));

  const execute = lease.execute;
  assert.ok(execute);
  await assert.rejects(execute({ body: '{}', headers: {} }), /invalid HTTP response/);
});

test('docker runtime supervisor destroys stateless and reset stateful runtimes', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('container missing');
      if (args[0] === 'run') return 'container-id\n';
      if (args[0] === 'exec' && args.some(value => value.includes('/api/v2/health'))) return '200';
      if (args[0] === 'container' && args[1] === 'rm') return 'removed\n';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
  });

  const lease = await supervisor.acquire(assignment());
  await lease.release?.();
  await supervisor.reset('rt-user-1');
  await supervisor.quarantine?.('rt-user-2', 'ambiguous result');

  const removals = calls.filter(args => args[0] === 'container' && args[1] === 'rm');
  assert.equal(removals.length, 3);
  assert.ok(removals.every(args => args[2] === '--force'));
});
