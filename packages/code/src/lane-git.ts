import { BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS, boundedBranch, boundedHead } from './protocol.js';
import { git } from './worktree-retirement.js';

import type { WorkspaceLaneGit, WorkspaceToolRequest, WorkspaceToolResult } from './protocol.js';
import type { WorkspaceToolExecutor } from './workspace.js';

/** Longest the advisory probe may run, however much budget is left. */
const LANE_GIT_PROBE_MAX_MS = 1_000;
/** Settlement budget the probe never touches, for validation and the settle request. */
const LANE_GIT_SETTLEMENT_RESERVE_MS = 1_000;
/** Below this, a probe is not worth starting. */
const LANE_GIT_PROBE_MIN_MS = 250;
/** Code API gives a command its own timeout plus this much before it expires the assignment. */
const COMMAND_EXECUTION_GRACE_MS = 5_000;
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
  timeoutMs: number = LANE_GIT_TIMEOUT_MS,
): Promise<string | null | undefined> {
  try {
    return (await git(root, args, signal, timeoutMs, LANE_GIT_OUTPUT_LIMIT)).trim();
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
export async function readLaneGit(
  root: string,
  signal?: AbortSignal,
  timeoutMs: number = LANE_GIT_TIMEOUT_MS,
): Promise<WorkspaceLaneGit | undefined> {
  const [branch, head] = await Promise.all([
    read(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], DETACHED_EXIT, signal, timeoutMs),
    read(root, ['rev-parse', '--verify', 'HEAD'], UNBORN_EXIT, signal, timeoutMs),
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
  /** Longest the probe may run. Defaults to 1 s; it is also cut to fit the command's remaining budget. */
  probeTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
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
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const result = await this.options.delegate.execute(request, signal);
    if (request.operation !== 'execute_command' || result.operation !== 'execute_command') return result;
    if (this.options.isEnabled?.() === false) return result;
    // The assignment expires `timeoutMs` plus a grace after it starts. The probe is advisory, so it
    // only runs in budget the command left over, and never into the part reserved for settlement.
    const budgetMs = (request.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS) + COMMAND_EXECUTION_GRACE_MS;
    const probeMs = Math.min(
      this.options.probeTimeoutMs ?? LANE_GIT_PROBE_MAX_MS,
      budgetMs - (now() - startedAt) - LANE_GIT_SETTLEMENT_RESERVE_MS,
    );
    if (probeMs < Math.min(LANE_GIT_PROBE_MIN_MS, this.options.probeTimeoutMs ?? LANE_GIT_PROBE_MIN_MS)) return result;
    const probeSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(probeMs)]);
    try {
      const root = await this.options.resolveRoot(request, probeSignal);
      const laneGit = root == null ? undefined : await readLaneGit(root, probeSignal, probeMs);
      return laneGit ? { ...result, laneGit } : result;
    } catch {
      // Git state is advisory; a failed read must never fail or delay the command's own result.
      return result;
    }
  }
}
