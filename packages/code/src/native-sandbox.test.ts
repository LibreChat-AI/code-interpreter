import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import { WorkspaceToolError } from './workspace.js';

const request = {
  protocolVersion: 1 as const,
  operation: 'execute_command' as const,
  workspaceId: 'primary',
  command: 'printf hello',
  timeoutMs: 1_000,
  maxOutputBytes: 64,
};

function fakeManager(options: { dependencyErrors?: string[] } = {}) {
  let config: SandboxRuntimeConfig | undefined;
  let reset = false;
  const manager = {
    isSupportedPlatform: () => true,
    async checkDependenciesAsync() {
      return { warnings: [], errors: options.dependencyErrors ?? [] };
    },
    async initialize(value: SandboxRuntimeConfig) {
      config = value;
    },
    async wrapWithSandboxArgv(command: string) {
      return {
        argv: ['/bin/bash', '-c', command],
        env: { PATH: process.env.PATH },
      };
    },
    annotateStderrWithSandboxFailures(_commandId: string, stderr: string) {
      return stderr;
    },
    cleanupAfterCommand() {},
    async reset() {
      reset = true;
    },
  };
  return {
    manager,
    get config() {
      return config;
    },
    get reset() {
      return reset;
    },
  };
}

test('initializes SRT with a default-deny network and scrubbed worker credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  const identity = join(tmpdir(), 'librechat-code-identity.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager();
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    protectedPaths: [identity],
    environment: {
      PATH: '/usr/bin',
      Path: '/windows/system32',
      LANG: 'en_US.UTF-8',
      LIBRECHAT_CODE_WORKER_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    },
    manager: fake.manager,
  });

  await sandbox.prepare();
  const canonicalRoot = await realpath(root);
  const canonicalIdentity = await realpath(identity).catch(async () =>
    join(await realpath(tmpdir()), 'librechat-code-identity.json'),
  );
  const canonicalHome = await realpath(homedir());
  assert.deepEqual(fake.config?.network.allowedDomains, []);
  assert.equal(fake.config?.network.strictAllowlist, true);
  assert.equal(fake.config?.network.allowAllUnixSockets, false);
  assert.deepEqual(fake.config?.filesystem.allowRead, [canonicalRoot]);
  assert.deepEqual(fake.config?.filesystem.allowWrite, [canonicalRoot]);
  assert.ok(fake.config?.filesystem.denyRead.includes(canonicalHome));
  assert.ok(fake.config?.filesystem.denyWrite.includes(canonicalIdentity));
  const denied = fake.config?.credentials?.envVars?.map(({ name }) => name);
  assert.ok(denied?.includes('LIBRECHAT_CODE_WORKER_TOKEN'));
  assert.ok(denied?.includes('AWS_SECRET_ACCESS_KEY'));
  assert.ok(!denied?.includes('PATH'));
  assert.ok(!denied?.includes('Path'));
  await sandbox.close();
  assert.equal(fake.reset, true);
});

test('fails closed when SRT dependencies are unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager({ dependencyErrors: ['bubblewrap missing'] });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fake.manager,
  });

  await assert.rejects(
    sandbox.prepare(),
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'COMMAND_UNAVAILABLE' &&
      /bubblewrap missing/.test(error.message),
  );
});

test('refuses workspace roots that expose worker home or control files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  const controlDirectory = join(root, '.control');
  await mkdir(controlDirectory);
  const controlFile = join(controlDirectory, 'identity.json');
  await writeFile(controlFile, '{}');
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    new NativeSrtWorkspaceCommandSandbox({
      workspaceRoot: homedir(),
      manager: fakeManager().manager,
    }).prepare(),
    /cannot contain the worker home directory/i,
  );
  await assert.rejects(
    new NativeSrtWorkspaceCommandSandbox({
      workspaceRoot: root,
      protectedPaths: [controlFile],
      manager: fakeManager().manager,
    }).prepare(),
    /cannot contain worker control files/i,
  );
});

test('executes in the canonical workspace and bounds aggregate output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  await mkdir(join(root, 'src'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  assert.equal(sandbox.mutationFailuresAreAtomic, true);
  assert.deepEqual(
    await sandbox.execute({
      ...request,
      command: "printf '1234567890'; printf 'abcdefghij' >&2",
      cwd: 'src',
      maxOutputBytes: 12,
    }),
    {
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'primary',
      exitCode: 0,
      stdout: '1234567890',
      stderr: 'ab',
      truncated: true,
      timedOut: false,
    },
  );
});

test('rejects an escaping or unavailable command working directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  await assert.rejects(
    sandbox.execute({ ...request, cwd: '..' }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('terminates detached command descendants before returning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  const result = await sandbox.execute({
    ...request,
    command: '(sleep 0.2; printf late > late.txt) >/dev/null 2>&1 &',
  });
  assert.equal(result.exitCode, 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(access(join(root, 'late.txt')));
});

test('reports cancellation after command start as a potentially committed mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });
  const controller = new AbortController();
  const execution = sandbox.execute(
    { ...request, command: 'sleep 30' },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'EXECUTION_ABORTED' &&
      error.mutationMayHaveCommitted === true,
  );
});

test('closes stdin immediately when the command protocol provides no input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  const result = await sandbox.execute({
    ...request,
    command: 'cat',
    timeoutMs: 250,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('maps platform-native exit statuses into the bridge protocol range', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnCommand = () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    queueMicrotask(() => child.emit('close', 300, null));
    return child;
  };
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
    spawnCommand,
  });

  const result = await sandbox.execute(request);
  assert.equal(result.exitCode, 1);
});
