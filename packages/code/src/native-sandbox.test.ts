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

function fakeManager(
  options: {
    dependencyErrors?: string[];
    beforeWrap?: () => Promise<void>;
    appendGitSafeDirectory?: boolean;
  } = {},
) {
  let config: SandboxRuntimeConfig | undefined;
  let reset = false;
  let credentialSeenDuringWrap: string | undefined;
  let gitLfsRequiredSeenDuringWrap: string | undefined;
  const manager = {
    isSupportedPlatform: () => true,
    async checkDependenciesAsync() {
      return { warnings: [], errors: options.dependencyErrors ?? [] };
    },
    async initialize(value: SandboxRuntimeConfig) {
      config = value;
    },
    async wrapWithSandboxArgv(command: string) {
      await options.beforeWrap?.();
      credentialSeenDuringWrap = process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
      gitLfsRequiredSeenDuringWrap = process.env.GIT_CONFIG_VALUE_3;
      const ambientGitEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) => name.startsWith('GIT_CONFIG_') && value != null,
        ),
      );
      let gitEnvironment = ambientGitEnvironment;
      if (options.appendGitSafeDirectory) {
        const index = Number(ambientGitEnvironment.GIT_CONFIG_COUNT ?? '0');
        gitEnvironment = {
          GIT_CONFIG_COUNT: String(index + 1),
          [`GIT_CONFIG_KEY_${index}`]: 'safe.directory',
          [`GIT_CONFIG_VALUE_${index}`]: '/workspace',
        };
      }
      return {
        argv: ['/bin/bash', '-c', command],
        env: {
          PATH: process.env.PATH,
          ...gitEnvironment,
          ...(credentialSeenDuringWrap
            ? {
                LIBRECHAT_CODE_TEST_CREDENTIAL:
                  'Authorization: Bearer srt-sentinel',
              }
            : {}),
        },
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
    get credentialSeenDuringWrap() {
      return credentialSeenDuringWrap;
    },
    get gitLfsRequiredSeenDuringWrap() {
      return gitLfsRequiredSeenDuringWrap;
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
      lc_api_token: 'lowercase-secret',
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
  assert.ok(denied?.includes('Path'));
  assert.ok(denied?.includes('lc_api_token'));
  await sandbox.close();
  assert.equal(fake.reset, true);
});

test('masks a host credential for only its injection host and restores the parent environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager();
  const original = process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
  delete process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
  t.after(() => {
    if (original === undefined)
      delete process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
    else process.env.LIBRECHAT_CODE_TEST_CREDENTIAL = original;
  });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    allowedDomains: ['github.com'],
    maskedEnvironment: {
      variables: [
        {
          name: 'LIBRECHAT_CODE_TEST_CREDENTIAL',
          extract: '^Authorization: Bearer (.+)$',
          injectHosts: ['github.com'],
        },
      ],
      async resolve() {
        return {
          LIBRECHAT_CODE_TEST_CREDENTIAL: 'Authorization: Bearer real-secret',
        };
      },
    },
    manager: fake.manager,
  });

  const result = await sandbox.execute({
    ...request,
    command: 'printf %s "$LIBRECHAT_CODE_TEST_CREDENTIAL"',
  });

  assert.equal(
    fake.credentialSeenDuringWrap,
    'Authorization: Bearer real-secret',
  );
  assert.equal(result.stdout, 'Authorization: Bearer srt-sentinel');
  assert.equal(process.env.LIBRECHAT_CODE_TEST_CREDENTIAL, undefined);
  assert.deepEqual(fake.config?.network.tlsTerminate, {});
  assert.deepEqual(fake.config?.credentials?.envVars?.at(-1), {
    name: 'LIBRECHAT_CODE_TEST_CREDENTIAL',
    extract: '^Authorization: Bearer (.+)$',
    injectHosts: ['github.com'],
    mode: 'mask',
    onExtractNoMatch: 'error',
  });
});

