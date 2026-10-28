import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS, boundedBranch, boundedHead } from './protocol.js';
import { gitBytes } from './worktree-retirement.js';

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

/**
 * A read-only probe must never reach the network or run a transport command, whatever the checkout's
 * own config says. A command can rewrite `.git/config` to mark a remote as a promisor and point a ref
 * at a missing object, which makes a plain object lookup fetch lazily and run `ext::`, `ssh` or
 * `uploadpack` programs on the host. An empty `GIT_ALLOW_PROTOCOL` disallows every transport and
 * overrides repository configuration; `GIT_NO_LAZY_FETCH` covers Git 2.44 and later directly.
 */
const LANE_GIT_PROBE_ENV = { GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };

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
    const bytes = await gitBytes(root, args, signal, timeoutMs, LANE_GIT_OUTPUT_LIMIT, LANE_GIT_PROBE_ENV);
    // Git permits ref names that are not UTF-8. Decoding them leniently would report a different,
    // valid-looking name, so anything that is not strictly valid UTF-8 is reported as null.
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    // Drop only Git's own trailing line terminator: a ref name may legally begin or end with
    // other whitespace, and trimming it would report a different branch.
    return text.replace(/\r?\n$/, '');
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
  return await snapshotLaneGit(
    () => read(root, ['symbolic-ref', '--quiet', 'HEAD'], DETACHED_EXIT, signal, timeoutMs),
    // `--no-replace-objects`: a `refs/replace` entry must not turn a blob into a reported commit.
    (ref) => read(root, ['--no-replace-objects', 'rev-parse', '--verify', `${ref}^{commit}`], UNBORN_EXIT, signal, timeoutMs),
  );
}

/**
 * Two Git processes cannot see one atomic snapshot, so a checkout between them could pair one
 * branch with another branch's commit, a tuple that was never checked out. The head is therefore
 * read from the branch ref the first read named, not from `HEAD`, and the branch is read again
 * afterwards: a checkout away during the read omits the field. A detached HEAD has no ref to pin,
 * so it is read twice and must agree. A change that happens and reverts within one probe is not
 * detectable without a lock, and is not worth one for an advisory field.
 */
export async function snapshotLaneGit(
  readBranch: () => Promise<string | null | undefined>,
  readCommit: (ref: string) => Promise<string | null | undefined>,
): Promise<WorkspaceLaneGit | undefined> {
  const before = await readBranch();
  if (before === undefined) return undefined;
  const head = await readCommit(before ?? 'HEAD');
  const after = await readBranch();
  if (head === undefined || after === undefined || before !== after) return undefined;
  if (before === null && (await readCommit('HEAD')) !== head) return undefined;
  // `--short` shortens ambiguously (`heads/foo` when a tag `foo` exists). Take the full ref and strip
  // exactly `refs/heads/`; a HEAD pointing anywhere else is not a branch.
  const name = before?.startsWith('refs/heads/') ? before.slice('refs/heads/'.length) : null;
  return { branch: boundedBranch(name), head: boundedHead(head) };
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function plain(path: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const status = await lstat(path);
    return !status.isSymbolicLink() && (kind === 'file' ? status.isFile() : status.isDirectory());
  } catch {
    return false;
  }
}

/** Entries a checkout may have before the probe gives up on proving they are all plain. */
const LANE_GIT_REFS_MAX_ENTRIES = 20_000;
const LANE_GIT_OBJECTS_MAX_ENTRIES = 100_000;

/** Whether everything beneath a directory is a plain file or directory: no link can redirect a read. */
async function treeIsLinkFree(
  refs: string,
  signal?: AbortSignal,
  maxEntries = LANE_GIT_REFS_MAX_ENTRIES,
): Promise<boolean> {
  const pending = [refs];
  let seen = 0;
  while (pending.length > 0) {
    // Stop between directory operations: the probe timeout returns the command result, but only an
    // abort observed here keeps an abandoned walk from running on in the background.
    signal?.throwIfAborted();
    const current = pending.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++seen > maxEntries) return false;
      if (entry.isSymbolicLink()) return false;
      // `Dirent.parentPath` needs Node 20.12; the package supports 20.11.
      if (entry.isDirectory()) pending.push(join(current, entry.name));
      else if (!entry.isFile()) return false;
    }
  }
  return true;
}

/**
 * The shared part of both ownership checks: the refs and object storage of a Git directory hold
 * no link, no `alternates` redirect and no `reftable` backend, so the host-side reads cannot be
 * steered at another repository's refs or objects.
 */
