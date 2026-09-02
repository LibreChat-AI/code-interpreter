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
  const currentRelay = run[run.indexOf('--name') + 1] ?? '';
  assert.match(currentRelay, /^librechat-code-relay-.+-[a-f0-9]{12}$/);
  assert.match(run[run.indexOf('--network') + 1] ?? '', /^librechat-code-egress-/);
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES=20000000'));
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS=45000'));
  assert.ok(run.includes('LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS=4'));
  assert.ok(run.includes('ALL'));
  assert.ok(run.includes('no-new-privileges:true'));
  assert.equal(run.includes('--publish'), false);
  const connect = calls.find(
    (args) => args[0] === 'network' && args[1] === 'connect',
  );
  assert.ok(connect?.includes('--alias'));
  assert.ok(connect?.includes('relay'));
  assert.ok(connect?.includes(profile.network));
  const health = calls.find((args) => args[0] === 'exec') ?? [];
  assert.match(health.at(-1) ?? '', /^\d+$/);

  staleRelay = `${currentRelay}-stale`;
  await supervisor.pruneStale();
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
