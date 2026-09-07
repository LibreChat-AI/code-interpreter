import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { config } from './config';
import { aggregateBashExtras, filterExtraEnvVars } from './job';
import { logger } from './logger';
import { getLatestRuntimeMatchingLanguageVersion, getRuntimes, type Runtime } from './runtime';
import { getBoundSessionWorkspace, type SessionWorkspace } from './session-workspace';
import { ValidationError, validateFilePath } from './validation';

const execFileAsync = promisify(execFile);
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOSTED_APP_EGRESS_CHAIN = 'CODEAPI_HOSTED_APP_EGRESS';
/* Sibling of sandbox_api, not its child: the API process lives in sandbox_api
 * and cgroup v2 forbids enabling domain controllers below a populated parent. */
const HOSTED_APP_CGROUP = '/sys/fs/cgroup/codeapi_hosted_app';
const HOSTED_APP_LAUNCHER = '/usr/local/bin/codeapi-hosted-app-launcher';
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_ENV_BYTES = 32 * 1024;
const MAX_TRACKED_APP_REVISIONS = 1024;
const PROBE_INTERVAL_MS = 100;

export interface HostedAppStartRequest {
  app_id: string;
  revision: string;
  language: string;
  version: string;
  entrypoint: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface NormalizedHostedAppRequest extends HostedAppStartRequest {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export type HostedAppState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface HostedAppStatus {
  app_id: string;
  revision: string;
  state: HostedAppState;
  port: number;
  pid?: number;
  started_at: string;
  exited_at?: string;
  exit_code?: number;
  signal?: NodeJS.Signals;
  message?: string;
  stdout: string;
  stderr: string;
}

export class HostedAppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HostedAppError';
  }
}

interface ActiveHostedApp {
  request: NormalizedHostedAppRequest;
  specKey: string;
  cgroupDrained: boolean;
  process?: HostedAppChild;
  status: HostedAppStatus;
}

interface HostedAppChild extends ChildProcess {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

type SpawnApp = (command: string, args: readonly string[], options: SpawnOptions) => HostedAppChild;
type ResolveRuntime = typeof getLatestRuntimeMatchingLanguageVersion;

export interface HostedAppDependencies {
  getSession: () => SessionWorkspace | undefined;
  resolveRuntime: ResolveRuntime;
  listRuntimes: () => Runtime[];
  prepareRuntimeWorkspace: (
    workspaceDir: string,
    runtime: Runtime,
    nodeModulesPath?: string,
  ) => Promise<void>;
  spawnApp: SpawnApp;
  prepareCgroup: () => Promise<void>;
  killCgroup: () => Promise<void>;
  installNetworkGuard: (uid: number) => Promise<void>;
  probePort: (port: number) => Promise<boolean>;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  now: () => Date;
}

export async function prepareHostedAppRuntimeWorkspace(
  workspaceDir: string,
  runtime: Runtime,
  nodeModulesPath?: string,
): Promise<void> {
  const packageModules = nodeModulesPath ?? path.join(runtime.pkgdir, 'node_modules');
  const packageStat = await fsp.stat(packageModules).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!packageStat?.isDirectory()) return;

