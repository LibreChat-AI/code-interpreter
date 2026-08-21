import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import type { Runtime } from './runtime';
import type { SessionWorkspace } from './session-workspace';
import {
  HostedAppError,
  HostedAppSupervisor,
  type HostedAppDependencies,
  type HostedAppStartRequest,
} from './hosted-app';
import { config } from './config';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
}

const savedConfig = {
  port: config.hosted_app_port,
  start: config.hosted_app_start_timeout_ms,
  stop: config.hosted_app_stop_timeout_ms,
  logs: config.hosted_app_log_max_bytes,
};

let roots: string[] = [];

beforeEach(() => {
  config.hosted_app_port = 3123;
  config.hosted_app_start_timeout_ms = 25;
  config.hosted_app_stop_timeout_ms = 25;
  config.hosted_app_log_max_bytes = 64;
});

afterEach(async () => {
  config.hosted_app_port = savedConfig.port;
  config.hosted_app_start_timeout_ms = savedConfig.start;
  config.hosted_app_stop_timeout_ms = savedConfig.stop;
  config.hosted_app_log_max_bytes = savedConfig.logs;
  await Promise.all(roots.map(root => fsp.rm(root, { recursive: true, force: true })));
  roots = [];
});

async function workspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hosted-app-'));
  roots.push(root);
  await fsp.writeFile(path.join(root, 'server.js'), 'serve();');
  await fsp.mkdir(path.join(root, 'app'));
  return root;
}

function fakeRuntime(): Runtime {
  return {
    language: 'node',
    version: { raw: '22.0.0' } as Runtime['version'],
    aliases: [],
    pkgdir: '/pkgs/node/22',
    compiled: false,
    env_vars: { PATH: '/pkgs/node/22/bin:/usr/bin' },
    timeouts: { compile: 0, run: 0 },
    cpu_times: { compile: 0, run: 0 },
    memory_limits: { compile: 0, run: 0 },
    max_process_count: 64,
    max_open_files: 2048,
    max_file_size: 10_000_000,
    output_max_size: 1024,
  };
}

function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function request(overrides: Partial<HostedAppStartRequest> = {}): HostedAppStartRequest {
  return {
    app_id: 'demo',
    revision: 'rev-1',
    language: 'node',
    version: '>=22',
    entrypoint: 'server.js',
    ...overrides,
  };
}

function dependencies(
  root: string,
  options: {
    probe?: boolean;
    guardError?: Error;
  } = {},
): {
  deps: HostedAppDependencies;
  spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  guards: number[];
  cgroupKills: string[];
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
  children: FakeChild[];
} {
  const spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const guards: number[] = [];
  const cgroupKills: string[] = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const children: FakeChild[] = [];
  const getSession = () => ({
    ownership: async () => ({ dir: root, uid: 200123, gid: 200123 }),
  } as SessionWorkspace);
  const deps: HostedAppDependencies = {
    getSession,
    resolveRuntime: () => fakeRuntime(),
    spawnApp: ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      const child = fakeChild(4242 + children.length);
      children.push(child);
      return child as unknown as ReturnType<HostedAppDependencies['spawnApp']>;
    }) as HostedAppDependencies['spawnApp'],
    prepareCgroup: async () => {},
    killCgroup: async () => { cgroupKills.push('kill'); },
    installNetworkGuard: async uid => {
      guards.push(uid);
      if (options.guardError) throw options.guardError;
    },
    probePort: async () => options.probe ?? true,
    killProcessGroup: (pid, signal) => {
      kills.push({ pid, signal });
      const child = children.find(candidate => candidate.pid === pid);
      queueMicrotask(() => child?.emit('exit', null, signal));
    },
    now: () => new Date('2026-08-21T12:00:00.000Z'),
  };
  return { deps, spawns, guards, cgroupKills, kills, children };
}

