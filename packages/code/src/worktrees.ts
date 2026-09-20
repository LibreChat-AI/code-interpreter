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
import { GitSourceSnapshot } from './git-snapshot.js';

const execFileAsync = promisify(execFile);
const WORKTREE_INSTANCE_PATTERN = /^[a-f0-9]{64}$/;
const COMPLETION_TEMP_PATTERN = /^[a-f0-9]{64}\.complete\.[a-f0-9-]+\.tmp$/;
const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60_000;

export interface GitWorktreeSource {
  identity: WorkspaceRootIdentity;
  root: string;
}

export interface GitWorktreeInstance {
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
    signal?: AbortSignal
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
  timeout = GIT_TIMEOUT_MS
): Promise<string> {
  const execution = execFileAsync(
    'git',
    ['--no-optional-locks', '-C', root, ...args],
    {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: 16 * 1024,
      signal,
      timeout,
    }
  );
  const closed = new Promise<void>((resolve) =>
    execution.child.once('close', () => resolve())
  );
  try {
    return (await execution).stdout.trim();
  } finally {
    // execFile's AbortError callback can run before its child exits. Retain the
    // provisioning lock and directory until the writer is actually gone.
    const killTimer = setTimeout(() => execution.child.kill('SIGKILL'), 1000);
    killTimer.unref();
    try {
      await closed;
    } finally {
      clearTimeout(killTimer);
    }
  }
}

