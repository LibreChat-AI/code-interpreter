import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('docker runtime supervisor permits only its fixed workspace command route', async () => {
  const calls: string[][] = [];
  const supervisor = new DockerRuntimeSupervisor({
    image: 'runner:latest',
    environment: {
      SANDBOX_EXTERNAL_WORKSPACE_TOKEN: 'private-workspace-capability',
    },
    client: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'container') throw new Error('No such container');
        if (args[0] === 'run') return 'container';
        if (args.some((value) => value.includes('/api/v2/health'))) return '200';
        if (args.some((value) => value.includes('/api/v2/workspace/execute'))) {
          const script = args.find((value) => value.includes("const b=await Bun.stdin.text"));
          const marker = script?.match(/\\n([0-9a-f]{64})/)?.[1];
          return `{"exitCode":0}\n${marker}200`;
        }
        return '';
      },
    },
    httpClient: 'bun',
  });
  const lease = await supervisor.acquire(assignment('workspace-route'));
  const response = await lease.execute?.({
    body: '{"command":"pwd"}',
    headers: { 'Content-Type': 'application/json' },
    path: '/api/v2/workspace/execute',
  });
  assert.equal(response?.status, 200);
  assert.ok(calls.some((args) => args.includes('http://127.0.0.1:2000/api/v2/workspace/execute')));
  const execution = calls.find((args) =>
    args.includes('http://127.0.0.1:2000/api/v2/workspace/execute'),
  );
  assert.equal(execution?.includes('curl'), false);
  assert.equal(JSON.stringify(execution).includes('private-workspace-capability'), false);
  assert.equal(
    execution?.some((value) => value.includes('X-LibreChat-Workspace-Token')),
    true,
  );
});

test('docker runtime supervisor preserves the legacy profile digest for the default network', async () => {
  const image = 'example/code-runtime:latest';
  const legacyDigest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        image,
        profileRevision: null,
        restartStoppedContainers: true,
        capabilities: [],
        securityOptions: [],
        environment: [],
        bindMounts: [],
      }),
    )
    .digest('hex');
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        return `true|${legacyDigest}|sha256:image-1\n`;
      }
      if (args[0] === 'image' && args[1] === 'inspect') return 'sha256:image-1\n';
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ image, client });

  await supervisor.acquire(assignment('existing-workspace'));

  assert.equal(calls.some((args) => args[0] === 'container' && args[1] === 'rm'), false);
  assert.equal(calls.some((args) => args[0] === 'run'), false);
});

test('docker runtime supervisor applies an explicit macOS NsJail confinement profile', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('No such container');
      if (args[0] === 'run') return 'container-id\n';
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
    network: 'librechat-code-worker',
    capabilities: ['SYS_ADMIN', 'CHOWN'],
    securityOptions: ['seccomp=/repo/seccomp/nsjail.json'],
    environment: { SANDBOX_USE_CGROUPV2: 'false' },
    bindMounts: [{ source: '/repo/data/pkgs', target: '/pkgs', readOnly: true }],
    httpClient: 'bun',
  });

  await supervisor.acquire(assignment('rt-user-1'));

  const run = calls.find(args => args[0] === 'run') ?? [];
  assert.ok(run.includes('SYS_ADMIN'));
  assert.equal(run[run.indexOf('--network') + 1], 'librechat-code-worker');
  assert.ok(run.includes('CHOWN'));
  assert.ok(run.includes('seccomp=/repo/seccomp/nsjail.json'));
  assert.ok(run.includes('SANDBOX_USE_CGROUPV2=false'));
  assert.ok(run.includes('type=bind,source=/repo/data/pkgs,target=/pkgs,readonly'));
  assert.ok(
    run.indexOf('SANDBOX_USE_CGROUPV2=false') <
      run.indexOf('SANDBOX_SESSION_WORKSPACE_ENABLED=true'),
  );
  const health = calls.find(args => args[0] === 'exec') ?? [];
  assert.ok(health.includes('bun'));
});

test('docker runtime supervisor rejects relative bind mount paths', () => {
  assert.throws(
    () =>
      new DockerRuntimeSupervisor({
        image: 'example/code-runtime:latest',
        bindMounts: [{ source: './data/pkgs', target: '/pkgs', readOnly: true }],
      }),
    /absolute comma-free sources and targets/,
  );
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
  let profileDigest: string | undefined;
  let healthChecks = 0;
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!profileDigest) throw new Error('No such container');
        return `true|${profileDigest}|sha256:image-1\n`;
      }
      if (args[0] === 'image' && args[1] === 'inspect') return 'sha256:image-1\n';
      if (args[0] === 'run') {
        profileDigest = args
          .find(value => value.startsWith('com.librechat.code.profile-digest='))
          ?.split('=')[1];
        return 'container-id\n';
      }
      if (args[0] === 'exec' && healthChecks++ === 0) return '200';
      if (args[0] === 'exec') throw new Error('runner unavailable');
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
    startupTimeoutMs: 1,
  });

  await supervisor.acquire(assignment('rt-user-1'));
  await assert.rejects(supervisor.acquire(assignment('rt-user-1')), /did not become healthy/);
  assert.equal(calls.some(args => args[0] === 'container' && args[1] === 'rm'), false);
});

