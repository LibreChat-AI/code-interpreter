import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerFileRelaySupervisor } from './relay-runtime.js';

import type { ContainerRuntimeClient } from './runtime.js';

test('Docker file relay prepares a private runtime network and hardened dual-homed relay', async () => {
  const calls: string[][] = [];
  let staleRelay = '';
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'network' && args[1] === 'inspect') {
        throw new Error('network not found');
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        throw new Error('No such container');
      }
      if (args[0] === 'container' && args[1] === 'ls') return staleRelay;
      if (args[0] === 'container' && args[1] === 'rename') return '';
      if (args[0] === 'network' && args[1] === 'create') return 'network-id\n';
      if (args[0] === 'run') return 'relay-id\n';
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'incarnation-one',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    maxBytes: 20_000_000,
    timeoutMs: 45_000,
    maxConcurrentRequests: 4,
    client,
  });

  const profile = await supervisor.prepare();

  assert.match(profile.network, /^librechat-code-relay-/);
  assert.equal(profile.url, 'http://relay:3000');
  assert.equal(profile.token, 'relay-secret');
  const networkCreates = calls.filter(
    (args) => args[0] === 'network' && args[1] === 'create',
  );
  assert.equal(networkCreates.length, 2);
  assert.equal(networkCreates.filter((args) => args.includes('--internal')).length, 1);
  const run = calls.find((args) => args[0] === 'run') ?? [];
  const stagingRelay = run[run.indexOf('--name') + 1] ?? '';
  assert.match(stagingRelay, /^librechat-code-relay-.+-staging-[a-f0-9]{12}$/);
  assert.match(run[run.indexOf('--network') + 1] ?? '', /^librechat-code-egress-/);
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES=20000000'));
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS=45000'));
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS=4'));
  assert.ok(run.includes('ALL'));
  assert.ok(run.includes('no-new-privileges:true'));
  assert.equal(run.includes('--publish'), false);
  assert.equal(
    calls.some((args) => args[0] === 'network' && args[1] === 'connect'),
    false,
  );
  staleRelay = stagingRelay.replace('-staging-', '-g1-');
  await supervisor.activate(2);
  const rename = calls.find(
    (args) => args[0] === 'container' && args[1] === 'rename',
  );
  assert.match(rename?.at(-1) ?? '', /-g2-[a-f0-9]{12}$/);
  const connect = calls.find(
    (args) => args[0] === 'network' && args[1] === 'connect',
  );
  assert.ok(connect?.includes('--alias'));
  assert.ok(connect?.includes('relay'));
  assert.ok(connect?.includes(profile.network));
  const health = calls.find((args) => args[0] === 'exec') ?? [];
  assert.match(health.at(-1) ?? '', /^\d+$/);
  assert.ok(calls.indexOf(health) < calls.indexOf(connect ?? []));

  assert.ok(
    calls.some(
      (args) =>
        args[0] === 'container' &&
        args[1] === 'rm' &&
        args.includes(staleRelay),
    ),
  );
  const removalsBeforeStop = calls.filter(
    (args) => args[0] === 'container' && args[1] === 'rm',
  ).length;
  await supervisor.stop();
  assert.equal(
    calls.filter((args) => args[0] === 'container' && args[1] === 'rm').length,
    removalsBeforeStop + 1,
  );
});

test('Docker file relay fails closed when a reused runtime network is not internal', async () => {
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return 'false|true|runtime\n';
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'incarnation-two',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });

  await assert.rejects(supervisor.prepare(), /does not match its required profile/);
});

test('Docker file relay validates a network created by a concurrent incarnation', async () => {
  let runtimeInspections = 0;
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        const isRuntime = args.at(-1)?.includes('-relay-') === true;
        if (!isRuntime) return 'false|true|egress\n';
        runtimeInspections += 1;
        if (runtimeInspections === 1) throw new Error('network not found');
        return 'true|true|runtime\n';
      }
      if (args[0] === 'network' && args[1] === 'create') {
        throw new Error('network with name already exists');
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        throw new Error('No such container');
      }
      if (args[0] === 'run') return 'relay-id\n';
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'incarnation-three',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });

  await supervisor.prepare();

  assert.equal(runtimeInspections, 2);
});

