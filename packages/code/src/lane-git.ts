import { boundedBranch, boundedHead } from './protocol.js';
import { git } from './worktree-retirement.js';

import type { WorkspaceLaneGit, WorkspaceToolRequest, WorkspaceToolResult } from './protocol.js';
import type { WorkspaceToolExecutor } from './workspace.js';

const LANE_GIT_TIMEOUT_MS = 5_000;
const LANE_GIT_OUTPUT_LIMIT = 4096;

/** Exit codes that mean "no value" rather than "could not read": detached HEAD, unborn branch. */
const DETACHED_EXIT = 1;
const UNBORN_EXIT = 128;

async function read(
  root: string,
  args: string[],
  emptyExit: number,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  try {
    return (await git(root, args, signal, LANE_GIT_TIMEOUT_MS, LANE_GIT_OUTPUT_LIMIT)).trim();
  } catch (error) {
    signal?.throwIfAborted();
    return (error as { code?: unknown }).code === emptyExit ? null : undefined;
  }
}

/**
 * The branch and head commit checked out in a lane root, or undefined when Git
 * could not be read (timeout, missing binary, aborted). Detached HEAD and a
 * repository without commits are ordinary states and report null. Values that
 * fail the bounds are reported as null, never forwarded. Nothing else from the
 * repository is read or returned.
 */
export async function readLaneGit(root: string, signal?: AbortSignal): Promise<WorkspaceLaneGit | undefined> {
  const [branch, head] = await Promise.all([
    read(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], DETACHED_EXIT, signal),
    read(root, ['rev-parse', '--verify', 'HEAD'], UNBORN_EXIT, signal),
  ]);
  if (branch === undefined || head === undefined) return undefined;
  return { branch: boundedBranch(branch), head: boundedHead(head) };
}

export interface LaneGitWorkspaceToolsOptions {
  delegate: WorkspaceToolExecutor;
  /** The lane root a request ran in (isolated worktree, linked worktree or source checkout), or undefined. */
  resolveRoot: (request: WorkspaceToolRequest, signal?: AbortSignal) => Promise<string | undefined>;
  /** Whether Code API negotiated `lane_git`. Git is not probed while this is false. Defaults to true. */
  isEnabled?: () => boolean;
}

/**
 * Attaches `laneGit` to every finished `execute_command` result, so a branch the
 * agent created or switched is visible as soon as the command returns. Git is
 * read once per command, never on a timer. The field is stripped by the worker
 * unless Code API acknowledged the `lane_git` feature at registration.
 */
export class LaneGitWorkspaceTools implements WorkspaceToolExecutor {
  readonly mutationFailuresAreAtomic?: true;
  readonly capabilities: WorkspaceToolExecutor['capabilities'];

  constructor(private readonly options: LaneGitWorkspaceToolsOptions) {
    this.mutationFailuresAreAtomic = options.delegate.mutationFailuresAreAtomic;
    const base = options.delegate.capabilities;
    this.capabilities = base.operations.includes('execute_command')
      ? { ...base, commandResultFeatures: ['lane_git'] }
      : base;
  }

  async execute(request: WorkspaceToolRequest, signal?: AbortSignal): Promise<WorkspaceToolResult> {
    const result = await this.options.delegate.execute(request, signal);
    if (request.operation !== 'execute_command' || result.operation !== 'execute_command') return result;
    if (this.options.isEnabled?.() === false) return result;
    try {
      const root = await this.options.resolveRoot(request, signal);
      const laneGit = root == null ? undefined : await readLaneGit(root, signal);
      return laneGit ? { ...result, laneGit } : result;
    } catch {
      // Git state is advisory; a failed read must never fail or delay the command's own result.
      return result;
    }
  }
}