test('serializes credential handoff across concurrent sandbox instances', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
  delete process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
  t.after(() => {
    if (original === undefined)
      delete process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
    else process.env.LIBRECHAT_CODE_TEST_CREDENTIAL = original;
  });
  let firstEntered!: () => void;
  const firstEnteredPromise = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;
  const first = fakeManager({
    async beforeWrap() {
      firstEntered();
      await firstGate;
    },
  });
  const second = fakeManager({
    async beforeWrap() {
      secondEntered = true;
    },
  });
  const sandbox = (
    manager: ReturnType<typeof fakeManager>['manager'],
    value: string,
  ) =>
    new NativeSrtWorkspaceCommandSandbox({
      workspaceRoot: root,
      allowedDomains: ['github.com'],
      maskedEnvironment: {
        variables: [
          {
            name: 'LIBRECHAT_CODE_TEST_CREDENTIAL',
            injectHosts: ['github.com'],
          },
        ],
        async resolve() {
          return { LIBRECHAT_CODE_TEST_CREDENTIAL: value };
        },
      },
      manager,
    });

  const firstExecution = sandbox(first.manager, 'first-secret').execute(
    request,
  );
  await firstEnteredPromise;
  const secondExecution = sandbox(second.manager, 'second-secret').execute(
    request,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  releaseFirst();
  await firstExecution;
  await secondExecution;

  assert.equal(first.credentialSeenDuringWrap, 'first-secret');
  assert.equal(second.credentialSeenDuringWrap, 'second-secret');
  assert.equal(process.env.LIBRECHAT_CODE_TEST_CREDENTIAL, undefined);
});

test('isolates Git from host-level global and system configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  const result = await sandbox.execute({
    ...request,
    command: 'printf "%s|%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM"',
  });

  assert.equal(result.stdout, '/dev/null|1');
});

test('restores trusted Git LFS filters without reading host Git configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager({ appendGitSafeDirectory: true });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    environment: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'include.path',
      GIT_CONFIG_VALUE_0: '/untrusted/host-config',
    },
    manager: fake.manager,
  });

  const result = await sandbox.execute({
    ...request,
    maxOutputBytes: 256,
    command:
      'printf "%s|%s|%s|%s|%s" "$(git config --get filter.lfs.clean)" "$(git config --get filter.lfs.smudge)" "$(git config --get filter.lfs.process)" "$(git config --get filter.lfs.required)" "$(git config --get safe.directory)"',
  });

  assert.equal(
    result.stdout,
    'git-lfs clean -- %f|git-lfs smudge -- %f|git-lfs filter-process|true|/workspace',
  );
  assert.equal(fake.gitLfsRequiredSeenDuringWrap, 'true');
  const denied = fake.config?.credentials?.envVars?.map(({ name }) => name);
  assert.ok(!denied?.includes('GIT_CONFIG_COUNT'));
  assert.ok(!denied?.includes('GIT_CONFIG_KEY_0'));
  assert.ok(!denied?.includes('GIT_CONFIG_VALUE_0'));
});

test('filters environment names case-insensitively only on Windows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager();
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    platform: 'win32',
    environment: {
      PATH: '/usr/bin',
      Path: 'C:\\Windows\\System32',
      LC_API_TOKEN: 'secret',
      librechat_code_worker_token: 'secret',
    },
    manager: fake.manager,
  });

  await sandbox.prepare();
  const denied = fake.config?.credentials?.envVars?.map(({ name }) => name);
  assert.ok(!denied?.includes('PATH'));
  assert.ok(!denied?.includes('Path'));
  assert.ok(!denied?.includes('LC_API_TOKEN'));
  assert.ok(denied?.includes('librechat_code_worker_token'));
});

test('fails closed when the configured POSIX shell is unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    platform: 'linux',
    shellPath: join(root, 'missing-bash'),
    manager: fakeManager().manager,
  });

  await assert.rejects(
    sandbox.prepare(),
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'COMMAND_UNAVAILABLE' &&
      /shell is unavailable/i.test(error.message),
  );
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
