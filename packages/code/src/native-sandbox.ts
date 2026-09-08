import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES,
  BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS,
  isWorkspaceToolRequest,
} from './protocol.js';
import {
  assertPrivateStorageAcl,
  assertPrivateStorageAncestors,
  removePrivateStorageAcl,
} from './private-storage.js';
import { WorkspaceToolError } from './workspace.js';

import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type {
  WorkspaceExecuteCommandRequest,
  WorkspaceExecuteCommandResult,
} from './protocol.js';
import type { WorkspaceCommandSandbox } from './workspace.js';

const SAFE_CHILD_ENV_NAMES = new Set([
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
]);

// Preserve the conventional proxy names, not arbitrary *_PROXY variables.
// SRT owns their final values and may replace them with its filtered proxy.
const PROXY_CHILD_ENV_NAMES = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

// Windows resolves these names case-insensitively. Keep the exception
// platform-specific so similarly named POSIX variables remain denied.
const WINDOWS_CHILD_ENV_NAMES = new Set([
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
]);

let hostEnvironmentMutationQueue: Promise<void> = Promise.resolve();

const TRUSTED_GIT_ENVIRONMENT = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'filter.lfs.clean',
  GIT_CONFIG_VALUE_0: 'git-lfs clean -- %f',
  GIT_CONFIG_KEY_1: 'filter.lfs.smudge',
  GIT_CONFIG_VALUE_1: 'git-lfs smudge -- %f',
  GIT_CONFIG_KEY_2: 'filter.lfs.process',
  GIT_CONFIG_VALUE_2: 'git-lfs filter-process',
  GIT_CONFIG_KEY_3: 'filter.lfs.required',
  GIT_CONFIG_VALUE_3: 'true',
} as const;
const {
  GIT_CONFIG_COUNT: TRUSTED_GIT_CONFIG_COUNT,
  ...TRUSTED_GIT_CONFIG_ENTRIES
} = TRUSTED_GIT_ENVIRONMENT;

const NATIVE_SANDBOX_SCRATCH_PREFIX = 'librechat-code-srt-';
// SRT grants these shared compatibility paths by default. A worker-specific
// TMPDIR must also deny them or separate worker processes can exchange files.
const SRT_SHARED_SCRATCH_PATHS = ['/tmp/claude', '/private/tmp/claude'];
const SRT_SCRATCH_SELECTOR_NAMES = [
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_TMPDIR',
] as const;

