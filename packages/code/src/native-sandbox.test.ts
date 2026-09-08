import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
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
    inheritedGitEnvironment?: Record<string, string>;
    initializeError?: Error;
    wrappedEnvironment?: NodeJS.ProcessEnv;
  } = {},
) {
  let config: SandboxRuntimeConfig | undefined;
  let reset = false;
  let credentialSeenDuringWrap: string | undefined;
  let gitLfsRequiredSeenDuringWrap: string | undefined;
  let scratchSelectorSeenDuringWrap: string | undefined;
  const manager = {
    isSupportedPlatform: () => true,
    async checkDependenciesAsync() {
      return { warnings: [], errors: options.dependencyErrors ?? [] };
    },
    async initialize(value: SandboxRuntimeConfig) {
      config = value;
      if (options.initializeError) throw options.initializeError;
    },
    async wrapWithSandboxArgv(command: string) {
      await options.beforeWrap?.();
      credentialSeenDuringWrap = process.env.LIBRECHAT_CODE_TEST_CREDENTIAL;
      gitLfsRequiredSeenDuringWrap = process.env.GIT_CONFIG_VALUE_3;
      scratchSelectorSeenDuringWrap = process.env.CLAUDE_CODE_TMPDIR;
      const ambientGitEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) => name.startsWith('GIT_CONFIG_') && value != null,
        ),
      );
      let gitEnvironment = ambientGitEnvironment;
      if (options.appendGitSafeDirectory) {
        const index = Number(ambientGitEnvironment.GIT_CONFIG_COUNT ?? '0');
        gitEnvironment = {
          ...(options.inheritedGitEnvironment ?? {}),
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
          ...options.wrappedEnvironment,
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
    get scratchSelectorSeenDuringWrap() {
      return scratchSelectorSeenDuringWrap;
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
  const scratchDirectory = fake.config?.filesystem.allowWrite[1];
  assert.equal(typeof scratchDirectory, 'string');
  assert.deepEqual(fake.config?.network.allowedDomains, []);
  assert.equal(fake.config?.network.strictAllowlist, true);
  assert.equal(fake.config?.network.allowAllUnixSockets, false);
  assert.deepEqual(fake.config?.filesystem.allowRead, [
    canonicalRoot,
    scratchDirectory,
  ]);
  assert.deepEqual(fake.config?.filesystem.allowWrite, [
    canonicalRoot,
    scratchDirectory,
  ]);
  assert.equal((await stat(scratchDirectory!)).mode & 0o777, 0o700);
  assert.ok(fake.config?.filesystem.denyRead.includes(canonicalHome));
  assert.ok(fake.config?.filesystem.denyWrite.includes(canonicalIdentity));
  assert.ok(
    fake.config?.filesystem.denyWrite.some((path) =>
      path.endsWith('/tmp/claude'),
    ),
  );
  const denied = fake.config?.credentials?.envVars?.map(({ name }) => name);
  assert.ok(denied?.includes('LIBRECHAT_CODE_WORKER_TOKEN'));
  assert.ok(denied?.includes('AWS_SECRET_ACCESS_KEY'));
  assert.ok(!denied?.includes('PATH'));
  assert.ok(denied?.includes('Path'));
  assert.ok(denied?.includes('lc_api_token'));
  assert.ok(denied?.includes('CLAUDE_CODE_TMPDIR'));
  assert.ok(denied?.includes('CLAUDE_TMPDIR'));
  await sandbox.close();
  assert.equal(fake.reset, true);
  await assert.rejects(access(scratchDirectory!));
});

test('provides an isolated scratch directory to commands and restores the host environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalTmpdir = process.env.TMPDIR;
  const originalSrtTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  const originalLegacySrtTmpdir = process.env.CLAUDE_TMPDIR;
  const fake = fakeManager();
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fake.manager,
  });

  const result = await sandbox.execute({
    ...request,
    maxOutputBytes: 1_024,
    command: 'touch "$TMPDIR/probe" && printf %s "$TMPDIR"',
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /librechat-code-srt-/);
  await access(join(result.stdout, 'probe'));
  assert.equal(fake.scratchSelectorSeenDuringWrap, result.stdout);
  assert.equal(process.env.TMPDIR, originalTmpdir);
  assert.equal(process.env.CLAUDE_CODE_TMPDIR, originalSrtTmpdir);
  assert.equal(process.env.CLAUDE_TMPDIR, originalLegacySrtTmpdir);
  await sandbox.close();
  await assert.rejects(access(result.stdout));
});

