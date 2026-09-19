import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceRootIdentity } from './root-identity.js';

const execFileAsync = promisify(execFile);
const WORKTREE_INSTANCE_PATTERN = /^[a-f0-9]{64}$/;
const GIT_TIMEOUT_MS = 30_000;

export interface GitWorktreeSource {
  identity?: WorkspaceRootIdentity;
  root: string;
}

export interface GitWorktreeInstance {
  gitCommonDirectory: string;
  id: string;
  identity: WorkspaceRootIdentity;
  root: string;
  sourceWorkspaceId: string;
}

export interface GitWorktreeManagerOptions {
  maxCount: number;
  root: string;
  sources: ReadonlyMap<string, GitWorktreeSource>;
}

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
): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', root, ...args],
    {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: 16 * 1024,
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return result.stdout.trim();
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
  private readonly sourceCommonDirectories = new Map<string, Promise<string>>();
  private canonicalRoot?: Promise<string>;
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
  }

  private async root(): Promise<string> {
    this.canonicalRoot ??= (async () => {
      await mkdir(resolve(this.options.root), {
        mode: 0o700,
        recursive: true,
      });
      const root = await realpath(this.options.root);
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
      return root;
    })();
    return await this.canonicalRoot;
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
      [...this.options.sources].map(([workspaceId, source]) =>
        this.sourceCommonDirectory(workspaceId, source.root),
      ),
    );
  }

  private async countInstances(): Promise<number> {
    const root = await this.root();
    const sourceDirectories = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const sourceDirectory of sourceDirectories) {
      if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink())
        continue;
      const entries = await readdir(join(root, sourceDirectory.name), {
        withFileTypes: true,
      });
      count += entries.filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
      ).length;
    }
    return count;
  }

  private sourceCommonDirectory(
    sourceWorkspaceId: string,
    sourceRoot: string,
  ): Promise<string> {
    let directory = this.sourceCommonDirectories.get(sourceWorkspaceId);
    if (!directory) {
      directory = commonDirectory(sourceRoot);
      this.sourceCommonDirectories.set(sourceWorkspaceId, directory);
    }
    return directory;
  }

  private async validateExisting(
    sourceWorkspaceId: string,
    sourceRoot: string,
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
    const [sourceCommon, instanceCommon] = await Promise.all([
      this.sourceCommonDirectory(sourceWorkspaceId, sourceRoot),
      commonDirectory(canonicalPath, signal),
    ]);
    if (sourceCommon !== instanceCommon) {
      throw new Error(
        'Conversation worktree belongs to a different repository',
      );
    }
    return {
      gitCommonDirectory: sourceCommon,
      id: instanceId,
      identity: await directoryIdentity(canonicalPath),
      root: canonicalPath,
      sourceWorkspaceId,
    };
  }

  private async create(
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
    const sourceRoot = await realpath(source.root);
    const path = await this.instancePath(sourceWorkspaceId, instanceId);
    try {
      return await this.validateExisting(
        sourceWorkspaceId,
        sourceRoot,
        instanceId,
        path,
        signal,
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
    if ((await this.countInstances()) >= this.options.maxCount) {
      throw new Error('Conversation worktree capacity is exhausted');
    }
    await mkdir(resolve(path, '..'), { mode: 0o700, recursive: true });
    const branch = this.branch(sourceWorkspaceId, instanceId);
    try {
      await git(
        sourceRoot,
        ['worktree', 'add', '--no-checkout', '-b', branch, path, 'HEAD'],
        signal,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('already exists')
      )
        throw error;
      await git(
        sourceRoot,
        ['worktree', 'add', '--no-checkout', path, branch],
        signal,
      );
    }
    try {
      await git(path, ['checkout', '--force'], signal);
      return await this.validateExisting(
        sourceWorkspaceId,
        sourceRoot,
        instanceId,
        path,
        signal,
      );
    } catch (error) {
      await git(sourceRoot, ['worktree', 'remove', '--force', path]).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async resolve(
    sourceWorkspaceId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeInstance> {
    signal?.throwIfAborted();
    const key = this.key(sourceWorkspaceId, instanceId);
    const cached = this.instances.get(key);
    if (cached) return cached;
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