interface NativeSandboxManager {
  isSupportedPlatform(): boolean;
  checkDependenciesAsync(): Promise<{ warnings: string[]; errors: string[] }>;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(commandId: string, stderr: string): string;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface NativeSrtWorkspaceCommandSandboxOptions {
  workspaceRoot: string;
  /** Trusted worker files that must never become workspace-readable or writable. */
  protectedPaths?: string[];
  allowedDomains?: string[];
  environment?: NodeJS.ProcessEnv;
  manager?: NativeSandboxManager;
  spawnCommand?: SpawnCommand;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  /** Trusted shell path used by SRT on POSIX hosts. */
  shellPath?: string;
  /** Host-owned credentials exposed only as SRT sentinels inside the sandbox. */
  maskedEnvironment?: {
    variables: Array<{
      name: string;
      injectHosts: string[];
      extract?: string;
    }>;
    resolve(signal?: AbortSignal): Promise<Record<string, string>>;
    wrapCommand?(command: string, platform: NodeJS.Platform): string;
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor)
        throw new Error(`Cannot canonicalize protected path: ${path}`);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function boundedUtf8(buffer: Buffer, budget: number): string {
  let end = Math.min(buffer.byteLength, budget);
  while (end > 0) {
    const value = buffer.subarray(0, end).toString('utf8');
    if (Buffer.byteLength(value) <= budget) return value;
    end -= 1;
  }
  return '';
}

function deniedEnvironmentNames(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  return Object.keys(environment)
    .filter((name) => {
      const normalized = platform === 'win32' ? name.toUpperCase() : name;
      return (
        normalized.startsWith('LIBRECHAT_CODE_') ||
        (!SAFE_CHILD_ENV_NAMES.has(normalized) &&
          !PROXY_CHILD_ENV_NAMES.has(normalized) &&
          !(platform === 'win32' && WINDOWS_CHILD_ENV_NAMES.has(normalized)) &&
          !normalized.startsWith('LC_'))
      );
    })
    .sort();
}

function normalizedEnvironmentName(
  name: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

export class NativeSrtWorkspaceCommandSandbox implements WorkspaceCommandSandbox {
  readonly mutationFailuresAreAtomic = true as const;
  private readonly manager: NativeSandboxManager;
  private readonly spawnCommand: SpawnCommand;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private initialized?: Promise<void>;
  private canonicalRoot?: string;
  private scratchDirectory?: string;

  constructor(
    private readonly options: NativeSrtWorkspaceCommandSandboxOptions,
  ) {
    this.manager = options.manager ?? SandboxManager;
    this.spawnCommand = options.spawnCommand ?? spawn;
    this.environment = { ...(options.environment ?? process.env) };
    this.platform = options.platform ?? process.platform;
  }

  /** Fail closed before the worker advertises command execution. */
  async prepare(): Promise<void> {
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.initializeOnce().catch(async (error) => {
      await this.manager.reset().catch(() => undefined);
      await this.removeScratchDirectory().catch(() => undefined);
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async initializeOnce(): Promise<void> {
    if (!this.manager.isSupportedPlatform()) {
      throw new WorkspaceToolError(
        'Native sandbox is unsupported on this platform',
        'COMMAND_UNAVAILABLE',
      );
    }
    const root = await realpath(this.options.workspaceRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new WorkspaceToolError(
        'Native sandbox workspace is unavailable',
        'COMMAND_UNAVAILABLE',
      );
    }
    const home = await canonicalPath(this.options.homeDirectory ?? homedir());
    if (isWithin(root, home)) {
      throw new WorkspaceToolError(
        'Native sandbox workspace cannot contain the worker home directory',
        'REGISTRATION_INVALID',
      );
    }
    const protectedPaths = await Promise.all(
      (this.options.protectedPaths ?? []).map(canonicalPath),
    );
    if (protectedPaths.some((path) => isWithin(root, path))) {
      throw new WorkspaceToolError(
        'Native sandbox workspace cannot contain worker control files',
        'REGISTRATION_INVALID',
      );
    }
    const sharedScratchPaths = await Promise.all(
      (this.platform === 'win32' ? [] : SRT_SHARED_SCRATCH_PATHS).map(
        canonicalPath,
      ),
    );
    const inheritedWritablePaths = [
      ...sharedScratchPaths,
      ...(await Promise.all(
        [join(home, '.npm', '_logs'), join(home, '.claude', 'debug')].map(
          canonicalPath,
        ),
      )),
    ];
    const deniedInheritedWritablePaths = [
      ...new Set(inheritedWritablePaths),
    ].filter(
      (path) => !isWithin(root, path) && !isWithin(path, root),
    );
    const dependencies = await this.manager.checkDependenciesAsync();
    if (dependencies.errors.length > 0) {
      throw new WorkspaceToolError(
        `Native sandbox dependencies are unavailable: ${dependencies.errors.join('; ')}`,
        'COMMAND_UNAVAILABLE',
      );
    }
    if (this.platform !== 'win32') {
      try {
        await access(this.options.shellPath ?? '/bin/bash', fsConstants.X_OK);
      } catch {
        throw new WorkspaceToolError(
          `Native sandbox shell is unavailable: ${this.options.shellPath ?? '/bin/bash'}`,
          'COMMAND_UNAVAILABLE',
        );
      }
    }
    const canonicalScratchDirectory =
      await this.createScratchDirectory(sharedScratchPaths);
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [...(this.options.allowedDomains ?? [])],
        deniedDomains: [],
        strictAllowlist: true,
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        ...(this.options.maskedEnvironment ? { tlsTerminate: {} } : {}),
      },
      filesystem: {
        denyRead: [
          home,
          ...sharedScratchPaths.filter((path) =>
            deniedInheritedWritablePaths.includes(path),
          ),
        ],
        allowRead: [
          root,
          ...(canonicalScratchDirectory ? [canonicalScratchDirectory] : []),
        ],
        allowWrite: [
          root,
          ...(canonicalScratchDirectory ? [canonicalScratchDirectory] : []),
        ],
        denyWrite: [...protectedPaths, ...deniedInheritedWritablePaths],
        allowGitConfig: false,
      },
      credentials: {
        files: protectedPaths.map((path) => ({
          path,
          mode: 'deny' as const,
        })),
        envVars: [
          ...deniedEnvironmentNames(
            {
              ...this.environment,
              CLAUDE_CODE_TMPDIR: '',
              CLAUDE_TMPDIR: '',
            },
            this.platform,
          )
            .filter((name) => {
              const normalized = normalizedEnvironmentName(
                name,
                this.platform,
              );
              return (
                !Object.hasOwn(TRUSTED_GIT_ENVIRONMENT, normalized) &&
                !this.options.maskedEnvironment?.variables.some(
                  (variable) =>
                    normalizedEnvironmentName(
                      variable.name,
                      this.platform,
                    ) === normalized,
                )
              );
            })
            .map((name) => ({ name, mode: 'deny' as const })),
          ...(this.options.maskedEnvironment?.variables.map((variable) => ({
            ...variable,
            mode: 'mask' as const,
            ...(variable.extract ? { onExtractNoMatch: 'error' as const } : {}),
          })) ?? []),
        ],
      },
      allowAppleEvents: false,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      git: { safeDirectories: [root] },
    };
    await this.manager.initialize(config);
    this.canonicalRoot = root;
  }

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    if (
      !isWorkspaceToolRequest(request) ||
      request.operation !== 'execute_command'
    ) {
      throw new WorkspaceToolError(
        'Invalid native sandbox command',
        'INVALID_REQUEST',
      );
    }
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Workspace command execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    await this.initialize();
    const root = this.canonicalRoot!;
    let cwd: string;
    try {
      cwd = await realpath(resolve(root, request.cwd ?? '.'));
      if (!isWithin(root, cwd) || !(await stat(cwd)).isDirectory())
        throw new Error('invalid cwd');
    } catch {
      throw new WorkspaceToolError(
        'Command working directory is unavailable',
        'INVALID_PATH',
      );
    }
    const commandId = `librechat-code-${randomUUID()}`;
    const sandboxedCommand = this.options.maskedEnvironment?.wrapCommand
      ? this.options.maskedEnvironment.wrapCommand(
          request.command,
          this.platform,
        )
      : request.command;
    let wrapped: Awaited<
      ReturnType<NativeSandboxManager['wrapWithSandboxArgv']>
    >;
    try {
      const credentialEnvironment =
        await this.options.maskedEnvironment?.resolve(signal);
      wrapped = await this.withTemporaryHostEnvironment(
        {
          ...TRUSTED_GIT_ENVIRONMENT,
          ...(credentialEnvironment ?? {}),
          ...this.scratchSelectorEnvironment(),
          ...this.scratchEnvironment(),
        },
        () =>
          this.manager.wrapWithSandboxArgv(
            sandboxedCommand,
            this.platform === 'win32'
              ? undefined
              : (this.options.shellPath ?? '/bin/bash'),
            undefined,
            signal,
            cwd,
            { commandId, commandText: request.command },
          ),
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new WorkspaceToolError(
          'Workspace command execution aborted',
          'EXECUTION_ABORTED',
        );
      }
      throw new WorkspaceToolError(
        'Native sandbox command could not start',
        'COMMAND_UNAVAILABLE',
      );
    }
    try {
      if (signal?.aborted) {
        throw new WorkspaceToolError(
          'Workspace command execution aborted',
          'EXECUTION_ABORTED',
        );
      }
      return await this.runWrapped(request, wrapped, cwd, commandId, signal);
    } finally {
      // A successful wrap owns command state even when no child is spawned.
      try {
        this.manager.cleanupAfterCommand();
      } catch {
        // Cleanup is retried by close(); command settlement must still finish.
      }
    }
  }

  private async withTemporaryHostEnvironment<T>(
    values: Record<string, string>,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousMutation = hostEnvironmentMutationQueue;
    let releaseMutation!: () => void;
    hostEnvironmentMutationQueue = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    await previousMutation;
    const previous = new Map<string, string | undefined>();
    try {
      for (const [name, value] of Object.entries(values)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      return await action();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      releaseMutation();
    }
  }

  private async runWrapped(
    request: WorkspaceExecuteCommandRequest,
    wrapped: { argv: string[]; env: NodeJS.ProcessEnv },
    cwd: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    const outputLimit =
      request.maxOutputBytes ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES;
    const timeoutMs =
      request.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS;
    return await new Promise<WorkspaceExecuteCommandResult>(
      (resolvePromise, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = this.spawnCommand(wrapped.argv[0], wrapped.argv.slice(1), {
            cwd,
            env: {
              ...wrapped.env,
              ...this.scratchEnvironment(),
              ...TRUSTED_GIT_CONFIG_ENTRIES,
              GIT_CONFIG_COUNT:
                wrapped.env.GIT_CONFIG_COUNT ?? TRUSTED_GIT_CONFIG_COUNT,
              GIT_CONFIG_GLOBAL:
                this.platform === 'win32' ? 'NUL' : '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
            },
            detached: this.platform !== 'win32',
            shell: false,
            windowsHide: true,
          });
          child.stdin.end();
        } catch {
          reject(
            new WorkspaceToolError(
              'Native sandbox command could not start',
              'COMMAND_UNAVAILABLE',
            ),
          );
          return;
        }
        let settled = false;
        let timedOut = false;
        let outputBytes = 0;
        let truncated = false;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const append = (target: Buffer[], chunk: Buffer): void => {
          const remaining = outputLimit - outputBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          const accepted = chunk.subarray(0, remaining);
          target.push(accepted);
          outputBytes += accepted.byteLength;
          if (accepted.byteLength !== chunk.byteLength) truncated = true;
        };
        child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
        const abort = (): void => {
          if (settled) return;
          this.killCommandTree(child);
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          this.killCommandTree(child);
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        child.once('error', () => {
          if (settled) return;
          settled = true;
          const mayHaveStarted = child.pid != null;
          this.killCommandTree(child);
          cleanup();
          reject(
            new WorkspaceToolError(
              'Native sandbox command could not start',
              'COMMAND_UNAVAILABLE',
              mayHaveStarted,
            ),
          );
        });
        child.once('close', (code, childSignal) => {
          if (settled) return;
          settled = true;
          this.killCommandTree(child);
          cleanup();
          if (signal?.aborted) {
            reject(
              new WorkspaceToolError(
                'Workspace command execution aborted',
                'EXECUTION_ABORTED',
                true,
              ),
            );
            return;
          }
          const stdoutValue = boundedUtf8(Buffer.concat(stdout), outputLimit);
          const stderrBudget = Math.max(
            0,
            outputLimit - Buffer.byteLength(stdoutValue),
          );
          const rawStderr = Buffer.concat(stderr).toString('utf8');
          let annotatedStderr = rawStderr;
          try {
            annotatedStderr = this.manager.annotateStderrWithSandboxFailures(
              commandId,
              rawStderr,
            );
          } catch {
            // Preserve the bounded child error if optional violation annotation fails.
          }
          const stderrValue = boundedUtf8(
            Buffer.from(annotatedStderr),
            stderrBudget,
          );
          resolvePromise({
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            operation: 'execute_command',
            workspaceId: request.workspaceId,
            exitCode:
              timedOut || childSignal ? null : this.protocolExitCode(code),
            ...(childSignal ? { signal: childSignal } : {}),
            stdout: stdoutValue,
            stderr: stderrValue,
            truncated:
              truncated || Buffer.byteLength(annotatedStderr) > stderrBudget,
            timedOut,
          });
        });
      },
    );
  }

  private killCommandTree(child: ChildProcessWithoutNullStreams): void {
    try {
      if (this.platform !== 'win32' && child.pid != null) {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // The command group has already exited.
    }
  }

  private protocolExitCode(code: number | null): number {
    return Number.isSafeInteger(code) &&
      code != null &&
      code >= 0 &&
      code <= 255
      ? code
      : 1;
  }

  private async createScratchDirectory(
    sharedScratchPaths: string[],
  ): Promise<string | undefined> {
    // Windows SRT supplies the restricted account's private TEMP directory.
    if (this.platform === 'win32') return undefined;
    const canonicalTemporaryRoot = await canonicalPath(tmpdir());
    const sharedScratchRoot = sharedScratchPaths.find((path) =>
      isWithin(path, canonicalTemporaryRoot),
    );
    const scratchDirectory = await mkdtemp(
      join(
        sharedScratchRoot
          ? dirname(sharedScratchRoot)
          : canonicalTemporaryRoot,
        NATIVE_SANDBOX_SCRATCH_PREFIX,
      ),
    );
    try {
      await assertPrivateStorageAncestors(scratchDirectory);
      const scratchHandle = await open(scratchDirectory, 'r');
      try {
        await removePrivateStorageAcl(scratchHandle, scratchDirectory);
        await scratchHandle.chmod(0o700);
        await assertPrivateStorageAcl(
          scratchHandle,
          scratchDirectory,
          true,
        );
        if (((await scratchHandle.stat()).mode & 0o777) !== 0o700) {
          throw new Error('Native sandbox scratch directory is not private');
        }
      } finally {
        await scratchHandle.close();
      }
      this.scratchDirectory = await realpath(scratchDirectory);
      return this.scratchDirectory;
    } catch (error) {
      await rm(scratchDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private scratchEnvironment(): NodeJS.ProcessEnv {
    const scratchDirectory = this.scratchDirectory;
    if (!scratchDirectory) return {};
    return this.platform === 'win32'
      ? {
          TMPDIR: scratchDirectory,
          TEMP: scratchDirectory,
          TMP: scratchDirectory,
        }
      : { TMPDIR: scratchDirectory };
  }

  private scratchSelectorEnvironment(): NodeJS.ProcessEnv {
    const scratchDirectory = this.scratchDirectory;
    if (!scratchDirectory) return {};
    return Object.fromEntries(
      SRT_SCRATCH_SELECTOR_NAMES.map((name) => [name, scratchDirectory]),
    );
  }

  private async removeScratchDirectory(): Promise<void> {
    const scratchDirectory = this.scratchDirectory;
    this.scratchDirectory = undefined;
    if (!scratchDirectory) return;
    await rm(scratchDirectory, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (!this.initialized && !this.scratchDirectory) return;
    try {
      if (this.initialized) await this.manager.reset();
    } finally {
      this.initialized = undefined;
      this.canonicalRoot = undefined;
      await this.removeScratchDirectory();
    }
  }
}