async function sourceConfig(
  root: string,
  key: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const remote = await git(
      root,
      [
        'config',
        '--no-includes',
        '--file',
        join(root, 'source-config'),
        '--get',
        key,
      ],
      signal
    );
    return remote || undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function hasCommittedHead(
  root: string,
  signal?: AbortSignal
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

export class GitWorktreeManager {
  private readonly instances = new Map<string, GitWorktreeInstance>();
  private readonly sourceSnapshots = new Map<
    string,
    Promise<GitSourceSnapshot>
  >();
  private canonicalRoot?: Promise<{
    identity: WorkspaceRootIdentity;
    path: string;
  }>;

  constructor(private readonly options: GitWorktreeManagerOptions) {
    if (
      !Number.isSafeInteger(options.maxCount) ||
      options.maxCount < 1 ||
      options.maxCount > 1024 ||
      options.sources.size === 0
    ) {
      throw new Error(
        'Conversation worktree capacity must be between 1 and 1024'
      );
    }
    if (
      options.cloneTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.cloneTimeoutMs) ||
        options.cloneTimeoutMs < GIT_TIMEOUT_MS ||
        options.cloneTimeoutMs > 30 * 60_000)
    ) {
      throw new Error(
        'Conversation worktree clone timeout must be between 30000 and 1800000 milliseconds'
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
          'Conversation worktree root must not be group or world writable'
        );
      }
      for (const source of this.options.sources.values()) {
        const sourceRoot = await realpath(source.root);
        if (isInside(sourceRoot, root) || isInside(root, sourceRoot)) {
          throw new Error(
            'Conversation worktree storage must not overlap a source workspace'
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
    instanceId: string
  ): Promise<string> {
    const sourceDirectory = createHash('sha256')
      .update(sourceWorkspaceId)
      .digest('hex')
      .slice(0, 24);
    return join(await this.root(), sourceDirectory, instanceId);
  }

  async plannedRoot(
    sourceWorkspaceId: string,
    instanceId: string
  ): Promise<string> {
    if (!WORKTREE_INSTANCE_PATTERN.test(instanceId)) {
      throw new Error(
        'Conversation worktree identity must be a SHA-256 digest'
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
        await this.sourceSnapshot(sourceRoot, source);
      })
    );
  }

  private async admittedSourceRoot(source: GitWorktreeSource): Promise<string> {
    const sourceRoot = await realpath(source.root);
    if (!(await matchesWorkspaceRoot(sourceRoot, source.identity))) {
      throw new Error('Conversation worktree source changed after admission');
    }
    return sourceRoot;
  }

  private async sourceSnapshot(
    root: string,
    source: GitWorktreeSource
  ): Promise<GitSourceSnapshot> {
    let snapshot = this.sourceSnapshots.get(root);
    if (!snapshot) {
      snapshot = GitSourceSnapshot.admit(source.identity);
      this.sourceSnapshots.set(root, snapshot);
    }
    const admitted = await snapshot;
    await admitted.validate();
    return admitted;
  }

  private async countInstances(): Promise<number> {
    const root = await this.root();
    const sourceDirectories = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const sourceDirectory of sourceDirectories) {
      if (sourceDirectory.name.startsWith(PROVISIONING_LOCK)) continue;
      if (
        !/^[a-f0-9]{24}$/.test(sourceDirectory.name) ||
        !sourceDirectory.isDirectory() ||
        sourceDirectory.isSymbolicLink()
      )
        continue;
      const entries = await readdir(join(root, sourceDirectory.name), {
        withFileTypes: true,
      });
      const reserved = new Set<string>();
      for (const entry of entries) {
        const id = entry.name.endsWith('.complete')
          ? entry.name.slice(0, -9)
          : '';
        if (!WORKTREE_INSTANCE_PATTERN.test(id)) continue;
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error('Invalid worktree reservation');
        if (
          await this.hasCompletionMarker(join(root, sourceDirectory.name, id))
        ) {
          reserved.add(id);
          count += 1;
        }
      }
      for (const entry of entries) {
        if (entry.isFile() && COMPLETION_TEMP_PATTERN.test(entry.name)) {
          await rm(join(root, sourceDirectory.name, entry.name), {
            force: true,
          });
          continue;
        }
        if (
          !WORKTREE_INSTANCE_PATTERN.test(entry.name) ||
          !entry.isDirectory() ||
          entry.isSymbolicLink()
        )
          continue;
        const path = join(root, sourceDirectory.name, entry.name);
        if (!reserved.has(entry.name)) {
          await rm(path, { recursive: true, force: true });
          await rm(this.completionMarker(path), { force: true });
        }
      }
    }
    return count;
  }

  private async withProvisioningLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    return await withProcessLock(
      join(await this.root(), PROVISIONING_LOCK),
      operation,
      signal
    );
  }

  private completionMarker(path: string): string {
    return `${path}.complete`;
  }

  private async hasCompletionMarker(
    path: string,
    source?: WorkspaceRootIdentity,
    sourceGit?: string
  ): Promise<boolean> {
    try {
      const record = JSON.parse(
        await readFile(this.completionMarker(path), 'utf8')
      ) as {
        version?: unknown;
        source?: Partial<WorkspaceRootIdentity>;
        provisioningFailed?: boolean;
        sourceGit?: string;
      };
      const valid =
        record.version === 2 &&
        typeof record.sourceGit === 'string' &&
        WORKTREE_INSTANCE_PATTERN.test(record.sourceGit) &&
        typeof record.source?.path === 'string' &&
        typeof record.source.dev === 'string' &&
        typeof record.source.ino === 'string';
      if (!valid)
        throw new Error(
          'Conversation worktree completion record is invalid; existing checkout preserved'
        );
      if (
        source != null &&
        (record.source!.path !== source.path ||
          record.source!.dev !== source.dev ||
          record.source!.ino !== source.ino ||
          record.sourceGit !== sourceGit)
      ) {
        throw new Error(
          'Conversation worktree source identity changed; existing checkout preserved'
        );
      }
      if (source != null && record.provisioningFailed) {
        throw new Error(
          'Conversation worktree setup cleanup is unconfirmed; operator recovery required'
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return false;
      }
      throw error;
    }
  }

  private async writeCompletionMarker(
    path: string,
    source: WorkspaceRootIdentity,
    sourceGit: string,
    provisioningFailed = false
  ): Promise<void> {
    const marker = this.completionMarker(path);
    const temporary = `${marker}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({
          version: 2,
          source,
          sourceGit,
          ...(provisioningFailed ? { provisioningFailed: true } : {}),
        })}\n`,
        { mode: 0o600, flag: 'wx' }
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
    signal?: AbortSignal
  ): Promise<GitWorktreeInstance> {
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || !isInside(await this.root(), canonicalPath)) {
      throw new Error(
        'Conversation worktree escaped its configured storage root'
      );
    }
    signal?.throwIfAborted();
    const instanceCommon = join(canonicalPath, '.git');
    const gitMetadata = await lstat(instanceCommon);
    if (
      !gitMetadata.isDirectory() ||
      gitMetadata.isSymbolicLink() ||
      (await realpath(instanceCommon)) !== instanceCommon
    ) {
      throw new Error('Conversation worktree does not own its Git metadata');
    }
    try {
      await lstat(join(instanceCommon, 'commondir'));
      throw new Error(
        'Conversation worktree must not redirect its Git metadata'
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    const instanceObjects = await realpath(join(instanceCommon, 'objects'));
    if (!isInside(canonicalPath, instanceObjects)) {
      throw new Error('Conversation worktree does not own its Git objects');
    }
    try {
      await lstat(join(instanceObjects, 'info', 'alternates'));
      throw new Error(
        'Conversation worktree must not use external Git objects'
      );
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
    sourceGit: string,
    signal?: AbortSignal
  ): Promise<GitWorktreeInstance> {
    if (!(await this.hasCompletionMarker(path, source, sourceGit))) {
      const error = new Error('Conversation worktree is incomplete');
      Object.assign(error, { code: 'EINCOMPLETE' });
      throw error;
    }
    return await this.validateRepository(
      sourceWorkspaceId,
      instanceId,
      path,
      signal
    );
  }

  private async createLocked(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal
  ): Promise<GitWorktreeInstance> {
    if (!WORKTREE_INSTANCE_PATTERN.test(instanceId)) {
      throw new Error(
        'Conversation worktree identity must be a SHA-256 digest'
      );
    }
    const source = this.options.sources.get(sourceWorkspaceId);
    if (!source) throw new Error('Conversation worktree source is unavailable');
    const sourceRoot = await this.admittedSourceRoot(source);
    const snapshot = await this.sourceSnapshot(sourceRoot, source);
    const path = await this.instancePath(sourceWorkspaceId, instanceId);
    try {
      return await this.validateExisting(
        sourceWorkspaceId,
        instanceId,
        path,
        source.identity,
        snapshot.fingerprint,
        signal
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
    const staging = `${path}.source`;
    try {
      // Reserve before launching any writer. A worker crash may leave a Git
      // child or setup executor alive after the parent's kernel lock releases.
      // Recovery must not sweep or reuse that uncertain directory.
      await this.writeCompletionMarker(
        path,
        source.identity,
        snapshot.fingerprint,
        true
      );
      const cloneSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(
          this.options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS
        ),
      ]);
      await snapshot.copyTo(staging, cloneSignal);
      const remote = await sourceConfig(
        staging,
        'remote.origin.url',
        cloneSignal
      );
      const objectFormat = await sourceConfig(
        staging,
        'extensions.objectformat',
        cloneSignal
      );
      if (
        objectFormat &&
        objectFormat !== 'sha1' &&
        objectFormat !== 'sha256'
      ) {
        throw new Error('Unsupported source Git object format');
      }
      if (objectFormat === 'sha256') {
        await writeFile(
          join(staging, 'config'),
          '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n',
          { mode: 0o600 }
        );
      }
      await git(
        resolve(path, '..'),
        ['clone', '--local', '--no-checkout', '--no-tags', staging, path],
        cloneSignal,
        this.options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS
      );
      await rm(staging, { recursive: true, force: true });
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
        signal
      );
      instance = await this.validateRepository(
        sourceWorkspaceId,
        instanceId,
        path,
        signal
      );
      await this.options.prepareInstance?.(instance, signal);
      signal?.throwIfAborted();
      if (!(await matchesWorkspaceRoot(instance.root, instance.identity))) {
        throw new Error('Conversation worktree changed during setup');
      }
      await this.validateRepository(
        sourceWorkspaceId,
        instanceId,
        path,
        signal
      );
      await this.admittedSourceRoot(source);
      await snapshot.validate();
      await this.writeCompletionMarker(
        path,
        source.identity,
        snapshot.fingerprint
      );
      return instance;
    } catch (error) {
      if (instance) {
        // The reservation remains until executor cleanup is confirmed.
        await this.options.discardInstance?.(instance);
      }
      await rm(path, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      await rm(this.completionMarker(path), { force: true });
      throw error;
    }
  }

  private async create(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal
  ): Promise<GitWorktreeInstance> {
    return await this.withProvisioningLock(
      () => this.createLocked(sourceWorkspaceId, instanceId, signal),
      signal
    );
  }

  async resolve(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal
  ): Promise<GitWorktreeInstance> {
    signal?.throwIfAborted();
    const key = this.key(sourceWorkspaceId, instanceId);
    const cached = this.instances.get(key);
    if (cached) {
      await this.root();
      const source = this.options.sources.get(sourceWorkspaceId)!;
      await this.sourceSnapshot(await this.admittedSourceRoot(source), source);
      if (!(await matchesWorkspaceRoot(cached.root, cached.identity))) {
        this.instances.delete(key);
        throw new Error('Conversation worktree changed after admission');
      }
      await this.validateRepository(
        sourceWorkspaceId,
        instanceId,
        cached.root,
        signal
      );
      return cached;
    }
    // The same kernel lock coordinates callers and processes. Keep cancellation
    // attached through setup and cleanup; never release a lease while detached
    // provisioning is still mutating the checkout.
    const instance = await this.create(sourceWorkspaceId, instanceId, signal);
    this.instances.set(key, instance);
    return instance;
  }
}