test('docker runtime supervisor reports state loss before recreating after profile drift', async () => {
  const calls: string[][] = [];
  let containerExists = true;
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!containerExists) throw new Error('No such container');
        return 'true|stale-profile|sha256:image-1\n';
      }
      if (args[0] === 'image' && args[1] === 'inspect') return 'sha256:image-1\n';
      if (args[0] === 'container' && args[1] === 'rm') {
        containerExists = false;
        return 'removed\n';
      }
      if (args[0] === 'run') {
        containerExists = true;
        return 'container-id\n';
      }
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    profileRevision: 'seccomp-v2',
    client,
  });

  await assert.rejects(
    supervisor.acquire(assignment('rt-user-1')),
    /workspace was discarded because its confinement profile or image changed/,
  );
  await supervisor.acquire(assignment('rt-user-1'));

  const removalIndex = calls.findIndex(args => args[0] === 'container' && args[1] === 'rm');
  const creationIndex = calls.findIndex(args => args[0] === 'run');
  assert.ok(removalIndex >= 0);
  assert.ok(creationIndex > removalIndex);
  assert.ok(
    calls[creationIndex]?.some(value =>
      value.startsWith('com.librechat.code.profile-digest='),
    ),
  );
});

test('docker runtime supervisor reports state loss before recreating after an image tag moves', async () => {
  const calls: string[][] = [];
  let profileDigest: string | undefined;
  let containerExists = false;
  let currentImageId = 'sha256:image-1';
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!containerExists) throw new Error('No such container');
        return `true|${profileDigest}|sha256:image-1\n`;
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return `${currentImageId}\n`;
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        containerExists = false;
        return 'removed\n';
      }
      if (args[0] === 'run') {
        profileDigest = args
          .find(value => value.startsWith('com.librechat.code.profile-digest='))
          ?.split('=')[1];
        containerExists = true;
        return 'container-id\n';
      }
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    client,
  });

  await supervisor.acquire(assignment('rt-user-1'));
  currentImageId = 'sha256:image-2';
  await assert.rejects(
    supervisor.acquire(assignment('rt-user-1')),
    /workspace was discarded because its confinement profile or image changed/,
  );
  await supervisor.acquire(assignment('rt-user-1'));

  assert.equal(
    calls.filter(args => args[0] === 'container' && args[1] === 'rm').length,
    1,
  );
  assert.equal(calls.filter(args => args[0] === 'run').length, 2);
});

test('docker runtime supervisor reports state loss instead of restarting tmpfs sessions', async () => {
  const calls: string[][] = [];
  let profileDigest: string | undefined;
  let containerExists = false;
  let running = false;
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!containerExists) throw new Error('No such container');
        return `${running}|${profileDigest}|sha256:image-1\n`;
      }
      if (args[0] === 'image' && args[1] === 'inspect') return 'sha256:image-1\n';
      if (args[0] === 'container' && args[1] === 'rm') {
        containerExists = false;
        return 'removed\n';
      }
      if (args[0] === 'run') {
        profileDigest = args
          .find(value => value.startsWith('com.librechat.code.profile-digest='))
          ?.split('=')[1];
        containerExists = true;
        running = true;
        return 'container-id\n';
      }
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerRuntimeSupervisor({
    image: 'example/code-runtime:latest',
    restartStoppedContainers: false,
    client,
  });

  await supervisor.acquire(assignment('rt-user-1'));
  running = false;
  await assert.rejects(
    supervisor.acquire(assignment('rt-user-1')),
    /workspace was discarded because its container stopped/,
  );
  await supervisor.acquire(assignment('rt-user-1'));

  assert.equal(calls.filter(args => args[0] === 'start').length, 0);
  assert.equal(
    calls.filter(args => args[0] === 'container' && args[1] === 'rm').length,
    1,
  );
  assert.equal(calls.filter(args => args[0] === 'run').length, 2);
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

test('docker runtime supervisor resets a workspace without a configured image', async () => {
  const client: ContainerRuntimeClient = {
    async run(args) {
      assert.deepEqual(args.slice(0, 3), ['container', 'rm', '--force']);
      return 'removed\n';
    },
  };
  const supervisor = new DockerRuntimeSupervisor({ client });

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