async function storageIsOwn(gitDir: string, signal?: AbortSignal): Promise<boolean> {
  const objects = join(gitDir, 'objects');
  return (
    (await plain(join(gitDir, 'refs'), 'directory')) &&
    (await treeIsLinkFree(join(gitDir, 'refs'), signal)) &&
    (await plain(objects, 'directory')) &&
    (await absent(join(objects, 'info', 'alternates'))) &&
    (await absent(join(objects, 'info', 'http-alternates'))) &&
    (await treeIsLinkFree(objects, signal, LANE_GIT_OBJECTS_MAX_ENTRIES)) &&
    (await absent(join(gitDir, 'reftable'))) &&
    ((await absent(join(gitDir, 'packed-refs'))) || (await plain(join(gitDir, 'packed-refs'), 'file')))
  );
}

/**
 * Whether `<root>/.git` is the checkout's own Git directory, so the host-side probe cannot be
 * steered at another repository. A command can rewrite its own `.git` after it ran: replace it
 * with a `gitdir:` file, add a `commondir` redirect, or link `HEAD`, `packed-refs`, `refs` or any
 * ref beneath it to another checkout, and the unsandboxed probe would then report that checkout's
 * branch and head. Every entry under `refs/` is therefore checked, up to a bound.
 * The check runs after the command has finished, so it does not cover a process the command left
 * running in the background.
 * Anything else, including a `.git` file (a linked worktree or submodule as a source root), is
 * not probed: the field is simply omitted. Linked worktree lanes are verified separately.
 */
export async function ownsGitMetadata(root: string, signal?: AbortSignal): Promise<boolean> {
  const dotGit = join(root, '.git');
  try {
    if (!(await plain(dotGit, 'directory')) || (await realpath(dotGit)) !== join(await realpath(root), '.git')) {
      return false;
    }
    return (
      (await plain(join(dotGit, 'HEAD'), 'file')) &&
      (await absent(join(dotGit, 'commondir'))) &&
      (await storageIsOwn(dotGit, signal))
    );
  } catch {
    return false;
  }
}

/**
 * The linked worktree counterpart of `ownsGitMetadata`. `verifyLinkedWorktree` proves the lane's
 * `.git` pointer chain, but the probe also reads the lane's own `HEAD` and the refs it names from
 * the shared common directory, and a command can write to both. Without this, a ref symlinked at
 * another checkout and named by the lane's `HEAD` would be followed by the host-side probe.
 */
export async function ownsLinkedWorktreeMetadata(commonGitDir: string, name: string, signal?: AbortSignal): Promise<boolean> {
  const metadata = join(commonGitDir, 'worktrees', name);
  try {
    if (!(await plain(join(metadata, 'HEAD'), 'file'))) return false;
    if (!(await absent(join(metadata, 'refs'))) && !(await treeIsLinkFree(join(metadata, 'refs'), signal))) return false;
    return await storageIsOwn(commonGitDir, signal);
  } catch {
    return false;
  }
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

  async execute(
    request: WorkspaceToolRequest,
    signal?: AbortSignal,
    context?: { deadlineAtMs?: number },
  ): Promise<WorkspaceToolResult> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const delegated = await this.options.delegate.execute(request, signal, context);
    if (request.operation !== 'execute_command' || delegated.operation !== 'execute_command') return delegated;
    // Only the value this wrapper reads is trusted. A sandbox executor must not be able to supply
    // its own branch and head, whether or not the probe below produces anything.
    const { laneGit: _untrusted, ...result } = delegated;
    if (this.options.isEnabled?.() === false) return result;
    // The probe is advisory, so it only runs in budget the command left over, and never into the
    // part reserved for settlement. The worker's real deadline accounts for time already spent on
    // lease transport and credential refresh; without it, assume the full timeout plus the grace.
    const deadlineAtMs =
      context?.deadlineAtMs ??
      startedAt + (request.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_DEFAULT_TIMEOUT_MS) + COMMAND_EXECUTION_GRACE_MS;
    const probeMs = Math.min(
      this.options.probeTimeoutMs ?? LANE_GIT_PROBE_MAX_MS,
      deadlineAtMs - now() - LANE_GIT_SETTLEMENT_RESERVE_MS,
    );
    if (probeMs < Math.min(LANE_GIT_PROBE_MIN_MS, this.options.probeTimeoutMs ?? LANE_GIT_PROBE_MIN_MS)) return result;
    // The resolver may do filesystem work that cannot observe a signal, so the race, not the
    // signal, is what bounds the wait. The signal still stops Git when the limit hits first.
    const controller = new AbortController();
    const probeSignal = AbortSignal.any([...(signal ? [signal] : []), controller.signal]);
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = (async (): Promise<WorkspaceLaneGit | undefined> => {
        try {
          const root = await this.options.resolveRoot(request, probeSignal);
          return root == null ? undefined : await readLaneGit(root, probeSignal, probeMs);
        } catch {
          return undefined;
        }
      })();
      const limit = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, probeMs);
      });
      const laneGit = await Promise.race([probe, limit]);
      return laneGit ? { ...result, laneGit } : result;
    } catch {
      // Git state is advisory; a failed read must never fail or delay the command's own result.
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