describe('HostedAppSupervisor', () => {
  test('starts a runtime as the session UID with a curated fixed-port environment', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);

    const status = await supervisor.start(request({
      args: ['--production'],
      env: {
        APP_NAME: 'demo',
        HOME: '/attacker',
        port: '9999',
        HOST: 'attacker.invalid',
        LD_PRELOAD: '/tmp/evil.so',
      },
    }));

    expect(status).toMatchObject({
      app_id: 'demo',
      revision: 'rev-1',
      state: 'running',
      port: 3123,
      pid: 4242,
    });
    expect(fixture.guards).toEqual([200123]);
    expect(fixture.spawns).toHaveLength(1);
    const launch = fixture.spawns[0];
    expect(launch.command).toBe('/usr/local/bin/codeapi-hosted-app-launcher');
    const realRoot = await fsp.realpath(root);
    expect(launch.args).toEqual([
      '/sys/fs/cgroup/codeapi_hosted_app',
      '200123',
      '200123',
      '/bin/bash',
      '/pkgs/node/22/run',
      path.join(realRoot, 'server.js'),
      '--production',
    ]);
    expect(launch.options).toMatchObject({
      cwd: realRoot,
      detached: true,
    });
    expect(launch.options.env).toMatchObject({
      APP_NAME: 'demo',
      HOME: root,
      HOST: '0.0.0.0',
      PORT: '3123',
      PATH: '/pkgs/node/22/bin:/usr/bin',
    });
    expect(launch.options.env).not.toHaveProperty('port');
    expect(launch.options.env).not.toHaveProperty('LD_PRELOAD');
    await supervisor.shutdown();
  });

  test('is idempotent for the exact same immutable revision', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    const spec = request({ env: { B: '2', A: '1' } });

    const first = await supervisor.start(spec);
    const second = await supervisor.start(request({ env: { A: '1', B: '2' } }));

    expect(second).toEqual(first);
    expect(fixture.spawns).toHaveLength(1);
    await supervisor.shutdown();
  });

  test('rejects changed launch settings under an existing revision', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    const error = await supervisor.start(request({ args: ['changed'] })).catch(value => value);
    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_revision_conflict');
    expect(fixture.spawns).toHaveLength(1);
    await supervisor.shutdown();
  });

  test('stops the old process group before launching a new revision', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    const status = await supervisor.start(request({ revision: 'rev-2' }));

    expect(status.revision).toBe('rev-2');
    expect(fixture.kills).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    expect(fixture.cgroupKills.length).toBeGreaterThan(0);
    expect(fixture.spawns).toHaveLength(2);
    await supervisor.shutdown();
  });

  test('fails closed before spawning when the network guard cannot be installed', async () => {
    const root = await workspace();
    const fixture = dependencies(root, { guardError: new Error('iptables unavailable') });
    const supervisor = new HostedAppSupervisor(fixture.deps);

    const error = await supervisor.start(request()).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_isolation_failed');
    expect(fixture.spawns).toHaveLength(0);
  });

  test('rejects symlink entrypoints even when the target is a regular file', async () => {
    const root = await workspace();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hosted-app-outside-'));
    roots.push(outside);
    await fsp.writeFile(path.join(outside, 'outside.js'), 'steal();');
    await fsp.symlink(path.join(outside, 'outside.js'), path.join(root, 'linked.js'));
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);

    const error = await supervisor.start(request({ entrypoint: 'linked.js' })).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_path_escape');
    expect(fixture.guards).toHaveLength(0);
    expect(fixture.spawns).toHaveLength(0);
  });

  test('retains only the bounded tail of process logs', async () => {
    const root = await workspace();
    config.hosted_app_log_max_bytes = 8;
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    fixture.children[0].stdout.write('0123456789');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(supervisor.status()?.stdout).toBe('23456789');
    await supervisor.shutdown();
  });

  test('reaps the cgroup when the tracked parent exits unexpectedly', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    fixture.children[0].emit('exit', 1, null);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(supervisor.status()?.state).toBe('failed');
    expect(fixture.cgroupKills.length).toBeGreaterThan(0);
    await supervisor.shutdown();
  });
});