test('Docker file relay rejects a delayed lower registration generation', async () => {
  const calls: string[][] = [];
  let currentRelay = '';
  let newerRelay = '';
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        return 'removed\n';
      }
      if (args[0] === 'run') {
        currentRelay = args[args.indexOf('--name') + 1] ?? '';
        newerRelay = currentRelay.replace(
          /-staging-[a-f0-9]{12}$/,
          '-g2-ffffffffffff',
        );
        return 'relay-id\n';
      }
      if (args[0] === 'container' && args[1] === 'rename') return '';
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'exec') return '200';
      if (args[0] === 'container' && args[1] === 'ls') return `${newerRelay}\n`;
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'older-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });
  await supervisor.prepare();

  await assert.rejects(
    supervisor.activate(1),
    /registration was superseded before activation/,
  );

  assert.ok(
    calls.some(
      (args) =>
        args[0] === 'container' &&
        args[1] === 'rm' &&
        args.includes(currentRelay.replace('-staging-', '-g1-')),
    ),
  );
  assert.equal(
    calls.some(
      (args) => args[0] === 'container' && args[1] === 'rm' && args.includes(newerRelay),
    ),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === 'network' && args[1] === 'connect'),
    false,
  );
});

test('Docker file relay handoff follows registration order instead of creation order', async () => {
  const containers = new Set<string>();
  const connected: string[] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        const name = args.at(-1) ?? '';
        if (!containers.delete(name)) throw new Error('No such container');
        return 'removed\n';
      }
      if (args[0] === 'run') {
        containers.add(args[args.indexOf('--name') + 1] ?? '');
        return 'relay-id\n';
      }
      if (args[0] === 'exec') return '200';
      if (args[0] === 'container' && args[1] === 'rename') {
        const previous = args.at(-2) ?? '';
        const next = args.at(-1) ?? '';
        if (!containers.delete(previous)) throw new Error('No such container');
        containers.add(next);
        return '';
      }
      if (args[0] === 'container' && args[1] === 'ls') {
        return `${Array.from(containers)
          .map((name) => `${name}|running|1000`)
          .join('\n')}\n`;
      }
      if (args[0] === 'network' && args[1] === 'connect') {
        const name = args.at(-1) ?? '';
        if (!containers.has(name)) throw new Error('No such container');
        connected.push(name);
        return '';
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const olderCreated = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'older-created-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    now: () => 1_000,
    client,
  });
  const newerCreated = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'newer-created-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    now: () => 1_000,
    client,
  });

  await olderCreated.prepare();
  await newerCreated.prepare();
  await newerCreated.activate(1);
  await olderCreated.activate(2);

  assert.equal(containers.size, 1);
  assert.match(Array.from(containers)[0] ?? '', /-g2-[a-f0-9]{12}$/);
  assert.match(connected[0] ?? '', /-g1-[a-f0-9]{12}$/);
  assert.match(connected[1] ?? '', /-g2-[a-f0-9]{12}$/);
});

test('Docker file relay reclaims stopped and expired staging containers', async () => {
  const removed: string[] = [];
  let staging = '';
  let listCalls = 0;
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        removed.push(args.at(-1) ?? '');
        return 'removed\n';
      }
      if (args[0] === 'run') {
        staging = args[args.indexOf('--name') + 1] ?? '';
        return 'relay-id\n';
      }
      if (args[0] === 'exec') return '200';
      if (args[0] === 'container' && args[1] === 'rename') return '';
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'container' && args[1] === 'ls') {
        listCalls += 1;
        if (listCalls === 1) return '';
        const prefix = staging.replace(/-staging-[a-f0-9]{12}$/, '-staging-');
        return [
          `${prefix}111111111111|exited|99000`,
          `${prefix}222222222222|running|1`,
          `${prefix}333333333333|running|99000`,
        ].join('\n');
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'current-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    stagingGraceMs: 10_000,
    now: () => 100_000,
    client,
  });

  await supervisor.prepare();
  await supervisor.activate(1);
  await supervisor.activate(1);

  assert.ok(removed.some((name) => name.endsWith('111111111111')));
  assert.ok(removed.some((name) => name.endsWith('222222222222')));
  assert.equal(removed.some((name) => name.endsWith('333333333333')), false);
});

