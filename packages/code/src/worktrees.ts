import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { matchesWorkspaceRoot } from './root-identity.js';
import type { WorkspaceRootIdentity } from './root-identity.js';
import { assertPrivateStorageAncestors } from './private-storage.js';
import { withProcessLock } from './process-lock.js';

const execFileAsync = promisify(execFile);
const WORKTREE_INSTANCE_PATTERN = /^[a-f0-9]{64}$/;
const COMPLETION_TEMP_PATTERN =
  /^[a-f0-9]{64}\.complete\.[a-f0-9-]+\.tmp$/;
const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60_000;

export interface GitWorktreeSource {
  identity: WorkspaceRootIdentity;
  root: string;
}

export interface GitWorktreeInstance {
  gitSharedObjectDirectory: string;
  id: string;
  identity: WorkspaceRootIdentity;
  root: string;
  sourceWorkspaceId: string;
}

export interface GitWorktreeManagerOptions {
  cloneTimeoutMs?: number;
  maxCount: number;
  root: string;
  sources: ReadonlyMap<string, GitWorktreeSource>;
  prepareInstance?: (
    instance: GitWorktreeInstance,
    signal?: AbortSignal,
  ) => Promise<void>;
  discardInstance?: (instance: GitWorktreeInstance) => Promise<void> | void;
}

const PROVISIONING_LOCK = '.provision.lock';

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', root, ...args],
    {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: 16 * 1024,
      signal,
      timeout,
    },
  );
  return result.stdout.trim();
}

async function sourceRemote(root: string): Promise<string | undefined> {
  try {
    const remote = await git(root, ['remote', 'get-url', 'origin']);
    return remote || undefined;
  } catch {
    return undefined;
  }
}

async function hasCommittedHead(
  root: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD'], signal);
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && 'code' in error && error.code === 128) {
      return false;
    }
    throw error;
  }
}

async function directoryIdentity(path: string): Promise<WorkspaceRootIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Conversation worktree must be a real directory');
  }
  return {
    path,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
  };
}

async function commonDirectory(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = await git(
    root,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    signal,
  );
  return await realpath(path);
}