test('removes scratch storage when SRT initialization fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeManager({ initializeError: new Error('init failed') });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fake.manager,
  });

  await assert.rejects(sandbox.prepare(), /init failed/);
  const scratchDirectory = fake.config?.filesystem.allowWrite[1];
  assert.equal(typeof scratchDirectory, 'string');
  await assert.rejects(access(scratchDirectory!));
  assert.equal(fake.reset, true);
});

test('rejects workspaces nested inside SRT shared scratch storage', async (t) => {
  if (process.platform === 'win32') return;
  const sharedRoot = '/tmp/claude';
  await mkdir(sharedRoot, { recursive: true });
  const root = await mkdtemp(join(sharedRoot, 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  await assert.rejects(
    sandbox.prepare(),
    (error: WorkspaceToolError) =>
      error.code === 'REGISTRATION_INVALID' &&
      /inherited writable path/.test(error.message),
  );
});

test('rejects a workspace that contains worker scratch storage', async () => {
  if (process.platform === 'win32') return;
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: tmpdir(),
    manager: fakeManager().manager,
  });

  await assert.rejects(
    sandbox.prepare(),
    (error: WorkspaceToolError) =>
      error.code === 'REGISTRATION_INVALID' &&
      /contain worker scratch storage/.test(error.message),
  );
  await sandbox.close();
});

test('keeps concurrent sandbox scratch directories independent', async (t) => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(firstRoot, { recursive: true, force: true }));
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  let releaseWrap!: () => void;
  let wrapStarted!: () => void;
  const wrapStartedPromise = new Promise<void>((resolve) => {
    wrapStarted = resolve;
  });
  const holdWrap = new Promise<void>((resolve) => {
    releaseWrap = resolve;
  });
  const firstFake = fakeManager({
    async beforeWrap() {
      wrapStarted();
      await holdWrap;
    },
  });
  const secondFake = fakeManager();
  const firstSandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: firstRoot,
    manager: firstFake.manager,
  });
  const secondSandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: secondRoot,
    manager: secondFake.manager,
  });
  const firstExecution = firstSandbox.execute({
    ...request,
    command: 'printf first',
  });
  await wrapStartedPromise;
  await secondSandbox.prepare();
  const firstScratch = firstFake.config?.filesystem.allowWrite[1];
  const secondScratch = secondFake.config?.filesystem.allowWrite[1];
  assert.equal(typeof firstScratch, 'string');
  assert.equal(typeof secondScratch, 'string');
  assert.notEqual(firstScratch, secondScratch);
  assert.ok(!secondScratch!.startsWith(`${firstScratch}/`));
  releaseWrap();
  await firstExecution;
  await firstSandbox.close();
  await access(secondScratch!);
  await secondSandbox.close();
});

test('removes scratch storage after a command revokes traversal permissions', async (t) => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
  });

  const result = await sandbox.execute({
    ...request,
    command:
      'printf %s "$TMPDIR"; mkdir "$TMPDIR/locked"; touch "$TMPDIR/locked/file"; chmod 000 "$TMPDIR/locked" "$TMPDIR"',
  });

  assert.equal(result.exitCode, 0);
  await sandbox.close();
  await assert.rejects(access(result.stdout));
});

