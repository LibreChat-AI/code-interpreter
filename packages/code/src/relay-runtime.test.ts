import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerFileRelaySupervisor } from './relay-runtime.js';

import type { ContainerRuntimeClient } from './runtime.js';

test('Docker file relay prepares a private runtime network and hardened dual-homed relay', async () => {
  const calls: string[][] = [];
  const client: ContainerRuntimeClient = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'network' && args[1] === 'inspect') {
        throw new Error('network not found');
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        throw new Error('No such container');
      }
      if (args[0] === 'network' && args[1] === 'create') return 'network-id\n';
      if (args[0] === 'run') return 'relay-id\n';
      if (args[0] === 'network' && args[1] === 'connect') return '';
      if (args[0] === 'exec') return '200';
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  const supervisor = new DockerFileRelaySupervisor({
    workerId: 'engineering-vm',
    image: 'librechat-code-worker:local',
    upstreamUrl: 'https://code.example/egress',
    token: 'relay-secret',
    client,
  });

  const profile = await supervisor.prepare();

  assert.match(profile.network, /^librechat-code-relay-/);
  assert.equal(profile.url, 'http://relay:3000');
  assert.equal(profile.token, 'relay-secret');
  const networkCreate = calls.find(
    (args) => args[0] === 'network' && args[1] === 'create',
  );
  assert.ok(networkCreate?.includes('--internal'));
  const run = calls.find((args) => args[0] === 'run') ?? [];
  assert.equal(run[run.indexOf('--network') + 1], 'bridge');
  assert.ok(run.includes('ALL'));
  assert.ok(run.includes('no-new-privileges:true'));
  assert.equal(run.includes('--publish'), false);
  const connect = calls.find(
    (args) => args[0] === 'network' && args[1] === 'connect',
  );
  assert.ok(connect?.includes('--alias'));
  assert.ok(connect?.includes('relay'));
  assert.ok(connect?.includes(profile.network));
});