test('Docker file relay relaunches an unhealthy active generation', async () => {
  let relay = '';
  let launches = 0;
  let healthChecks = 0;
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') return 'removed\n';
      if (args[0] === 'run') {
        launches += 1;
        relay = args[args.indexOf('--name') + 1] ?? '';
        return 'relay-id\n';
      }
      if (args[0] === 'exec') {
        healthChecks += 1;
        if (healthChecks === 2) throw new Error('container is not running');
        return '200';
      }
      if (args[0] === 'container' && args[1] === 'rename') {
        relay = args.at(-1) ?? '';
        return '';
      }
      if (args[0] === 'container' && args[1] === 'ls') {
        return `${relay}|running|1000\n`;
      }
      if (args[0] === 'network' && args[1] === 'connect') return '';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'recovering-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });

  await supervisor.prepare();
  await supervisor.activate(1);
  await supervisor.activate(1);

  assert.equal(launches, 2);
  assert.ok(healthChecks >= 3);
});

test('Docker file relay relaunches when its live staging container was reclaimed', async () => {
  let container = '';
  let launches = 0;
  let renameAttempts = 0;
  let connected = false;
  const client: ContainerRuntimeClient = {
    async run(args) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        const name = args.at(-1) ?? '';
        if (name !== container || container === '') {
          throw new Error('No such container');
        }
        container = '';
        return 'removed\n';
      }
      if (args[0] === 'run') {
        launches += 1;
        container = args[args.indexOf('--name') + 1] ?? '';
        return 'relay-id\n';
      }
      if (args[0] === 'exec') return '200';
      if (args[0] === 'container' && args[1] === 'rename') {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          container = '';
          throw new Error('No such container');
        }
        container = args.at(-1) ?? '';
        return '';
      }
      if (args[0] === 'container' && args[1] === 'ls') {
        return `${container}|running|1000\n`;
      }
      if (args[0] === 'network' && args[1] === 'connect') {
        connected = true;
        return '';
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'delayed-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });

  await supervisor.prepare();
  await supervisor.activate(2);

  assert.equal(launches, 2);
  assert.equal(renameAttempts, 2);
  assert.equal(connected, true);
  assert.match(container, /-g2-[a-f0-9]{12}$/);
});

test('Docker file relay rolls back startup with a fresh signal after abort', async () => {
  const controller = new AbortController();
  let currentRelay = '';
  let cleanupCalls = 0;
  let cleanupSignal: AbortSignal | undefined;
  const client: ContainerRuntimeClient = {
    async run(args, options) {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return args.at(-1)?.includes('-egress-') === true
          ? 'false|true|egress\n'
          : 'true|true|runtime\n';
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        if (args.includes(currentRelay)) {
          cleanupCalls += 1;
          cleanupSignal = options?.signal;
        }
        return 'removed\n';
      }
      if (args[0] === 'run') {
        currentRelay = args[args.indexOf('--name') + 1] ?? '';
        return 'relay-id\n';
      }
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'exec') {
        controller.abort(new Error('shutdown'));
        throw controller.signal.reason;
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    incarnationId: 'aborted-incarnation',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    startupTimeoutMs: 1,
    client,
  });

  await assert.rejects(supervisor.prepare(controller.signal), /shutdown/);

  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupSignal?.aborted ?? false, false);
});
