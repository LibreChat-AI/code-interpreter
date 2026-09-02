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
        throw new Error('No such container');
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
  const health = calls.find(
    args => args[0] === 'exec' && args.some(value => value.includes('/api/v2/health')),
  );
  assert.ok(health?.includes('--max-time'));
});

test('docker runtime supervisor rejects malformed runtime response framing', async () => {
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('No such container');
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

test('docker runtime supervisor preserves an existing stateful container after a health failure', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') return 'true\n';
      if (args[0] === 'exec') throw new Error('runner unavailable');
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
    startupTimeoutMs: 1,
  });

  await assert.rejects(supervisor.acquire(assignment('rt-user-1')), /did not become healthy/);
  assert.equal(calls.some(args => args[0] === 'container' && args[1] === 'rm'), false);
});

test('docker runtime supervisor propagates removal failures and forwards reset cancellation', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const client: ContainerRuntimeClient = {
    async run(args, options) {
      if (args[0] === 'container' && args[1] === 'rm') {
        receivedSignal = options?.signal;
        throw new Error('Docker daemon unavailable');
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ image: 'example/code-runtime:latest', client });

  await assert.rejects(supervisor.reset('rt-user-1', controller.signal), /Docker daemon unavailable/);
  assert.equal(receivedSignal, controller.signal);
});

test('docker runtime supervisor cleans up stateless containers after interrupted creation', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new Error('No such container');
      }
      if (args[0] === 'run') throw new DOMException('aborted', 'AbortError');
      if (args[0] === 'container' && args[1] === 'rm') return 'removed\n';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ image: 'example/code-runtime:latest', client });

  await assert.rejects(supervisor.acquire(assignment()), /aborted/);
  assert.equal(calls.some(args => args[0] === 'container' && args[1] === 'rm'), true);
});

test('docker runtime supervisor ignores only confirmed missing-container removal', async () => {
  const client: ContainerRuntimeClient = {
    async run() {
      throw new Error('Error response from daemon: No such container: runtime');
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ image: 'example/code-runtime:latest', client });

  await supervisor.reset('rt-user-1');
});

test('docker runtime supervisor destroys stateless and reset stateful runtimes', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('No such container');
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
