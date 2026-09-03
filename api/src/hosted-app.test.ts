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
  prepareHostedAppRuntimeWorkspace,
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
  packages: config.packages_directory,
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
  config.packages_directory = savedConfig.packages;
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
    probePort?: () => Promise<boolean>;
    guardError?: Error;
    killCgroup?: () => Promise<void>;
    runtime?: Runtime;
    runtimes?: Runtime[];
  } = {},
): {
  deps: HostedAppDependencies;
  spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  guards: number[];
  cgroupKills: string[];
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
  children: FakeChild[];
  preparations: Array<{ runtime: Runtime; nodeModulesPath?: string }>;
} {
  const spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const guards: number[] = [];
  const cgroupKills: string[] = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const children: FakeChild[] = [];
  const preparations: Array<{ runtime: Runtime; nodeModulesPath?: string }> = [];
  const getSession = () => ({
    ownership: async () => ({ dir: root, uid: 200123, gid: 200123 }),
  } as SessionWorkspace);
  const deps: HostedAppDependencies = {
    getSession,
    resolveRuntime: () => options.runtime === undefined ? fakeRuntime() : options.runtime,
    listRuntimes: () => options.runtimes ?? [options.runtime ?? fakeRuntime()],
    prepareRuntimeWorkspace: async (_workspaceDir, runtime, nodeModulesPath) => {
      preparations.push({ runtime, nodeModulesPath });
    },
    spawnApp: ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      const child = fakeChild(4242 + children.length);
      children.push(child);
      return child as unknown as ReturnType<HostedAppDependencies['spawnApp']>;
    }) as HostedAppDependencies['spawnApp'],
    prepareCgroup: async () => {},
    killCgroup: async () => {
      cgroupKills.push('kill');
      await options.killCgroup?.();
    },
    installNetworkGuard: async uid => {
      guards.push(uid);
      if (options.guardError) throw options.guardError;
    },
    probePort: options.probePort ?? (async () => options.probe ?? true),
    killProcessGroup: (pid, signal) => {
      kills.push({ pid, signal });
      const child = children.find(candidate => candidate.pid === pid);
      queueMicrotask(() => child?.emit('exit', null, signal));
    },
    now: () => new Date('2026-08-21T12:00:00.000Z'),
  };
  return { deps, spawns, guards, cgroupKills, kills, children, preparations };
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

  test('gives Bash hosted apps access to curated packaged runtimes', async () => {
    const root = await workspace();
    const bash = {
      ...fakeRuntime(),
      language: 'bash',
      pkgdir: '/pkgs/bash/5',
      env_vars: { PATH: '/pkgs/bash/5/bin:/usr/bin' },
    };
    const node = {
      ...fakeRuntime(),
      env_vars: {
        PATH: '/pkgs/node/22/bin:/usr/bin',
        NODE_PATH: '/pkgs/node/22/node_modules',
      },
    };
    const fixture = dependencies(root, { runtime: bash, runtimes: [bash, node] });
    const supervisor = new HostedAppSupervisor(fixture.deps);

    await supervisor.start(request({ language: 'bash', version: '>=5' }));

    expect(fixture.spawns[0].options.env).toMatchObject({
      PATH: '/pkgs/node/22/bin:/pkgs/bash/5/bin:/usr/bin',
      NODE_PATH: '/pkgs/node/22/node_modules',
    });
    expect(fixture.preparations).toEqual([{
      runtime: bash,
      nodeModulesPath: '/pkgs/node/22/node_modules',
    }]);
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

  test('preserves revision immutability after stop and replacement', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());
    await supervisor.stop();

    const afterStop = await supervisor.start(request({ args: ['changed'] })).catch(value => value);
    expect(afterStop).toBeInstanceOf(HostedAppError);
    expect(afterStop.code).toBe('hosted_app_revision_conflict');

    await supervisor.start(request());
    await supervisor.start(request({ revision: 'rev-2' }));
    const afterReplacement = await supervisor.start(
      request({ args: ['changed'] }),
    ).catch(value => value);
    expect(afterReplacement).toBeInstanceOf(HostedAppError);
    expect(afterReplacement.code).toBe('hosted_app_revision_conflict');
    expect(fixture.spawns).toHaveLength(3);
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

  test('validates a replacement before stopping the running revision', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());
    fixture.deps.resolveRuntime = () => undefined;

    const error = await supervisor.start(request({ revision: 'rev-2' })).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_runtime_not_found');
    expect(supervisor.status()?.state).toBe('running');
    expect(fixture.kills).toEqual([]);
    await supervisor.shutdown();
  });

  test('does not report running when the child exits during its readiness probe', async () => {
    const root = await workspace();
    let finishProbe!: (ready: boolean) => void;
    const probe = new Promise<boolean>(resolve => { finishProbe = resolve; });
    const fixture = dependencies(root, { probePort: () => probe });
    const supervisor = new HostedAppSupervisor(fixture.deps);
    const started = supervisor.start(request());
    while (fixture.children.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    fixture.children[0].emit('exit', 1, null);
    finishProbe(true);
    const error = await started.catch(value => value);

    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_start_failed');
    expect(supervisor.status()?.state).toBe('failed');
  });

  test('serializes quiesced workspace access and rejects it while an app is running', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());
    let mutated = false;

    const error = await supervisor.withQuiescedWorkspace(async () => {
      mutated = true;
    }).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_workspace_busy');
    expect(mutated).toBe(false);
    await supervisor.shutdown();
  });

  test('links bundled JavaScript packages into the hosted workspace', async () => {
    const root = await workspace();
    const packages = await fsp.mkdtemp(path.join(os.tmpdir(), 'hosted-app-packages-'));
    roots.push(packages);
    config.packages_directory = packages;
    const packageRoot = path.join(packages, 'node', '22');
    await fsp.mkdir(path.join(packageRoot, 'node_modules'), { recursive: true });
    const runtime = { ...fakeRuntime(), pkgdir: packageRoot };

    await prepareHostedAppRuntimeWorkspace(root, runtime);

    expect(await fsp.realpath(path.join(root, 'node_modules'))).toBe(
      await fsp.realpath(path.join(packageRoot, 'node_modules')),
    );
  });

  test('refreshes a supervisor-managed package link for a new runtime', async () => {
    const root = await workspace();
    const packages = await fsp.mkdtemp(path.join(os.tmpdir(), 'hosted-app-packages-'));
    roots.push(packages);
    config.packages_directory = packages;
    const firstRoot = path.join(packages, 'node', '22');
    const secondRoot = path.join(packages, 'bun', '1');
    await fsp.mkdir(path.join(firstRoot, 'node_modules'), { recursive: true });
    await fsp.mkdir(path.join(secondRoot, 'node_modules'), { recursive: true });

    await prepareHostedAppRuntimeWorkspace(root, { ...fakeRuntime(), pkgdir: firstRoot });
    await prepareHostedAppRuntimeWorkspace(root, { ...fakeRuntime(), pkgdir: secondRoot });

    expect(await fsp.realpath(path.join(root, 'node_modules'))).toBe(
      await fsp.realpath(path.join(secondRoot, 'node_modules')),
    );
  });

  test('waits for confirmed cgroup cleanup before completing stop', async () => {
    const root = await workspace();
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const fixture = dependencies(root, { killCgroup: () => cleanupBlocked });
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    let stopped = false;
    const stopping = supervisor.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    releaseCleanup();
    await stopping;
    expect(stopped).toBe(true);
  });

  test('classifies a stop cleanup failure as a retryable server error', async () => {
    const root = await workspace();
    let permitCleanup = false;
    const fixture = dependencies(root, {
      killCgroup: async () => {
        if (!permitCleanup) throw new Error('cgroup remains populated');
      },
    });
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    const error = await supervisor.stop().catch(value => value);
    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_cleanup_failed');
    expect(error.status).toBe(503);

    permitCleanup = true;
    await supervisor.shutdown();
  });

  test('fails workspace mutation closed until a failed app cgroup is drained', async () => {
    const root = await workspace();
    let permitCleanup = false;
    const fixture = dependencies(root, {
      killCgroup: async () => {
        if (!permitCleanup) throw new Error('cgroup remains populated');
      },
    });
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());
    fixture.children[0].emit('exit', 1, null);
    await new Promise(resolve => setTimeout(resolve, 0));
    let mutated = false;

    const error = await supervisor.withQuiescedWorkspace(async () => {
      mutated = true;
    }).catch(value => value);
    expect(error).toBeInstanceOf(HostedAppError);
    expect(error.code).toBe('hosted_app_cleanup_failed');
    expect(mutated).toBe(false);

    permitCleanup = true;
    await supervisor.withQuiescedWorkspace(async () => { mutated = true; });
    expect(mutated).toBe(true);
  });

  test('skips queued exit cleanup after a replacement becomes active', async () => {
    const root = await workspace();
    const fixture = dependencies(root);
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());
    let releaseOwnership!: (value: { dir: string; uid: number; gid: number }) => void;
    const ownershipBlocked = new Promise<{ dir: string; uid: number; gid: number }>(
      resolve => { releaseOwnership = resolve; },
    );
    fixture.deps.getSession = () => ({
      ownership: () => ownershipBlocked,
    } as SessionWorkspace);

    const replacement = supervisor.start(request({ revision: 'rev-2' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.children[0].emit('exit', 1, null);
    releaseOwnership({ dir: root, uid: 200123, gid: 200123 });

    expect((await replacement).revision).toBe('rev-2');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(supervisor.status()?.state).toBe('running');
    expect(fixture.cgroupKills).toHaveLength(1);
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

  test('waits for unexpected-exit cleanup before launching a replacement revision', async () => {
    const root = await workspace();
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupCalls = 0;
    const fixture = dependencies(root, {
      killCgroup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) await cleanupBlocked;
      },
    });
    const supervisor = new HostedAppSupervisor(fixture.deps);
    await supervisor.start(request());

    fixture.children[0].emit('exit', 1, null);
    await Promise.resolve();
    const replacement = supervisor.start(request({ revision: 'rev-2' }));
    await Promise.resolve();
    expect(fixture.spawns).toHaveLength(1);

    releaseCleanup();
    expect((await replacement).revision).toBe('rev-2');
    expect(fixture.spawns).toHaveLength(2);
    await supervisor.shutdown();
  });
});