const proxyEnvironment = {
  HTTP_PROXY: 'http://upstream.invalid:8080',
  HTTPS_PROXY: 'http://upstream.invalid:8080',
  ALL_PROXY: 'socks5://upstream.invalid:1080',
  NO_PROXY: 'upstream.internal',
  http_proxy: 'http://upstream.invalid:8080',
  https_proxy: 'http://upstream.invalid:8080',
  all_proxy: 'socks5://upstream.invalid:1080',
  no_proxy: 'upstream.internal',
};
const windowsEnvironment = {
  SYSTEMROOT: 'C:\\Windows',
  SystemRoot: 'C:\\Windows',
  SYSTEMDRIVE: 'C:',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TEMP: 'C:\\Temp',
  Temp: 'C:\\Temp',
  TMP: 'C:\\Temp',
  USERPROFILE: 'C:\\Users\\sandbox',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\sandbox',
  APPDATA: 'C:\\Users\\sandbox\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\sandbox\\AppData\\Local',
};

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`preserves required ${platform} environment names without allowing credentials`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fake = fakeManager();
    const credentials = {
      LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
      LIBRECHAT_CODE_HTTP_PROXY: 'worker-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'github-secret',
      HTTP_PROXY_TOKEN: 'proxy-secret',
      CUSTOM_PROXY: 'proxy-secret',
      SYSTEMROOT_TOKEN: 'runtime-secret',
      NODE_OPTIONS: '--require /host/private.js',
      LD_PRELOAD: '/host/private.so',
    };
    const sandbox = new NativeSrtWorkspaceCommandSandbox({
      workspaceRoot: root, platform, allowedDomains: ['github.com'],
      environment: {
        ...proxyEnvironment, ...windowsEnvironment, ...credentials,
        HtTp_PrOxY: 'http://mixed-case.invalid:8080',
        PATH: '/usr/bin', LC_ALL: 'C.UTF-8',
      },
      manager: fake.manager,
    });
    t.after(() => sandbox.close());
    await sandbox.prepare();
    const denied = new Set(fake.config?.credentials?.envVars
      ?.filter(({ mode }) => mode === 'deny').map(({ name }) => name));
    for (const name of [...Object.keys(proxyEnvironment), 'PATH', 'LC_ALL']) {
      assert.equal(denied.has(name), false, `${name} must remain available`);
    }
    for (const name of Object.keys(windowsEnvironment)) {
      assert.equal(denied.has(name), platform !== 'win32', `${name} must be platform-specific`);
    }
    assert.equal(denied.has('HtTp_PrOxY'), platform !== 'win32');
    for (const name of Object.keys(credentials)) {
      assert.equal(denied.has(name), true, `${name} must remain denied`);
    }
    assert.deepEqual(fake.config?.network.allowedDomains, ['github.com']);
    assert.equal(fake.config?.network.strictAllowlist, true);
  });
}

