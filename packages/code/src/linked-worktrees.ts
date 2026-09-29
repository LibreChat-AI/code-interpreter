import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { isValidLinkedWorktreeName } from './protocol.js';
import {
  captureWorkspaceRootIdentity,
  matchesWorkspaceRoot,
} from './root-identity.js';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';

import type { NativeWorkspaceCommandPool } from './native-pool.js';
import type { NativeProcessSandboxOptions } from './native-process.js';
import type { WorkspaceRootIdentity } from './root-identity.js';
import type {
  BridgeWorkspaceProgrammaticRequest,
  WorkspaceExecuteCommandRequest,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from './protocol.js';
import type { WorkspaceToolExecutor } from './workspace.js';

/** Linked worktrees are only admitted from this directory beneath a checkout. */
export const LINKED_WORKTREE_DIRECTORY = '.worktrees';
/**
 * Shared Git storage a lane may write beneath the common Git directory. Every
 * other path there (config, hooks, the checkout's own HEAD, index and
 * operation state, sibling metadata) stays read-only.
 */
const LINKED_WORKTREE_SHARED_GIT_PATHS = ['objects', 'refs', join('logs', 'refs'), 'lfs'];
/** Lane registrations kept per worker; the least recently used idle lanes are released first. */
const LINKED_WORKTREE_LANE_LIMIT = 32;
/** Git pointer files are a single line; anything larger is not one. */
const GIT_POINTER_MAX_BYTES = 4096;

export interface LinkedWorktreeSource {
  root: string;
  identity?: WorkspaceRootIdentity;
  command?: NativeProcessSandboxOptions;
  repositoryInstructions: boolean;
  writable: boolean;
}

export interface VerifiedLinkedWorktree {
  root: string;
  identity: WorkspaceRootIdentity;
  checkoutRoot: string;
  commonGitDir: string;
  /** Shared object and ref storage plus the lane's own metadata; nothing else in the common Git directory. */
  writableGitPaths: string[];
}

export interface LinkedWorktreeWorkspaceToolsOptions {
  commandPool?: NativeWorkspaceCommandPool;
  delegate: WorkspaceToolExecutor;
  /** Called with each verified lane root, e.g. to route credentials for its repository. */
  onResolve?: (workspaceId: string, root: string) => void;
  /** Called when a lane root is released, e.g. to drop its credential route. */
  onRelease?: (root: string) => void;
  programmaticDelegate?: {
    executeProgrammatic(
      workspaceId: string,
      request: BridgeWorkspaceProgrammaticRequest,
      signal?: AbortSignal,
    ): Promise<object>;
  };
  sources: ReadonlyMap<string, LinkedWorktreeSource>;
}

export function linkedWorktreeWorkspaceId(workspaceId: string, worktree: string): string {
  return `lane-${createHash('sha256').update(`${workspaceId}\0${worktree}`).digest('hex')}`;
}

function rejected(message: string): WorkspaceToolError {
  return new WorkspaceToolError(message, 'INVALID_REQUEST');
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isDirectory() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readPointer(path: string): Promise<string | undefined> {
  let handle;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > GIT_POINTER_MAX_BYTES) {
      return undefined;
    }
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(GIT_POINTER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > GIT_POINTER_MAX_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function canonicalOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function singleLine(value: string | undefined): string | undefined {
  const line = value?.replace(/\r?\n$/, '');
  return line == null || line.length === 0 || /[\r\n\0]/.test(line) ? undefined : line;
}

/**
 * Verify, without running Git, that `<checkout>/.worktrees/<name>` is a linked
 * worktree of that checkout: a real directory whose `.git` file points at
 * `<checkout>/.git/worktrees/<name>`, whose metadata points back at it, and
 * whose common directory is the checkout's own `.git`. Nothing on the path may
 * be a symlink, so a forged or relocated worktree cannot borrow a lane.
 */
export async function verifyLinkedWorktree(
  checkoutRoot: string,
  name: string,
  checkoutIdentity?: WorkspaceRootIdentity,
): Promise<VerifiedLinkedWorktree> {
  if (!isValidLinkedWorktreeName(name)) {
    throw rejected('Invalid linked worktree name');
  }
  const checkout = await canonicalOrUndefined(checkoutRoot);
  if (checkout == null || !(await realDirectory(checkout))) {
    throw new WorkspaceToolError('Selected project is unavailable', 'REGISTRATION_INVALID');
  }
  if (checkoutIdentity != null && !(await matchesWorkspaceRoot(checkout, checkoutIdentity))) {
    throw new WorkspaceToolError('Selected project changed before lane admission', 'REGISTRATION_INVALID');
  }
  const commonGitDir = join(checkout, '.git');
  const worktreesDirectory = join(checkout, LINKED_WORKTREE_DIRECTORY);
  const root = join(worktreesDirectory, name);
  const metadata = join(commonGitDir, 'worktrees', name);
  if (
    !(await realDirectory(commonGitDir)) ||
    !(await realDirectory(worktreesDirectory)) ||
    !(await realDirectory(root)) ||
    (await canonicalOrUndefined(root)) !== root ||
    !(await realDirectory(metadata)) ||
    (await canonicalOrUndefined(metadata)) !== metadata
  ) {
    throw rejected(`No linked worktree named ${name} in ${LINKED_WORKTREE_DIRECTORY}`);
  }
  const dotGit = join(root, '.git');
  const pointer = singleLine(await readPointer(dotGit))?.match(/^gitdir: (.+)$/)?.[1];
  const gitDir = pointer == null ? undefined : isAbsolute(pointer) ? pointer : resolve(root, pointer);
  const commonPointer = singleLine(await readPointer(join(metadata, 'commondir')));
  const backPointer = singleLine(await readPointer(join(metadata, 'gitdir')));
  if (
    gitDir == null ||
    (await canonicalOrUndefined(gitDir)) !== metadata ||
    commonPointer == null ||
    (await canonicalOrUndefined(resolve(metadata, commonPointer))) !== commonGitDir ||
    backPointer == null ||
    (await canonicalOrUndefined(resolve(metadata, backPointer))) !== dotGit
  ) {
    throw rejected(`${LINKED_WORKTREE_DIRECTORY}/${name} is not a linked worktree of this project`);
  }
  let identity: WorkspaceRootIdentity;
  try {
    identity = await captureWorkspaceRootIdentity(root);
  } catch {
    throw rejected(`${LINKED_WORKTREE_DIRECTORY}/${name} is unavailable`);
  }
  const writableGitPaths = [
    ...LINKED_WORKTREE_SHARED_GIT_PATHS.map((path) => join(commonGitDir, path)),
    metadata,
  ];
  return { root, identity, checkoutRoot: checkout, commonGitDir, writableGitPaths };
}

function publicResult(result: WorkspaceToolResult, workspaceId: string): WorkspaceToolResult {
  return { ...result, workspaceId };
}

/**
 * Route requests that name a linked worktree into their own isolated executor.
 * Code API schedules each `.worktrees/<name>` as its own lane beneath the
 * checkout, so file tools and commands here run confined to that worktree while
 * sibling lanes run concurrently. Requests without a worktree pass through.
 */
export class LinkedWorktreeWorkspaceTools implements WorkspaceToolExecutor {
  readonly mutationFailuresAreAtomic?: true;
  readonly capabilities: WorkspaceToolExecutor['capabilities'];
  private readonly executors = new Map<
    string,
    { fingerprint: string; value: Promise<LocalWorkspaceTools> }
  >();
  private readonly commandRoots = new Map<string, string>();
  /** Verified lane roots by internal ID, least recently used first. */
  private readonly lanes = new Map<string, string>();

  constructor(private readonly options: LinkedWorktreeWorkspaceToolsOptions) {
    this.mutationFailuresAreAtomic = options.delegate.mutationFailuresAreAtomic;
    this.capabilities = {
      ...options.delegate.capabilities,
      workspaces: options.delegate.capabilities.workspaces.map((workspace) => ({
        ...workspace,
        ...(options.sources.has(workspace.id)
          ? { workspaceScopes: ['git_linked_worktree' as const] }
          : {}),
      })),
    };
  }

  private async resolveLane(
    workspaceId: string,
    worktree: string,
    workspaceInstanceId: string | undefined,
  ): Promise<{ lane: VerifiedLinkedWorktree; source: LinkedWorktreeSource; internalId: string }> {
    if (workspaceInstanceId != null) {
      throw rejected('Linked worktree lanes are not available inside conversation worktrees');
    }
    const source = this.options.sources.get(workspaceId);
    if (!source) {
      throw rejected('Workspace does not allow linked worktree lanes');
    }
    const internalId = linkedWorktreeWorkspaceId(workspaceId, worktree);
    let lane: VerifiedLinkedWorktree;
    try {
      lane = await verifyLinkedWorktree(source.root, worktree, source.identity);
    } catch (error) {
      await this.release(internalId);
      throw error;
    }
    this.lanes.delete(internalId);
    this.lanes.set(internalId, lane.root);
    this.options.onResolve?.(workspaceId, lane.root);
    await this.releaseIdleLanes(internalId);
    return { lane, source, internalId };
  }

  /** Forget a lane's executors and routes; a lane still running a command is kept. */
  private async release(internalId: string): Promise<void> {
    const root = this.lanes.get(internalId);
    if (root == null) return;
    if (this.commandRoots.has(internalId)) {
      try {
        await this.options.commandPool?.unregisterRoot(internalId);
      } catch {
        return;
      }
      this.commandRoots.delete(internalId);
    }
    this.executors.delete(internalId);
    this.lanes.delete(internalId);
    this.options.onRelease?.(root);
  }

  private async releaseIdleLanes(current: string): Promise<void> {
    for (const internalId of [...this.lanes.keys()]) {
      if (this.lanes.size <= LINKED_WORKTREE_LANE_LIMIT) return;
      if (internalId !== current) await this.release(internalId);
    }
  }

  private async fileExecutor(
    internalId: string,
    lane: VerifiedLinkedWorktree,
    source: LinkedWorktreeSource,
  ): Promise<LocalWorkspaceTools> {
    const fingerprint = `${lane.identity.path}\0${lane.identity.dev}\0${lane.identity.ino}`;
    let cached = this.executors.get(internalId);
    if (cached == null || cached.fingerprint !== fingerprint) {
      cached = {
        fingerprint,
        value: LocalWorkspaceTools.create({
          repositoryInstructions: source.repositoryInstructions,
          workspaces: [
            { id: internalId, identity: lane.identity, root: lane.root, writable: source.writable },
          ],
        }),
      };
      this.executors.set(internalId, cached);
    }
    return await cached.value;
  }

  /** Register the lane's command root, replacing it when its identity or writable Git paths changed. */
  private async registerCommandRoot(
    internalId: string,
    lane: VerifiedLinkedWorktree,
    source: LinkedWorktreeSource,
  ): Promise<NativeWorkspaceCommandPool> {
    const pool = this.options.commandPool;
    if (!source.command || !pool) {
      throw new WorkspaceToolError('Linked worktree commands are unavailable', 'COMMAND_DISABLED');
    }
    const fingerprint = JSON.stringify([
      lane.identity.path,
      lane.identity.dev,
      lane.identity.ino,
      lane.writableGitPaths,
    ]);
    const registered = this.commandRoots.get(internalId);
    if (registered !== fingerprint) {
      if (registered != null) await pool.unregisterRoot(internalId);
      await pool.registerRoot(internalId, {
        ...source.command,
        workspaceIdentity: lane.identity,
        workspaceRoot: lane.root,
        linkedWorktree: {
          checkoutRoot: lane.checkoutRoot,
          commonGitDir: lane.commonGitDir,
          writableGitPaths: lane.writableGitPaths,
        },
      });
      this.commandRoots.set(internalId, fingerprint);
    }
    return pool;
  }

  async execute(request: WorkspaceToolRequest, signal?: AbortSignal): Promise<WorkspaceToolResult> {
    if (request.worktree == null) {
      return await this.options.delegate.execute(request, signal);
    }
    const { worktree, ...baseRequest } = request;
    const { lane, source, internalId } = await this.resolveLane(
      request.workspaceId,
      worktree,
      request.workspaceInstanceId,
    );
    const laneRequest = { ...baseRequest, workspaceId: internalId } as WorkspaceToolRequest;
    if (request.operation === 'execute_command') {
      const pool = await this.registerCommandRoot(internalId, lane, source);
      return publicResult(
        await pool.execute(laneRequest as WorkspaceExecuteCommandRequest, signal),
        request.workspaceId,
      );
    }
    const executor = await this.fileExecutor(internalId, lane, source);
    return publicResult(await executor.execute(laneRequest, signal), request.workspaceId);
  }

  async executeProgrammatic(
    workspaceId: string,
    request: BridgeWorkspaceProgrammaticRequest,
    signal?: AbortSignal,
  ): Promise<object> {
    const worktree = request.body.workspace_worktree;
    if (worktree == null) {
      if (!this.options.programmaticDelegate) {
        throw new WorkspaceToolError('Workspace programmatic execution is unavailable', 'COMMAND_DISABLED');
      }
      return await this.options.programmaticDelegate.executeProgrammatic(workspaceId, request, signal);
    }
    const { lane, source, internalId } = await this.resolveLane(
      workspaceId,
      worktree,
      request.body.workspace_instance_id,
    );
    const pool = await this.registerCommandRoot(internalId, lane, source);
    const { workspace_worktree: _worktree, ...body } = request.body;
    return await pool.executeProgrammatic(internalId, { ...request, body }, signal);
  }
}
