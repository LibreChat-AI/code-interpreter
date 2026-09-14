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
import type { FileHandle } from 'node:fs/promises';

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
import { restoreScratchTraversal } from './native-scratch.js';

import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { normalizeNativeSrtCommandPolicy } from './native-policy.js';
import type { NativeSrtCommandPolicy } from './native-policy.js';
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
// Capture this before any command wrapper can temporarily mutate process.env.
const HOST_TEMPORARY_ROOT = tmpdir();

interface NativeSandboxManager {
  isSupportedPlatform(): boolean;
  checkDependenciesAsync(): Promise<{ warnings: string[]; errors: string[] }>;
  initialize(
    config: SandboxRuntimeConfig,
    sandboxAskCallback?: SandboxAskCallback,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    annotateStderrWithSandboxFailures(
        commandId: string,
        stderr: string,
    ): string;
  cleanupAfterCommand(): void;
  updateConfig?(config: SandboxRuntimeConfig): void;
  reset(): Promise<void>;
}

// SRT's default manager is process-global, including its policy and cleanup
// state. Distinct workspace objects must not reconfigure the same manager.
const managerOwners = new WeakMap<
  NativeSandboxManager,
  NativeSrtWorkspaceCommandSandbox
>();

type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface NativeSrtWorkspaceCommandSandboxOptions {
  workspaceRoot: string;
  commandPolicy?: NativeSrtCommandPolicy;
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
        .filter(name => {
      const normalized = platform === 'win32' ? name.toUpperCase() : name;
      return (
        normalized.startsWith('LIBRECHAT_CODE_') ||
        (!SAFE_CHILD_ENV_NAMES.has(normalized) &&
          !PROXY_CHILD_ENV_NAMES.has(normalized) &&
                    !(
                        platform === 'win32' &&
                        WINDOWS_CHILD_ENV_NAMES.has(normalized)
                    ) &&
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

/** Distinguishes an unsupported host filesystem from an implementation fault. */
export class CopyOnWriteCloneUnavailableError extends WorkspaceToolError {
  constructor() {
    super(
      'Selected-workspace PTC requires copy-on-write filesystem cloning',
      'COMMAND_UNAVAILABLE',
    );
    this.name = 'CopyOnWriteCloneUnavailableError';
  }
}

function isCopyOnWriteUnsupported(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP')
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('operation not supported')
  );
}

export class NativeSrtWorkspaceCommandSandbox implements WorkspaceCommandSandbox {
  readonly mutationFailuresAreAtomic = true as const;
  private readonly manager: NativeSandboxManager;
  private readonly spawnCommand: SpawnCommand;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private initialized?: Promise<void>;
  private canonicalRoot?: string;
  private runtimeConfig?: SandboxRuntimeConfig;
    private denyReadPaths: string[] = [];
    private denyWritePaths: string[] = [];
  private scratchDirectory?: string;
  private scratchHandle?: FileHandle;
  private execution?: Promise<WorkspaceExecuteCommandResult>;
  private closing?: Promise<void>;
  private resetFailed = false;

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
    if (this.closing || this.resetFailed) {
      throw new WorkspaceToolError(
        'Native sandbox is closing or requires cleanup',
        'COMMAND_UNAVAILABLE',
      );
    }
    if (this.initialized) return this.initialized;
    const owner = managerOwners.get(this.manager);
    if (owner && owner !== this) {
      throw new WorkspaceToolError(
        'Native sandbox manager already belongs to another workspace; use a separate worker process',
        'COMMAND_UNAVAILABLE',
      );
    }
    managerOwners.set(this.manager, this);
        this.initialized = this.initializeOnce().catch(async error => {
      await this.manager.reset().catch(() => {
        this.resetFailed = true;
      });
      await this.removeScratchDirectory().catch(() => undefined);
      if (!this.resetFailed) managerOwners.delete(this.manager);
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
        const home = await canonicalPath(
            this.options.homeDirectory ?? homedir(),
        );
    if (isWithin(root, home)) {
      throw new WorkspaceToolError(
        'Native sandbox workspace cannot contain the worker home directory',
        'REGISTRATION_INVALID',
      );
    }
    const protectedPaths = await Promise.all(
      (this.options.protectedPaths ?? []).map(canonicalPath),
    );
        if (protectedPaths.some(path => isWithin(root, path))) {
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
                [
                    join(home, '.npm', '_logs'),
                    join(home, '.claude', 'debug'),
                ].map(canonicalPath),
      )),
    ];
        const deniedInheritedWritablePaths = [
            ...new Set(inheritedWritablePaths),
        ];
        if (deniedInheritedWritablePaths.some(path => isWithin(path, root))) {
      throw new WorkspaceToolError(
        'Native sandbox workspace cannot be inside an inherited writable path',
        'REGISTRATION_INVALID',
      );
    }
    const dependencies = await this.manager.checkDependenciesAsync();
    if (dependencies.errors.length > 0) {
      throw new WorkspaceToolError(
        `Native sandbox dependencies are unavailable: ${dependencies.errors.join('; ')}`,
        'COMMAND_UNAVAILABLE',
      );
    }
    if (this.platform !== 'win32') {
      try {
                await access(
                    this.options.shellPath ?? '/bin/bash',
                    fsConstants.X_OK,
                );
      } catch {
        throw new WorkspaceToolError(
          `Native sandbox shell is unavailable: ${this.options.shellPath ?? '/bin/bash'}`,
          'COMMAND_UNAVAILABLE',
        );
      }
    }
    const canonicalScratchDirectory =
      await this.createScratchDirectory(sharedScratchPaths);
    if (
      canonicalScratchDirectory &&
      isWithin(root, canonicalScratchDirectory)
    ) {
      throw new WorkspaceToolError(
        'Native sandbox workspace cannot contain worker scratch storage',
        'REGISTRATION_INVALID',
      );
    }
    const commandPolicy = normalizeNativeSrtCommandPolicy(
      this.options.commandPolicy,
    );
    const unrestrictedNetwork =
      commandPolicy.network.outbound === 'unrestricted';
    const network: SandboxRuntimeConfig['network'] = {
        allowedDomains: [...(this.options.allowedDomains ?? [])],
        deniedDomains: [],
        strictAllowlist: !unrestrictedNetwork,
        allowAllUnixSockets: commandPolicy.network.allowAllUnixSockets,
        allowLocalBinding: commandPolicy.network.allowLocalBinding,
        ...(this.options.maskedEnvironment ? { tlsTerminate: {} } : {}),
    };
    const config: SandboxRuntimeConfig = {
      network,
      filesystem: {
        denyRead: [
          home,
                    ...sharedScratchPaths.filter(path =>
            deniedInheritedWritablePaths.includes(path),
          ),
        ],
        allowRead: [
          root,
                    ...(canonicalScratchDirectory
                        ? [canonicalScratchDirectory]
                        : []),
        ],
        allowWrite: [
          root,
                    ...(canonicalScratchDirectory
                        ? [canonicalScratchDirectory]
                        : []),
        ],
        denyWrite: [...protectedPaths, ...deniedInheritedWritablePaths],
        allowGitConfig: false,
      },
      credentials: {
                files: protectedPaths.map(path => ({
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
                        .filter(name => {
              const normalized = normalizedEnvironmentName(
                name,
                this.platform,
              );
              return (
                                !Object.hasOwn(
                                    TRUSTED_GIT_ENVIRONMENT,
                                    normalized,
                                ) &&
                !this.options.maskedEnvironment?.variables.some(
                                    variable =>
                    normalizedEnvironmentName(
                      variable.name,
                      this.platform,
                    ) === normalized,
                )
              );
            })
                        .map(name => ({ name, mode: 'deny' as const })),
                    ...(this.options.maskedEnvironment?.variables.map(
                        variable => ({
            ...variable,
            mode: 'mask' as const,
                            ...(variable.extract
                                ? { onExtractNoMatch: 'error' as const }
                                : {}),
                        }),
                    ) ?? []),
        ],
      },
      allowAppleEvents: false,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      git: { safeDirectories: [root] },
    };
    await this.manager.initialize(
      config,
      unrestrictedNetwork ? async () => true : undefined,
    );
    this.canonicalRoot = root;
    this.runtimeConfig = config;
        this.denyReadPaths = [
            home,
            ...sharedScratchPaths.filter(path =>
                deniedInheritedWritablePaths.includes(path),
            ),
        ];
        this.denyWritePaths = [
            ...protectedPaths,
            ...deniedInheritedWritablePaths,
        ];
  }

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    if (this.execution || this.closing) {
      throw new WorkspaceToolError(
        'Native sandbox already has an active command or is closing',
        'COMMAND_UNAVAILABLE',
      );
    }
    const execution = this.executeExclusive(request, signal);
    this.execution = execution;
    try {
      return await execution;
    } finally {
      this.execution = undefined;
    }
  }

  /**
   * Allocate an owner-only execution directory that is already inside this
   * sandbox's allowlist. The caller must remove the returned directory after
   * the execution settles. It is intentionally unavailable on native Windows
   * until the restricted-account TEMP directory can be opened and verified by
   * the trusted parent process.
   */
  async createExecutionDirectory(): Promise<string> {
    await this.initialize();
    if (!this.scratchDirectory || this.platform === 'win32') {
      throw new WorkspaceToolError(
        'Native programmatic execution storage is unavailable',
        'COMMAND_UNAVAILABLE',
      );
    }
    return await mkdtemp(join(this.scratchDirectory, 'execution-'));
  }

  /**
   * Clone the current workspace into private scratch for a side-effect-
   * equivalent replay probe. Platform clone flags are intentionally strict:
   * silently falling back to a byte copy would make every tool-bearing run
   * consume time and disk proportional to the repository size.
   */
  async createProgrammaticProbeWorkspace(
    executionDirectory: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.initialize();
    const scratchDirectory = this.scratchDirectory;
    const root = this.canonicalRoot;
    let parent: string;
    try {
      parent = await realpath(executionDirectory);
      if (
        !scratchDirectory ||
        !root ||
        !isWithin(scratchDirectory, parent) ||
        !(await stat(parent)).isDirectory()
      ) {
        throw new Error('invalid execution directory');
      }
    } catch {
      throw new WorkspaceToolError(
        'Programmatic execution directory is unavailable',
        'INVALID_PATH',
      );
    }
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Programmatic execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    const destination = join(parent, 'workspace');
    try {
      if (this.platform === 'win32') {
        throw new Error('copy-on-write cloning is unavailable on Windows');
      }
      const args =
        this.platform === 'darwin'
          ? ['-cR', root, destination]
          : ['--archive', '--reflink=always', root, destination];
      await new Promise<void>((resolveCopy, rejectCopy) => {
        const child = this.spawnCommand('/bin/cp', args, {
          env: {
            PATH: this.environment.PATH,
            LANG: this.environment.LANG,
            LC_ALL: this.environment.LC_ALL,
          },
          signal,
        });
        let stderr = Buffer.alloc(0);
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.byteLength < 4_096) {
            stderr = Buffer.concat([stderr, chunk]).subarray(0, 4_096);
          }
        });
        child.once('error', rejectCopy);
        child.once('close', code => {
          if (code === 0) resolveCopy();
          else {
            rejectCopy(
              new Error(
                `copy-on-write clone failed (${code ?? 'signal'}): ${boundedUtf8(stderr, 4_096)}`,
              ),
            );
          }
        });
      });
      return await realpath(destination);
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (signal?.aborted) {
        throw new WorkspaceToolError(
          'Programmatic execution aborted',
          'EXECUTION_ABORTED',
        );
      }
      if (isCopyOnWriteUnsupported(error, this.platform)) {
        throw new CopyOnWriteCloneUnavailableError();
      }
      throw new WorkspaceToolError(
        'Copy-on-write workspace clone failed unexpectedly',
        'COMMAND_UNAVAILABLE',
      );
    }
  }

  /** Run a generated program from a verified private execution directory. */
  async executeProgrammatic(
    request: WorkspaceExecuteCommandRequest,
    dataDirectory: string,
    signal?: AbortSignal,
        options?: { probe?: boolean; workspaceRoot?: string },
  ): Promise<WorkspaceExecuteCommandResult> {
    if (this.execution || this.closing) {
      throw new WorkspaceToolError(
        'Native sandbox already has an active command or is closing',
        'COMMAND_UNAVAILABLE',
      );
    }
    await this.initialize();
    const scratchDirectory = this.scratchDirectory;
    let canonicalDataDirectory: string;
    let canonicalWorkspaceRoot: string | undefined;
    try {
      canonicalDataDirectory = await realpath(dataDirectory);
      canonicalWorkspaceRoot = options?.workspaceRoot
        ? await realpath(options.workspaceRoot)
        : undefined;
      if (
        !scratchDirectory ||
        !isWithin(scratchDirectory, canonicalDataDirectory) ||
        !(await stat(canonicalDataDirectory)).isDirectory() ||
        (canonicalWorkspaceRoot != null &&
          (!isWithin(scratchDirectory, canonicalWorkspaceRoot) ||
            !(await stat(canonicalWorkspaceRoot)).isDirectory()))
      ) {
        throw new Error('invalid execution directory');
      }
    } catch {
      throw new WorkspaceToolError(
        'Programmatic execution directory is unavailable',
        'INVALID_PATH',
      );
    }
        const execute = () => this.executeExclusive(
            request,
            signal,
            {
      LIBRECHAT_CODE_DATA_DIR: canonicalDataDirectory,
                LIBRECHAT_CODE_CONTROL_PATH: join(
                    canonicalDataDirectory,
                    '_ptc_pending_result.json',
                ),
                LIBRECHAT_CODE_BASH_PATH: this.options.shellPath ?? '/bin/bash',
                PTC_HISTORY_PATH: join(
                    canonicalDataDirectory,
                    '_ptc_history.json',
                ),
      TMPDIR: canonicalDataDirectory,
            },
            options?.probe
                ? {
                      filesystem: {
                          allowRead: [
                              canonicalWorkspaceRoot ?? this.canonicalRoot!,
                              canonicalDataDirectory,
                          ],
                          allowWrite: [
                              ...(canonicalWorkspaceRoot != null
                                  ? [canonicalWorkspaceRoot]
                                  : []),
                              canonicalDataDirectory,
                          ],
                          denyRead: this.denyReadPaths,
                          denyWrite: [
                              this.canonicalRoot!,
                              ...this.denyWritePaths,
                          ],
                      },
                      network: {
                          // A probe is speculative, even on a trusted VM.
                          // Copy-on-write protects files, not remote mutations.
                          allowedDomains: [],
                          deniedDomains: [],
                          strictAllowlist: true,
                          allowUnixSockets: [],
                          allowAllUnixSockets: false,
                          allowLocalBinding: false,
                      },
                  }
                : undefined,
            canonicalDataDirectory,
            canonicalWorkspaceRoot,
        );
    const execution = options?.probe ? this.withProbeNetwork(execute) : execute();
    this.execution = execution;
    try {
      return await execution;
    } finally {
      this.execution = undefined;
    }
  }

  private async withProbeNetwork<T>(execute: () => Promise<T>): Promise<T> {
    const config = this.runtimeConfig;
    if (!config || !this.manager.updateConfig) {
      throw new WorkspaceToolError('Native probe network isolation is unavailable', 'COMMAND_UNAVAILABLE');
    }
    // SRT's proxies and Unix/local socket rules read session configuration,
    // not wrapWithSandboxArgv's per-command override.
    this.manager.updateConfig({ ...config, network: {
      allowedDomains: [], deniedDomains: [], strictAllowlist: true,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
    } });
    try {
      return await execute();
    } finally {
      try {
        // Revoke the probe's proxy endpoints and credentials before restoring
        // network access. A lingering probe must never inherit the commit's
        // permissive proxy session through a live updateConfig.
        await this.manager.reset();
        await this.manager.initialize(config, config.network.strictAllowlist ? undefined : async () => true);
      } catch {
        this.resetFailed = true;
        throw new WorkspaceToolError('Native probe network cleanup failed', 'COMMAND_UNAVAILABLE');
      }
    }
  }

  private async executeExclusive(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
    trustedEnvironment?: NodeJS.ProcessEnv,
        customConfig?: Partial<SandboxRuntimeConfig>,
        sandboxScratchDirectory?: string,
        workspaceRoot?: string,
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
    const root = workspaceRoot ?? this.canonicalRoot!;
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
          ...this.scratchSelectorEnvironment(sandboxScratchDirectory),
        },
        () =>
          this.manager.wrapWithSandboxArgv(
            sandboxedCommand,
            this.platform === 'win32'
              ? undefined
              : (this.options.shellPath ?? '/bin/bash'),
                        customConfig,
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
      return await this.runWrapped(
        request,
        wrapped,
        cwd,
        commandId,
        signal,
        trustedEnvironment,
      );
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
        hostEnvironmentMutationQueue = new Promise<void>(resolve => {
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
    trustedEnvironment?: NodeJS.ProcessEnv,
  ): Promise<WorkspaceExecuteCommandResult> {
    const outputLimit =
            request.maxOutputBytes ??
            BRIDGE_WORKSPACE_COMMAND_DEFAULT_OUTPUT_BYTES;
    const timeoutMs =
      request.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS;
    return await new Promise<WorkspaceExecuteCommandResult>(
      (resolvePromise, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
                    child = this.spawnCommand(
                        wrapped.argv[0],
                        wrapped.argv.slice(1),
                        {
            cwd,
            env: {
              ...wrapped.env,
              ...this.scratchEnvironment(),
              ...trustedEnvironment,
              ...TRUSTED_GIT_CONFIG_ENTRIES,
              GIT_CONFIG_COUNT:
                                    wrapped.env.GIT_CONFIG_COUNT ??
                                    TRUSTED_GIT_CONFIG_COUNT,
              GIT_CONFIG_GLOBAL:
                                    this.platform === 'win32'
                                        ? 'NUL'
                                        : '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
            },
            detached: this.platform !== 'win32',
            shell: false,
            windowsHide: true,
                        },
                    );
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
                    if (accepted.byteLength !== chunk.byteLength)
                        truncated = true;
        };
                child.stdout.on('data', (chunk: Buffer) =>
                    append(stdout, chunk),
                );
                child.stderr.on('data', (chunk: Buffer) =>
                    append(stderr, chunk),
                );
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
                // POSIX commands run in a detached process group, so its
                // observed close follows a group-wide SIGKILL. The Windows
                // fallback cannot yet prove descendant termination.
                this.platform === 'win32',
              ),
            );
            return;
          }
                    const stdoutValue = boundedUtf8(
                        Buffer.concat(stdout),
                        outputLimit,
                    );
          const stderrBudget = Math.max(
            0,
            outputLimit - Buffer.byteLength(stdoutValue),
          );
          const rawStderr = Buffer.concat(stderr).toString('utf8');
          let annotatedStderr = rawStderr;
          try {
                        annotatedStderr =
                            this.manager.annotateStderrWithSandboxFailures(
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
                            timedOut || childSignal
                                ? null
                                : this.protocolExitCode(code),
            ...(childSignal ? { signal: childSignal } : {}),
            stdout: stdoutValue,
            stderr: stderrValue,
            truncated:
                            truncated ||
                            Buffer.byteLength(annotatedStderr) > stderrBudget,
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
    if (this.scratchDirectory || this.scratchHandle) {
      throw new Error(
        'Native sandbox scratch cleanup is still pending; close the sandbox before reinitializing',
      );
    }
    const canonicalTemporaryRoot = await canonicalPath(HOST_TEMPORARY_ROOT);
        const sharedScratchRoot = sharedScratchPaths.find(path =>
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
                    throw new Error(
                        'Native sandbox scratch directory is not private',
                    );
        }
        this.scratchHandle = scratchHandle;
      } catch (error) {
        await scratchHandle.close();
        throw error;
      }
      this.scratchDirectory = await realpath(scratchDirectory);
      return this.scratchDirectory;
    } catch (error) {
      await this.scratchHandle?.close().catch(() => undefined);
      this.scratchHandle = undefined;
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

  private scratchSelectorEnvironment(
        selectedDirectory = this.scratchDirectory,
  ): NodeJS.ProcessEnv {
    const scratchDirectory = selectedDirectory;
    if (!scratchDirectory) return {};
    return Object.fromEntries(
            SRT_SCRATCH_SELECTOR_NAMES.map(name => [name, scratchDirectory]),
    );
  }

  private async removeScratchDirectory(): Promise<void> {
    const scratchDirectory = this.scratchDirectory;
    if (!scratchDirectory) return;
    const scratchHandle = this.scratchHandle;
    if (!scratchHandle) {
      throw new Error('Native sandbox scratch descriptor is unavailable');
    }
    try {
      await rm(scratchDirectory, { recursive: true, force: true });
    } catch {
      await restoreScratchTraversal(scratchHandle);
      await rm(scratchDirectory, { recursive: true, force: true });
    }
    // Retain both the descriptor and path when cleanup fails so close() can
    // retry without falling back to an attacker-replaceable ambient path.
    await scratchHandle.close();
    this.scratchHandle = undefined;
    this.scratchDirectory = undefined;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.closeExclusive();
    this.closing = closing;
    try {
      await closing;
    } finally {
      this.closing = undefined;
    }
  }

  private async closeExclusive(): Promise<void> {
    // Never reset proxy/credential state or remove scratch beneath a live child.
    await this.execution?.catch(() => undefined);
    await this.initialized?.catch(() => undefined);
    if (managerOwners.get(this.manager) === this) {
      this.resetFailed = true;
      await this.manager.reset();
      this.resetFailed = false;
      managerOwners.delete(this.manager);
    }
    this.initialized = undefined;
    this.canonicalRoot = undefined;
    await this.removeScratchDirectory();
  }
}