test('uses SRT proxy values without restoring inherited proxies or credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrappedEnvironment = {
    HTTP_PROXY: 'http://localhost:3128', HTTPS_PROXY: 'http://localhost:3128',
    ALL_PROXY: 'http://localhost:3128', NO_PROXY: 'localhost',
  };
  const fake = fakeManager({ wrappedEnvironment });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    environment: { ...proxyEnvironment, GITHUB_TOKEN: 'host-secret' },
    manager: fake.manager,
  });
  t.after(() => sandbox.close());
  const result = await sandbox.execute({
    ...request, maxOutputBytes: 256,
    command: 'printf "%s|%s|%s|%s|%s" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY" "$NO_PROXY" "${GITHUB_TOKEN-unset}"',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${Object.values(wrappedEnvironment).join('|')}|unset`);
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
  const fake = fakeManager({
    appendGitSafeDirectory: true,
    inheritedGitEnvironment: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'include.path',
      GIT_CONFIG_VALUE_0: '/untrusted/host-config',
    },
  });
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
      'printf "%s|%s|%s|%s|%s|%s" "$(git config --get filter.lfs.clean)" "$(git config --get filter.lfs.smudge)" "$(git config --get filter.lfs.process)" "$(git config --get filter.lfs.required)" "$(git config --get safe.directory)" "$(git config --get include.path)"',
  });

  assert.equal(
    result.stdout,
    'git-lfs clean -- %f|git-lfs smudge -- %f|git-lfs filter-process|true|/workspace|',
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
      librechat_code_github_authorization: 'secret',
      git_config_count: '1',
    },
    maskedEnvironment: {
      variables: [
        {
          name: 'LIBRECHAT_CODE_GITHUB_AUTHORIZATION',
          injectHosts: ['github.com'],
        },
      ],
      async resolve() {
        return {};
      },
    },
    manager: fake.manager,
  });

  await sandbox.prepare();
  const denied = fake.config?.credentials?.envVars?.map(({ name }) => name);
  assert.ok(!denied?.includes('PATH'));
  assert.ok(!denied?.includes('Path'));
  assert.ok(!denied?.includes('LC_API_TOKEN'));
  assert.ok(denied?.includes('librechat_code_worker_token'));
  assert.ok(!denied?.includes('librechat_code_github_authorization'));
  assert.ok(!denied?.includes('git_config_count'));
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
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    manager: fakeManager().manager,
    spawnCommand(command, args, options) {
      const child = spawn(command, [...args], options);
      commandStarted();
      return child;
    },
  });
  const controller = new AbortController();
  const execution = sandbox.execute(
    { ...request, command: 'sleep 30' },
    controller.signal,
  );
  await commandStartedPromise;
  controller.abort();

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

test('cleans allocated command state exactly once on every execution exit', async (t) => {
  for (const outcome of [
    'abort-before-spawn',
    'spawn-throw',
    'close',
    'error',
    'abort-after-spawn',
    'timeout',
    'wrap-throw',
  ] as const) {
    for (const cleanupThrows of [false, true]) {
      await t.test(`${outcome}, cleanup throws: ${cleanupThrows}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'librechat-code-native-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const controller = new AbortController();
        let cleanupCalls = 0;
        let spawnCalls = 0;
        let allocated = false;
        const fake = fakeManager({
          async beforeWrap() {
            if (outcome === 'wrap-throw') throw new Error('wrap failed');
            allocated = true;
            if (outcome === 'abort-before-spawn') controller.abort();
          },
        });
        fake.manager.cleanupAfterCommand = () => {
          cleanupCalls += 1;
          assert.equal(allocated, true);
          allocated = false;
          if (cleanupThrows) throw new Error('cleanup failed');
        };
        const sandbox = new NativeSrtWorkspaceCommandSandbox({
          workspaceRoot: root,
          manager: fake.manager,
          spawnCommand() {
            spawnCalls += 1;
            assert.equal(allocated, true);
            if (outcome === 'spawn-throw') throw new Error('spawn failed');
            const child = new EventEmitter() as ChildProcessWithoutNullStreams;
            let closeQueued = false;
            const close = () => {
              if (!closeQueued) {
                closeQueued = true;
                queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
              }
              return true;
            };
            Object.assign(child, {
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              stderr: new PassThrough(),
              pid: undefined,
              kill: close,
            });
            queueMicrotask(() => {
              assert.equal(cleanupCalls, 0);
              if (outcome === 'error') {
                child.emit('error', new Error('spawn failed'));
              } else if (outcome === 'abort-after-spawn') {
                controller.abort();
              } else if (outcome === 'close') {
                child.emit('close', 0, null);
              }
            });
            return child;
          },
        });
        const execution = sandbox.execute(
          { ...request, timeoutMs: 10 },
          controller.signal,
        );
        if (outcome === 'close' || outcome === 'timeout') {
          const result = await execution;
          assert.equal(result.exitCode, outcome === 'close' ? 0 : null);
          assert.equal(result.timedOut, outcome === 'timeout');
        } else {
          await assert.rejects(execution, (error: unknown) =>
            error instanceof WorkspaceToolError &&
            error.code === (outcome.startsWith('abort')
              ? 'EXECUTION_ABORTED'
              : 'COMMAND_UNAVAILABLE') &&
            error.mutationMayHaveCommitted === (outcome === 'abort-after-spawn'),
          );
        }
        assert.equal(
          spawnCalls,
          outcome === 'abort-before-spawn' || outcome === 'wrap-throw' ? 0 : 1,
        );
        assert.equal(cleanupCalls, outcome === 'wrap-throw' ? 0 : 1);
        assert.equal(allocated, false);
        await sandbox.close();
        assert.equal(fake.reset, true);
      });
    }
  }
});