  const workspaceModules = path.join(workspaceDir, 'node_modules');
  let workspaceModulesStat: Awaited<ReturnType<typeof fsp.lstat>> | undefined;
  try {
    workspaceModulesStat = await fsp.lstat(workspaceModules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (workspaceModulesStat && !workspaceModulesStat.isSymbolicLink()) return;
  if (workspaceModulesStat?.isSymbolicLink()) {
    const linkTarget = await fsp.readlink(workspaceModules);
    const resolvedTarget = path.resolve(workspaceDir, linkTarget);
    const packageRoot = path.resolve(config.packages_directory);
    if (!isInside(packageRoot, resolvedTarget)) return;
    if (resolvedTarget === packageModules) return;
    await fsp.unlink(workspaceModules);
  }
  try {
    await fsp.symlink(packageModules, workspaceModules, 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeHostedAppRequest(value: unknown): NormalizedHostedAppRequest {
  if (!isPlainObject(value)) {
    throw new HostedAppError('invalid_hosted_app_request', 'request body must be an object', 400);
  }

  const stringField = (name: string): string => {
    const field = value[name];
    if (typeof field !== 'string' || field.length === 0) {
      throw new HostedAppError(
        'invalid_hosted_app_request',
        `${name} must be a non-empty string`,
        400,
      );
    }
    if (field.includes('\0')) {
      throw new HostedAppError('invalid_hosted_app_request', `${name} must not contain NUL`, 400);
    }
    return field;
  };

  const appId = stringField('app_id');
  const revision = stringField('revision');
  const language = stringField('language');
  const version = stringField('version');
  const entrypoint = stringField('entrypoint');
  if (!APP_ID_PATTERN.test(appId)) {
    throw new HostedAppError('invalid_hosted_app_request', 'app_id is malformed', 400);
  }
  if (!REVISION_PATTERN.test(revision)) {
    throw new HostedAppError('invalid_hosted_app_request', 'revision is malformed', 400);
  }
  try {
    validateFilePath(entrypoint, '/tmp/codeapi-hosted-app-validation');
  } catch (error) {
    throw new HostedAppError(
      'invalid_hosted_app_request',
      `entrypoint is invalid: ${error instanceof Error ? error.message : 'invalid path'}`,
      400,
    );
  }

  const cwdValue = value.cwd ?? '.';
  if (typeof cwdValue !== 'string' || cwdValue.includes('\0')) {
    throw new HostedAppError('invalid_hosted_app_request', 'cwd must be a string', 400);
  }
  if (cwdValue !== '.') {
    try {
      /* validateFilePath is also the canonical relative-path validator. A cwd
       * is allowed to name a directory; append a sentinel so trailing-slash
       * and directory-root cases retain the same traversal checks. */
      validateFilePath(path.posix.join(cwdValue, '.codeapi-cwd'), '/tmp/codeapi-hosted-app-validation');
      if (path.posix.normalize(cwdValue) !== cwdValue || cwdValue.endsWith('/')) {
        throw new ValidationError('cwd must be a canonical relative path');
      }
    } catch (error) {
      throw new HostedAppError(
        'invalid_hosted_app_request',
        `cwd is invalid: ${error instanceof Error ? error.message : 'invalid path'}`,
        400,
      );
    }
  }

  const argsValue = value.args ?? [];
  if (
    !Array.isArray(argsValue)
    || argsValue.length > MAX_ARGS
    || argsValue.some(arg => (
      typeof arg !== 'string'
      || arg.includes('\0')
      || byteLength(arg) > MAX_ARG_BYTES
    ))
  ) {
    throw new HostedAppError(
      'invalid_hosted_app_request',
      `args must contain at most ${MAX_ARGS} bounded strings`,
      400,
    );
  }

  const envValue = value.env ?? {};
  if (!isPlainObject(envValue) || Object.keys(envValue).length > MAX_ENV_VARS) {
    throw new HostedAppError(
      'invalid_hosted_app_request',
      `env must be an object with at most ${MAX_ENV_VARS} entries`,
      400,
    );
  }
  const env: Record<string, string> = {};
  let envBytes = 0;
  for (const [key, raw] of Object.entries(envValue)) {
    if (
      !ENV_NAME_PATTERN.test(key)
      || typeof raw !== 'string'
      || raw.includes('\0')
      || byteLength(raw) > MAX_ENV_VALUE_BYTES
    ) {
      throw new HostedAppError('invalid_hosted_app_request', `env.${key} is invalid`, 400);
    }
    envBytes += byteLength(key) + byteLength(raw);
    if (envBytes > MAX_ENV_BYTES) {
      throw new HostedAppError('invalid_hosted_app_request', 'env is too large', 400);
    }
    env[key] = raw;
  }

  return {
    app_id: appId,
    revision,
    language,
    version,
    entrypoint,
    cwd: cwdValue,
    args: [...argsValue] as string[],
    env,
  };
}

function canonicalSpecKey(request: NormalizedHostedAppRequest): string {
  const canonical = JSON.stringify({
    ...request,
    env: Object.fromEntries(Object.entries(request.env).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function resolveWorkspacePaths(
  workspaceDir: string,
  request: NormalizedHostedAppRequest,
): Promise<{ cwd: string; entrypoint: string }> {
  const realRoot = await fsp.realpath(workspaceDir);
  const cwd = await fsp.realpath(path.resolve(realRoot, request.cwd)).catch(() => {
    throw new HostedAppError('hosted_app_cwd_missing', 'cwd does not exist', 400);
  });
  if (!isInside(realRoot, cwd)) {
    throw new HostedAppError('hosted_app_path_escape', 'cwd escapes the session workspace', 400);
  }
  const cwdStat = await fsp.stat(cwd);
  if (!cwdStat.isDirectory()) {
    throw new HostedAppError('hosted_app_cwd_missing', 'cwd is not a directory', 400);
  }

  const requestedEntrypoint = path.resolve(realRoot, request.entrypoint);
  const entrypointLstat = await fsp.lstat(requestedEntrypoint).catch(() => {
    throw new HostedAppError('hosted_app_entrypoint_missing', 'entrypoint does not exist', 400);
  });
  if (entrypointLstat.isSymbolicLink()) {
    throw new HostedAppError('hosted_app_path_escape', 'entrypoint must not be a symbolic link', 400);
  }
  const entrypoint = await fsp.realpath(requestedEntrypoint);
  if (!isInside(realRoot, entrypoint)) {
    throw new HostedAppError('hosted_app_path_escape', 'entrypoint escapes the session workspace', 400);
  }
  const entrypointStat = await fsp.stat(entrypoint);
  if (!entrypointStat.isFile()) {
    throw new HostedAppError('hosted_app_entrypoint_missing', 'entrypoint is not a file', 400);
  }
  return { cwd, entrypoint };
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  const bytes = Buffer.byteLength(next);
  if (bytes <= config.hosted_app_log_max_bytes) return next;
  return Buffer.from(next).subarray(bytes - config.hosted_app_log_max_bytes).toString();
}

async function commandSucceeds(binary: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(binary, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hosted apps receive inbound preview traffic, but may not initiate network
 * connections. Besides blocking internet egress, this prevents the untrusted
 * app UID from calling the root-owned control listener on localhost. Reply
 * packets for accepted inbound connections remain allowed by conntrack.
 */
export async function installHostedAppNetworkGuard(uid: number): Promise<void> {
  for (const binary of ['/usr/sbin/iptables', '/usr/sbin/ip6tables']) {
    if (!(await commandSucceeds(binary, ['-w', '5', '-L', HOSTED_APP_EGRESS_CHAIN]))) {
      await execFileAsync(binary, ['-w', '5', '-N', HOSTED_APP_EGRESS_CHAIN]);
    }
    await execFileAsync(binary, ['-w', '5', '-F', HOSTED_APP_EGRESS_CHAIN]);
    await execFileAsync(binary, [
      '-w', '5', '-A', HOSTED_APP_EGRESS_CHAIN,
      '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT',
    ]);
    await execFileAsync(binary, ['-w', '5', '-A', HOSTED_APP_EGRESS_CHAIN, '-j', 'REJECT']);
    const jump = [
      '-m', 'owner', '--uid-owner', String(uid), '-j', HOSTED_APP_EGRESS_CHAIN,
    ];
    if (!(await commandSucceeds(binary, ['-w', '5', '-C', 'OUTPUT', ...jump]))) {
      await execFileAsync(binary, ['-w', '5', '-I', 'OUTPUT', '1', ...jump]);
    }
  }
}

/** Create a process-tree boundary owned only by the root runner. The launcher
 * moves itself here before dropping to the session UID, so every descendant
 * inherits the cgroup and cannot escape it by daemonizing or calling setsid. */
export async function prepareHostedAppCgroup(): Promise<void> {
  await fsp.mkdir(HOSTED_APP_CGROUP, { recursive: true });
  /* cgroup.kill (Linux 5.14+) is required, not an optional optimization: it is
   * the primitive that prevents a setsid()/double-fork descendant escaping
   * revision replacement. Fail closed on kernels that do not expose it. */
  await fsp.access(path.join(HOSTED_APP_CGROUP, 'cgroup.kill'));
  await killHostedAppCgroup();
  await fsp.writeFile(path.join(HOSTED_APP_CGROUP, 'memory.max'), String(
    config.hosted_app_memory_max_bytes,
  ));
  await fsp.writeFile(path.join(HOSTED_APP_CGROUP, 'pids.max'), String(
    config.hosted_app_pids_max,
  ));
}

/** `cgroup.kill` reaches descendants that changed session/process group. */
export async function killHostedAppCgroup(): Promise<void> {
  try {
    await fsp.writeFile(path.join(HOSTED_APP_CGROUP, 'cgroup.kill'), '1');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const deadline = Date.now() + config.hosted_app_stop_timeout_ms;
  while (true) {
    const events = await fsp.readFile(
      path.join(HOSTED_APP_CGROUP, 'cgroup.events'),
      'utf8',
    );
    if (/^populated 0$/m.test(events)) return;
    if (Date.now() >= deadline) {
      throw new Error('hosted-app cgroup did not become empty');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function probeHostedAppPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const fail = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', fail);
    socket.once('timeout', fail);
  });
}

function killHostedAppProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function publicStatus(active: ActiveHostedApp): HostedAppStatus {
  return { ...active.status };
}

export class HostedAppSupervisor {
  private active: ActiveHostedApp | undefined;
  private readonly revisionSpecs = new Map<string, string>();
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HostedAppDependencies = {
    getSession: getBoundSessionWorkspace,
    resolveRuntime: getLatestRuntimeMatchingLanguageVersion,
    listRuntimes: getRuntimes,
    prepareRuntimeWorkspace: prepareHostedAppRuntimeWorkspace,
    spawnApp: (command, args, options) => spawn(command, args, options) as unknown as HostedAppChild,
    prepareCgroup: prepareHostedAppCgroup,
    killCgroup: killHostedAppCgroup,
    installNetworkGuard: installHostedAppNetworkGuard,
    probePort: probeHostedAppPort,
    killProcessGroup: killHostedAppProcessGroup,
    now: () => new Date(),
  }) {}

  status(): HostedAppStatus | undefined {
    return this.active ? publicStatus(this.active) : undefined;
  }

  async start(rawRequest: unknown): Promise<HostedAppStatus> {
    return this.serialize(() => this.startImpl(rawRequest));
  }

  async stop(): Promise<HostedAppStatus | undefined> {
    return this.serialize(async () => {
      try {
        return await this.stopImpl();
      } catch (error) {
        logger.error({ err: error }, 'Hosted-app stop cleanup failed');
        throw new HostedAppError(
          'hosted_app_cleanup_failed',
          'the hosted app could not be stopped safely',
          503,
        );
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  async withQuiescedWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const state = this.active?.status.state;
      if (state === 'starting' || state === 'running' || state === 'stopping') {
        throw new HostedAppError(
          'hosted_app_workspace_busy',
          'the hosted app must be stopped before accessing its workspace',
          409,
        );
      }
      if (this.active && !this.active.cgroupDrained) {
        try {
          await this.deps.killCgroup();
          this.active.cgroupDrained = true;
        } catch (error) {
          logger.error(
            { err: error, appId: this.active.request.app_id },
            'Hosted-app cgroup cleanup failed before workspace mutation',
          );
          throw new HostedAppError(
            'hosted_app_cleanup_failed',
            'the hosted app workspace is not safe to replace',
            503,
          );
        }
      }
      return operation();
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transition;
    let release!: () => void;
    this.transition = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async startImpl(rawRequest: unknown): Promise<HostedAppStatus> {
    const request = normalizeHostedAppRequest(rawRequest);
    const specKey = canonicalSpecKey(request);
    const revisionKey = `${request.app_id}\0${request.revision}`;
    const rememberedSpec = this.revisionSpecs.get(revisionKey);
    if (rememberedSpec !== undefined && rememberedSpec !== specKey) {
      throw new HostedAppError(
        'hosted_app_revision_conflict',
        'an app revision is immutable; use a new revision for changed launch settings',
        409,
      );
    }
    if (this.active?.status.state === 'running' && this.active.specKey === specKey) {
      return publicStatus(this.active);
    }
    const session = this.deps.getSession();
    if (!session) {
      throw new HostedAppError(
        'hosted_app_session_required',
        'a bound stateful runtime session is required',
        409,
      );
    }
    const runtime = this.deps.resolveRuntime(request.language, request.version);
    if (!runtime) {
      throw new HostedAppError(
        'hosted_app_runtime_not_found',
        `runtime ${request.language}@${request.version} is not installed`,
        400,
      );
    }
    if (runtime.compiled) {
      throw new HostedAppError(
        'hosted_app_runtime_unsupported',
        'compiled runtimes are not supported by the resident-server adapter',
        400,
      );
    }

    const ownership = await session.ownership();
    await resolveWorkspacePaths(ownership.dir, request);
    if (rememberedSpec === undefined) {
      if (this.revisionSpecs.size >= MAX_TRACKED_APP_REVISIONS) {
        throw new HostedAppError(
          'hosted_app_revision_limit',
          'the hosted app revision limit for this runtime session was reached',
          409,
        );
      }
      this.revisionSpecs.set(revisionKey, specKey);
    }
    await this.stopImpl();
    const runtimeEnv = { ...runtime.env_vars };
    let nodeModulesPath: string | undefined;
    if (runtime.language === 'bash') {
      const linkTarget: { nodeModulesPath?: string } = {};
      aggregateBashExtras(runtime.pkgdir, runtimeEnv, this.deps.listRuntimes(), linkTarget);
      nodeModulesPath = linkTarget.nodeModulesPath;
    }
    await this.deps.prepareRuntimeWorkspace(ownership.dir, runtime, nodeModulesPath);
    /* The previous process shared this workspace UID and could have changed a
     * validated path before it exited. Re-resolve after the process/cgroup are
     * gone; the preflight above exists to avoid stopping it for ordinary
     * configuration errors, while this check is authoritative for launch. */
    const workspace = await resolveWorkspacePaths(ownership.dir, request);
    try {
      await this.deps.prepareCgroup();
      await this.deps.installNetworkGuard(ownership.uid);
    } catch (error) {
      logger.error({ err: error, uid: ownership.uid }, 'Hosted-app isolation setup failed');
      throw new HostedAppError(
        'hosted_app_isolation_failed',
        'hosted app could not be started safely',
        503,
      );
    }

    const status: HostedAppStatus = {
      app_id: request.app_id,
      revision: request.revision,
      state: 'starting',
      port: config.hosted_app_port,
      started_at: this.deps.now().toISOString(),
      stdout: '',
      stderr: '',
    };
    const active: ActiveHostedApp = { request, specKey, cgroupDrained: false, status };
    this.active = active;

    const callerEnv = filterExtraEnvVars(request.env);
    for (const key of Object.keys(callerEnv)) {
      if (key.toUpperCase() === 'PORT' || key.toUpperCase() === 'HOST') {
        delete callerEnv[key];
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...callerEnv,
      ...runtimeEnv,
      HOME: ownership.dir,
      HOST: '0.0.0.0',
      PORT: String(config.hosted_app_port),
      SANDBOX_LANGUAGE: runtime.language,
    };
    const command = HOSTED_APP_LAUNCHER;
    const args = [
      HOSTED_APP_CGROUP,
      String(ownership.uid),
      String(ownership.gid),
      '/bin/bash',
      path.join(runtime.pkgdir, 'run'),
      workspace.entrypoint,
      ...request.args,
    ];

    let child: HostedAppChild;
    try {
      child = this.deps.spawnApp(command, args, {
        cwd: workspace.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      active.status.state = 'failed';
      active.status.exited_at = this.deps.now().toISOString();
      active.status.message = 'hosted app process could not be spawned';
      throw new HostedAppError('hosted_app_spawn_failed', active.status.message, 500);
    }
    active.process = child;
    active.status.pid = child.pid;
    child.stdout.on('data', chunk => {
      active.status.stdout = appendBounded(active.status.stdout, chunk);
    });
    child.stderr.on('data', chunk => {
      active.status.stderr = appendBounded(active.status.stderr, chunk);
    });
    child.once('error', error => {
      active.status.state = 'failed';
      active.status.exited_at = this.deps.now().toISOString();
      active.status.message = error.message;
    });
    child.once('exit', (code, signal) => {
      active.process = undefined;
      active.status.exited_at = this.deps.now().toISOString();
      if (code !== null) active.status.exit_code = code;
      if (signal !== null) active.status.signal = signal;
      if (active.status.state === 'stopping') {
        active.status.state = 'stopped';
      } else if (active.status.state !== 'stopped') {
        active.status.state = 'failed';
        active.status.message ??= 'hosted app exited';
      }
      /* A daemonized descendant can outlive the tracked launcher process and
       * process group. Queue unexpected cleanup in the same transition chain
       * as start/stop: a detached sweep must never land after a new revision
       * has entered this shared cgroup. */
      if (active.status.state !== 'stopped') {
        void this.serialize(async () => {
          if (this.active !== active || active.status.state === 'stopped') return;
          await this.deps.killCgroup();
          active.cgroupDrained = true;
        }).catch(error => {
          logger.error(
            { err: error, appId: active.request.app_id },
            'Hosted-app cgroup cleanup failed',
          );
        });
      }
    });

    const deadline = Date.now() + config.hosted_app_start_timeout_ms;
    while (Date.now() < deadline) {
      if (active.status.state === 'failed') {
        await this.stopImpl(true);
        active.status.state = 'failed';
        throw new HostedAppError(
          'hosted_app_start_failed',
          active.status.message ?? 'hosted app exited before becoming ready',
          502,
        );
      }
      const ready = await this.deps.probePort(config.hosted_app_port);
      if (active.process !== child || active.status.state === 'failed') {
        await this.stopImpl(true);
        active.status.state = 'failed';
        throw new HostedAppError(
          'hosted_app_start_failed',
          active.status.message ?? 'hosted app exited before becoming ready',
          502,
        );
      }
      if (ready) {
        active.status.state = 'running';
        logger.info(
          { appId: request.app_id, revision: request.revision, pid: child.pid },
          'Hosted app started',
        );
        return publicStatus(active);
      }
      await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS));
    }

    active.status.message = `hosted app did not listen on port ${config.hosted_app_port}`;
    await this.stopImpl(true);
    active.status.state = 'failed';
    throw new HostedAppError('hosted_app_start_timeout', active.status.message, 504);
  }

  private async stopImpl(preserveActive = false): Promise<HostedAppStatus | undefined> {
    const active = this.active;
    if (!active) return undefined;
    const child = active.process;
    if (!child?.pid) {
      await this.deps.killCgroup();
      active.cgroupDrained = true;
      active.status.state = 'stopped';
      active.status.exited_at ??= this.deps.now().toISOString();
      if (!preserveActive) this.active = undefined;
      return publicStatus(active);
    }

    active.status.state = 'stopping';
    this.deps.killProcessGroup(child.pid, 'SIGTERM');
    const exited = new Promise<boolean>(resolve => child.once('exit', () => resolve(true)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), config.hosted_app_stop_timeout_ms);
      timer.unref?.();
    });
    const stopped = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    if (!stopped && active.process?.pid) {
      await this.deps.killCgroup();
      await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, config.hosted_app_stop_timeout_ms)),
      ]);
    }
    /* Always sweep the cgroup: the tracked parent may have exited cleanly
     * while a daemonized descendant stayed alive in a different process group. */
    await this.deps.killCgroup();
    active.cgroupDrained = true;
    active.status.state = 'stopped';
    active.status.exited_at ??= this.deps.now().toISOString();
    const status = publicStatus(active);
    if (!preserveActive) this.active = undefined;
    return status;
  }
}

export function validateHostedAppStartup(): void {
  if (!config.hosted_apps_enabled) return;
  const bindParts = config.bind_address.split(':');
  const runnerPort = Number(bindParts[bindParts.length - 1]);
  const failures: string[] = [];
  if (!config.session_workspace_enabled) {
    failures.push('SANDBOX_SESSION_WORKSPACE_ENABLED must be true');
  }
  if (config.hosted_app_port < 1024 || config.hosted_app_port > 65535) {
    failures.push('SANDBOX_HOSTED_APP_PORT must be between 1024 and 65535');
  }
  if (config.hosted_app_port === runnerPort) {
    failures.push('SANDBOX_HOSTED_APP_PORT must differ from PORT');
  }
  if (!config.use_cgroupv2) {
    failures.push('SANDBOX_USE_CGROUPV2 must be true');
  }
  if (process.getuid?.() !== 0) {
    failures.push('the dedicated hosted-app runner must start as root');
  }
  if (failures.length > 0) {
    throw new Error(`Invalid hosted-app runner configuration: ${failures.join('; ')}`);
  }
}

export const hostedAppSupervisor = new HostedAppSupervisor();