export class GitWorktreeManager {
  private readonly inFlight = new Map<string, Promise<GitWorktreeInstance>>();
  private readonly instances = new Map<string, GitWorktreeInstance>();
  private canonicalRoot?: Promise<{
    identity: WorkspaceRootIdentity;
    path: string;
  }>;
  private provisioning: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GitWorktreeManagerOptions) {
    if (
      !Number.isSafeInteger(options.maxCount) ||
      options.maxCount < 1 ||
      options.maxCount > 1024 ||
      options.sources.size === 0
    ) {
      throw new Error(
        'Conversation worktree capacity must be between 1 and 1024',
      );
    }
    if (
      options.cloneTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.cloneTimeoutMs) ||
        options.cloneTimeoutMs < GIT_TIMEOUT_MS ||
        options.cloneTimeoutMs > 30 * 60_000)
    ) {
      throw new Error(
        'Conversation worktree clone timeout must be between 30000 and 1800000 milliseconds',
      );
    }
  }

  private async root(): Promise<string> {
    this.canonicalRoot ??= (async () => {
      const configuredRoot = resolve(this.options.root);
      await assertPrivateStorageAncestors(configuredRoot, true);
      await mkdir(configuredRoot, {
        mode: 0o700,
        recursive: true,
      });
      await assertPrivateStorageAncestors(configuredRoot);
      const root = await realpath(this.options.root);
      await assertPrivateStorageAncestors(root);
      const metadata = await stat(root);
      if (
        !metadata.isDirectory() ||
        (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0)
      ) {
        throw new Error(
          'Conversation worktree root must not be group or world writable',
        );
      }
      for (const source of this.options.sources.values()) {
        const sourceRoot = await realpath(source.root);
        if (isInside(sourceRoot, root) || isInside(root, sourceRoot)) {
          throw new Error(
            'Conversation worktree storage must not overlap a source workspace',
          );
        }
      }
      return {
        identity: await directoryIdentity(root),
        path: root,
      };
    })();
    const root = await this.canonicalRoot;
    if (!(await matchesWorkspaceRoot(root.path, root.identity))) {
      throw new Error('Conversation worktree storage changed after admission');
    }
    return root.path;
  }

  private key(sourceWorkspaceId: string, instanceId: string): string {
    return `${sourceWorkspaceId}\0${instanceId}`;
  }

  private branch(sourceWorkspaceId: string, instanceId: string): string {
    const source = createHash('sha256')
      .update(sourceWorkspaceId)
      .digest('hex')
      .slice(0, 8);
    return `librechat/conversation-${source}-${instanceId.slice(0, 31)}`;
  }

  private async instancePath(
    sourceWorkspaceId: string,
    instanceId: string,
  ): Promise<string> {
    const sourceDirectory = createHash('sha256')
      .update(sourceWorkspaceId)
      .digest('hex')
      .slice(0, 24);
    return join(await this.root(), sourceDirectory, instanceId);
  }

  async plannedRoot(
    sourceWorkspaceId: string,
    instanceId: string,
  ): Promise<string> {
    if (!WORKTREE_INSTANCE_PATTERN.test(instanceId)) {
      throw new Error(
        'Conversation worktree identity must be a SHA-256 digest',
      );
    }
    if (!this.options.sources.has(sourceWorkspaceId)) {
      throw new Error('Conversation worktree source is unavailable');
    }
    return await this.instancePath(sourceWorkspaceId, instanceId);
  }

  async prepare(): Promise<void> {
    await this.root();
    await Promise.all(
      [...this.options.sources].map(async ([_workspaceId, source]) => {
        const sourceRoot = await this.admittedSourceRoot(source);
        await commonDirectory(sourceRoot);
      }),
    );
  }

  private async admittedSourceRoot(source: GitWorktreeSource): Promise<string> {
    const sourceRoot = await realpath(source.root);
    if (
      !(await matchesWorkspaceRoot(sourceRoot, source.identity))
    ) {
      throw new Error('Conversation worktree source changed after admission');
    }
    return sourceRoot;
  }

  private async countInstances(): Promise<number> {
    const root = await this.root();
    const sourceDirectories = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const sourceDirectory of sourceDirectories) {
      if (sourceDirectory.name.startsWith(PROVISIONING_LOCK)) continue;
      if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink())
        continue;
      const entries = await readdir(join(root, sourceDirectory.name), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile() && COMPLETION_TEMP_PATTERN.test(entry.name)) {
          await rm(join(root, sourceDirectory.name, entry.name), {
            force: true,
          });
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(root, sourceDirectory.name, entry.name);
        if (await this.hasCompletionMarker(path)) {
          count += 1;
        } else {
          await rm(path, { recursive: true, force: true });
          await rm(this.completionMarker(path), { force: true });
        }
      }
    }
    return count;
  }

  private async withProvisioningLock<T>(operation: () => Promise<T>): Promise<T> {
    return await withProcessLock(join(await this.root(), PROVISIONING_LOCK), operation);
  }

  private completionMarker(path: string): string {
    return `${path}.complete`;
  }

  private async hasCompletionMarker(
    path: string,
    source?: WorkspaceRootIdentity,
  ): Promise<boolean> {
    try {
      const record = JSON.parse(
        await readFile(this.completionMarker(path), 'utf8'),
      ) as {
        version?: unknown;
        source?: Partial<WorkspaceRootIdentity>;
      };
      return (
        record.version === 1 &&
        typeof record.source?.path === 'string' &&
        typeof record.source.dev === 'string' &&
        typeof record.source.ino === 'string' &&
        (source == null ||
          (record.source.path === source.path &&
            record.source.dev === source.dev &&
            record.source.ino === source.ino))
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async writeCompletionMarker(
    path: string,
    source: WorkspaceRootIdentity,
  ): Promise<void> {
    const marker = this.completionMarker(path);
    const temporary = `${marker}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, source })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, marker);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async validateRepository(
    sourceWorkspaceId: string,
    instanceId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || !isInside(await this.root(), canonicalPath)) {
      throw new Error(
        'Conversation worktree escaped its configured storage root',
      );
    }
    const instanceCommon = await commonDirectory(canonicalPath, signal);
    if (!isInside(canonicalPath, instanceCommon)) {
      throw new Error('Conversation worktree does not own its Git metadata');
    }
    const instanceObjects = await realpath(join(instanceCommon, 'objects'));
    if (!isInside(canonicalPath, instanceObjects)) {
      throw new Error('Conversation worktree does not own its Git objects');
    }
    try {
      await lstat(join(instanceObjects, 'info', 'alternates'));
      throw new Error('Conversation worktree must not use external Git objects');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    return {
      gitSharedObjectDirectory: instanceObjects,
      id: instanceId,
      identity: await directoryIdentity(canonicalPath),
      root: canonicalPath,
      sourceWorkspaceId,
    };
  }

  private async validateExisting(
    sourceWorkspaceId: string,
    instanceId: string,
    path: string,
    source: WorkspaceRootIdentity,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    if (!(await this.hasCompletionMarker(path, source))) {
      const error = new Error('Conversation worktree is incomplete');
      Object.assign(error, { code: 'EINCOMPLETE' });
      throw error;
    }
    return await this.validateRepository(
      sourceWorkspaceId,
      instanceId,
      path,
      signal,
    );
  }

  private async createLocked(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    if (!WORKTREE_INSTANCE_PATTERN.test(instanceId)) {
      throw new Error(
        'Conversation worktree identity must be a SHA-256 digest',
      );
    }
    const source = this.options.sources.get(sourceWorkspaceId);
    if (!source) throw new Error('Conversation worktree source is unavailable');
    const sourceRoot = await this.admittedSourceRoot(source);
    const path = await this.instancePath(sourceWorkspaceId, instanceId);
    try {
      return await this.validateExisting(
        sourceWorkspaceId,
        instanceId,
        path,
        source.identity,
        signal,
      );
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)) {
        throw error;
      }
      if (error.code === 'EINCOMPLETE') {
        await rm(path, { recursive: true, force: true });
        await rm(this.completionMarker(path), { force: true });
      } else if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    if ((await this.countInstances()) >= this.options.maxCount) {
      throw new Error('Conversation worktree capacity is exhausted');
    }
    await mkdir(resolve(path, '..'), { mode: 0o700, recursive: true });
    const branch = this.branch(sourceWorkspaceId, instanceId);
    let instance: GitWorktreeInstance | undefined;
    try {
      const remote = await sourceRemote(sourceRoot);
      await git(
        resolve(path, '..'),
        [
          'clone',
          '--no-local',
          '--no-hardlinks',
          '--no-checkout',
          '--no-tags',
          sourceRoot,
          path,
        ],
        signal,
        this.options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
      );
      const sourceHasHead = await hasCommittedHead(path, signal);
      if (remote) {
        await git(path, ['remote', 'set-url', 'origin', remote], signal);
      } else {
        await git(path, ['remote', 'remove', 'origin'], signal);
      }
      await git(
        path,
        sourceHasHead
          ? ['checkout', '--force', '-b', branch, 'HEAD']
          : ['checkout', '--orphan', branch],
        signal,
      );
      instance = await this.validateRepository(
        sourceWorkspaceId,
        instanceId,
        path,
        signal,
      );
      await this.options.prepareInstance?.(instance, signal);
      await this.writeCompletionMarker(path, source.identity);
      return instance;
    } catch (error) {
      if (instance) await this.options.discardInstance?.(instance);
      await rm(path, { recursive: true, force: true });
      await rm(this.completionMarker(path), { force: true });
      throw error;
    }
  }

  private async create(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    return await this.withProvisioningLock(() =>
      this.createLocked(sourceWorkspaceId, instanceId, signal),
    );
  }

  async resolve(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    signal?.throwIfAborted();
    const key = this.key(sourceWorkspaceId, instanceId);
    const cached = this.instances.get(key);
    if (cached) {
      await this.root();
      if (!(await matchesWorkspaceRoot(cached.root, cached.identity))) {
        this.instances.delete(key);
        throw new Error('Conversation worktree changed after admission');
      }
      return cached;
    }
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.provisioning.then(() =>
        this.create(sourceWorkspaceId, instanceId),
      );
      this.provisioning = pending.catch(() => undefined);
      this.inFlight.set(key, pending);
      void pending
        .finally(() => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
        })
        .catch(() => undefined);
    }
    const instance =
      signal == null
        ? await pending
        : await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              const abort = (): void =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('aborted', 'AbortError'),
                );
              signal.addEventListener('abort', abort, {
                once: true,
              });
              if (signal.aborted) abort();
              void pending
                .finally(() => signal.removeEventListener('abort', abort))
                .catch(() => undefined);
            }),
          ]);
    this.instances.set(key, instance);
    return instance;
  }
}
