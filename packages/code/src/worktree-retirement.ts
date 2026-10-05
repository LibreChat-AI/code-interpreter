import { execFile } from 'node:child_process';
import { lstat, opendir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { LINKED_WORKTREE_DIRECTORY, verifyLinkedWorktree } from './linked-worktrees.js';
import { isValidLinkedWorktreeName } from './protocol.js';

import type { LinkedWorktreeActivity, VerifiedLinkedWorktree } from './linked-worktrees.js';
import type { WorkspaceRootIdentity } from './root-identity.js';

const execFileAsync = promisify(execFile);

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WORKTREE_IDLE_DAYS = 7;
const MAX_WORKTREE_IDLE_DAYS = 3650;
export const WORKTREE_RETIREMENT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WORKTREE_RETIREMENT_START_DELAY_MS = 2 * 60 * 1000;
/** A pass that hit a bound continues soon instead of waiting a full interval. */
const WORKTREE_RETIREMENT_CONTINUATION_MS = 5 * 60 * 1000;
/**
 * Directory entries read beneath one checkout's `.worktrees` per pass: a
 * memory bound far above any real checkout, so every pass sees every entry.
 * Git inspection is what is bounded per pass, and rotation keeps it fair.
 */
const SCAN_LIMIT = 65_536;
/** Idle worktrees whose Git state is inspected per pass, oldest first. */
const INSPECT_LIMIT = 128;
/** Worktrees removed per pass. */
const RETIRE_LIMIT = 32;
const GIT_TIMEOUT_MS = 30_000;
/**
 * Removal deletes ignored build output too, which can take a while. It has no
 * timeout and ignores cancellation: a half-deleted worktree loses its `.git`
 * file and can no longer be verified, retired or recognized.
 */
const GIT_REMOVE_NO_TIMEOUT = 0;
const GIT_OUTPUT_LIMIT = 64 * 1024;
/** Path and commit lists between a stale branch and its default branch can be long. */
const GIT_LIST_LIMIT = 16 * 1024 * 1024;
/** Per-worktree Git state that marks a merge, rebase, cherry-pick, revert or bisect in progress. */
const OPERATION_STATE = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'BISECT_START',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
];
/** Per-worktree Git metadata that Git rewrites whenever the worktree is used. */
const ACTIVITY_STATE = ['HEAD', 'index', join('logs', 'HEAD'), 'ORIG_HEAD', 'FETCH_HEAD'];

export type WorktreeKeptReason =
  | 'unverified'
  | 'recent'
  | 'quarantined'
  | 'locked'
  | 'operation'
  | 'no-commit'
  | 'dirty'
  | 'unpushed'
  | 'active'
  | 'changed'
  | 'failed'
  | 'deferred';

export interface WorktreeRetirementSource {
  workspaceId: string;
  root: string;
  identity?: WorkspaceRootIdentity;
}

export interface WorktreeRetirementOptions {
  sources: readonly WorktreeRetirementSource[];
  /** Lane use in this worker; without it, only on-disk activity counts. */
  activity?: LinkedWorktreeActivity;
  idleMs?: number;
  /** A quarantined checkout or lane awaits an operator and is never retired. */
  isQuarantined?: (workspaceId: string, worktree?: string) => Promise<boolean>;
  log?: (level: 'debug' | 'info', message: string) => void;
  /**
   * Idle worktrees already inspected in the current rotation. A pass inspects
   * the others first and records what it inspects, so worktrees kept for a
   * lasting reason cannot starve the rest of a backlog larger than one pass.
   */
  rotation?: Set<string>;
  /** Per-pass bounds; the defaults suit production. */
  limits?: { inspect?: number; retire?: number };
}

export interface WorktreeRetirementSummary {
  /** `<workspaceId>:<worktree>` for each retired worktree. */
  retired: string[];
  kept: Partial<Record<WorktreeKeptReason, number>>;
  /** Free-space gain on the checkouts' filesystems across the pass; other writers make it approximate. */
  freedBytes: number;
  /** Idle worktrees remain that this rotation has not inspected yet. */
  truncated: boolean;
}

export interface WorktreeRetirementSettings {
  enabled: boolean;
  idleMs: number;
}

interface Candidate {
  source: WorktreeRetirementSource;
  name: string;
  lane: VerifiedLinkedWorktree;
  metadata: string;
  /** Newest on-disk activity, re-read under the reservation to detect use during inspection. */
  diskActiveAt: number;
  /** This worker's own last use of the lane, re-read under the reservation. */
  usedAt?: number;
  /** Checkout request activity when inspection began, re-read under the reservation. */
  checkoutAt?: number;
  /** Newest of on-disk activity and this worker's own lane use. */
  activeAt: number;
}

type Kept = { kept: WorktreeKeptReason; detail?: string };
type Verdict = Kept | { head: string; basis: string };

/**
 * Resolve the operator's choice. Retirement is on unless explicitly disabled;
 * malformed values fail startup rather than silently choosing either way.
 */
export function worktreeRetirementSettings(input: {
  optOut: boolean;
  enabled?: string;
  idleDays?: string;
}): WorktreeRetirementSettings {
  const enabled = input.enabled?.trim().toLowerCase() ?? '';
  if (enabled !== '' && enabled !== 'true' && enabled !== 'false') {
    throw new Error('LIBRECHAT_CODE_WORKTREE_RETIREMENT must be true or false');
  }
  const idleDays = input.idleDays?.trim() ?? '';
  const days = idleDays === '' ? DEFAULT_WORKTREE_IDLE_DAYS : Number(idleDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_WORKTREE_IDLE_DAYS) {
    throw new Error(
      `LIBRECHAT_CODE_WORKTREE_IDLE_DAYS must be an integer between 1 and ${MAX_WORKTREE_IDLE_DAYS}`,
    );
  }
  return { enabled: !input.optOut && enabled !== 'false', idleMs: days * DAY_MS };
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

export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
  maxBuffer = GIT_OUTPUT_LIMIT,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', cwd, '-c', 'core.fsmonitor=false', ...args],
    { encoding: 'utf8', env: gitEnvironment(), maxBuffer, signal, timeout },
  );
  return stdout;
}

/** Same invocation as `git`, but the raw stdout bytes, for callers that must not accept lossy decoding. */
export async function gitBytes(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
  maxBuffer = GIT_OUTPUT_LIMIT,
  extraEnvironment: Record<string, string> = {},
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', cwd, '-c', 'core.fsmonitor=false', ...args],
    { encoding: 'buffer', env: { ...gitEnvironment(), ...extraEnvironment }, maxBuffer, signal, timeout },
  );
  return stdout;
}

/** The commit a ref names, or undefined when it does not resolve. */
async function resolveCommit(cwd: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const commit = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal)).trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function pathList(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** The remote's default branch as last fetched: its `HEAD` symref, else `main` or `master`. */
async function remoteDefaultBranch(
  checkout: string,
  remote: string,
  signal?: AbortSignal,
): Promise<{ ref: string; commit: string } | undefined> {
  let symbolic: string | undefined;
  try {
    symbolic = (await git(checkout, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], signal)).trim();
  } catch {
    signal?.throwIfAborted();
  }
  const refs = [
    ...(symbolic?.startsWith(`refs/remotes/${remote}/`) ? [symbolic] : []),
    `refs/remotes/${remote}/main`,
    `refs/remotes/${remote}/master`,
  ];
  for (const ref of refs) {
    const commit = await resolveCommit(checkout, ref, signal);
    if (commit) return { ref: ref.replace(/^refs\/remotes\//, ''), commit };
  }
  return undefined;
}

/**
 * Whether a HEAD that no remote-tracking ref contains is nonetheless already
 * in its remote's default branch by content, as after a squash or rebase merge
 * whose remote branch was then deleted. Only a HEAD without a live upstream
 * qualifies: detached, never pushed, or whose upstream ref is gone. A live
 * upstream that lacks HEAD means unpushed commits. Content counts when every
 * commit beyond the default branch is patch-equivalent to one in it (and none
 * is a merge, which could carry its own changes), or when the default branch
 * has identical content at every path the branch changed since their merge
 * base. Local refs only; nothing is fetched.
 */
async function mergedByContent(
  lane: VerifiedLinkedWorktree,
  head: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const checkout = lane.checkoutRoot;
  let branch: string | undefined;
  try {
    branch = (await git(lane.root, ['symbolic-ref', '-q', 'HEAD'], signal)).trim() || undefined;
  } catch {
    signal?.throwIfAborted();
  }
  let remote = 'origin';
  if (branch?.startsWith('refs/heads/')) {
    const [upstream = '', upstreamRemote = ''] = (
      await git(checkout, ['for-each-ref', '--format=%(upstream)%00%(upstream:remotename)', branch], signal)
    )
      .trim()
      .split('\0');
    if (upstream) {
      if (await resolveCommit(checkout, upstream, signal)) return undefined;
      if (/^[A-Za-z0-9._-]+$/.test(upstreamRemote)) remote = upstreamRemote;
    }
  }
  const target = await remoteDefaultBranch(checkout, remote, signal);
  if (!target) return undefined;
  const merges = (await git(checkout, ['rev-list', '--count', '--merges', `${target.commit}..${head}`], signal)).trim();
  if (merges === '0') {
    const cherry = (await git(checkout, ['cherry', target.commit, head], signal, GIT_TIMEOUT_MS, GIT_LIST_LIMIT))
      .split('\n')
      .filter(Boolean);
    if (cherry.every((line) => line.startsWith('- '))) return `patch-equivalent to ${target.ref}`;
  }
  let base: string;
  try {
    base = (await git(checkout, ['merge-base', target.commit, head], signal)).trim();
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  const diff = (from: string): Promise<string> =>
    git(
      checkout,
      ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, head],
      signal,
      GIT_TIMEOUT_MS,
      GIT_LIST_LIMIT,
    );
  const touched = pathList(await diff(base));
  const differing = new Set(pathList(await diff(target.commit)));
  return touched.every((path) => !differing.has(path)) ? `same content as ${target.ref}` : undefined;
}

function errorDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return text.trim().split('\n')[0]!.slice(0, 200);
}

/** Absent is the only answer that clears a check; anything unreadable counts as present. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await lstat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The newest on-disk sign of use: the worktree directory itself and its Git metadata. */
async function lastActivity(root: string, metadata: string): Promise<number> {
  const times = await Promise.all(
    [root, metadata, ...ACTIVITY_STATE.map((path) => join(metadata, path))].map(modifiedAt),
  );
  return Math.max(...times);
}

async function worktreeNames(checkout: string): Promise<{ names: string[]; truncated: boolean }> {
  let directory;
  try {
    directory = await opendir(join(checkout, LINKED_WORKTREE_DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], truncated: false };
    throw error;
  }
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (names.length >= SCAN_LIMIT) return { names, truncated: true };
      if (isValidLinkedWorktreeName(entry.name)) names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { names, truncated: false };
}

async function freeSpace(paths: readonly string[]): Promise<Map<string, number>> {
  const space = new Map<string, number>();
  for (const path of paths) {
    try {
      const device = String((await lstat(path)).dev);
      if (space.has(device)) continue;
      const status = await statfs(path, { bigint: true });
      space.set(device, Number(status.bavail * status.bsize));
    } catch {
      // Space reporting is informational; it never decides a retirement.
    }
  }
  return space;
}

function describeChanges(status: string): string {
  const entries = status.split('\0').filter(Boolean);
  const untracked = entries.filter((entry) => entry.startsWith('?? ')).length;
  return untracked === entries.length
    ? 'untracked files'
    : untracked > 0
      ? 'tracked changes and untracked files'
      : 'tracked changes';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function describeWorktreeRetirement(summary: WorktreeRetirementSummary): string {
  const kept = Object.entries(summary.kept)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason} ${count}`);
  const keptTotal = Object.values(summary.kept).reduce((total, count) => total + (count ?? 0), 0);
  return [
    `worktree retirement: retired ${summary.retired.length}`,
    `kept ${keptTotal}${kept.length ? ` (${kept.join(', ')})` : ''}`,
    ...(summary.freedBytes > 0 ? [`freed about ${formatBytes(summary.freedBytes)}`] : []),
    ...(summary.truncated ? ['more next pass'] : []),
  ].join(', ');
}

/** Everything short of the worker's own activity that could make removal lose work. */
async function inspect(
  candidate: Candidate,
  options: WorktreeRetirementOptions,
  signal?: AbortSignal,
): Promise<Verdict> {
  const { lane, metadata, name, source } = candidate;
  try {
    if (await options.isQuarantined?.(source.workspaceId, name)) return { kept: 'quarantined' };
  } catch {
    return { kept: 'quarantined', detail: 'quarantine state is unreadable' };
  }
  if (await present(join(metadata, 'locked'))) return { kept: 'locked' };
  for (const state of OPERATION_STATE) {
    if (await present(join(metadata, state))) return { kept: 'operation', detail: state };
  }
  let head: string;
  try {
    head = (await git(lane.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal)).trim();
  } catch {
    signal?.throwIfAborted();
    return { kept: 'no-commit' };
  }
  if (!/^[0-9a-f]{40,64}$/.test(head)) return { kept: 'no-commit' };
  let status: string;
  try {
    status = await git(
      lane.root,
      ['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none'],
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kept: 'dirty', detail: 'too many changes to list' };
    }
    return { kept: 'failed', detail: `status: ${errorDetail(error)}` };
  }
  if (status.length > 0) return { kept: 'dirty', detail: describeChanges(status) };
  let remote: string;
  try {
    remote = (
      await git(
        lane.checkoutRoot,
        ['for-each-ref', '--count=1', '--contains', head, '--format=%(refname)', 'refs/remotes/'],
        signal,
      )
    ).trim();
  } catch (error) {
    signal?.throwIfAborted();
    return { kept: 'failed', detail: `remote containment: ${errorDetail(error)}` };
  }
  if (remote) return { head, basis: `contained in ${remote.replace(/^refs\/remotes\//, '')}` };
  let merged: string | undefined;
  try {
    merged = await mergedByContent(lane, head, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return { kept: 'failed', detail: `merged content: ${errorDetail(error)}` };
  }
  return merged
    ? { head, basis: merged }
    : { kept: 'unpushed', detail: 'not on a remote-tracking ref or merged into the default branch' };
}

/** Re-checked under the lane reservation: anything that moved since inspection defers to the next pass. */
async function remove(
  candidate: Candidate,
  head: string,
  options: WorktreeRetirementOptions,
  signal?: AbortSignal,
): Promise<Kept | 'retired'> {
  const { lane, metadata, name, source } = candidate;
  if (options.activity?.lastUsed(source.workspaceId, name) !== candidate.usedAt) {
    return { kept: 'changed', detail: 'used during inspection' };
  }
  // A checkout request can reach `.worktrees/*`, including ignored files that `git status` never reports.
  if (options.activity?.checkoutActivity(source.workspaceId) !== candidate.checkoutAt) {
    return { kept: 'changed', detail: 'checkout used during inspection' };
  }
  // A request that finished between inspection and this reservation may have quarantined either.
  try {
    if (
      (await options.isQuarantined?.(source.workspaceId)) ||
      (await options.isQuarantined?.(source.workspaceId, name))
    ) {
      return { kept: 'quarantined' };
    }
  } catch {
    return { kept: 'quarantined', detail: 'quarantine state is unreadable' };
  }
  let current: VerifiedLinkedWorktree;
  try {
    current = await verifyLinkedWorktree(source.root, name, source.identity);
  } catch {
    return { kept: 'changed', detail: 'no longer a verified linked worktree' };
  }
  if (current.identity.dev !== lane.identity.dev || current.identity.ino !== lane.identity.ino) {
    return { kept: 'changed', detail: 'worktree directory was replaced' };
  }
  if ((await lastActivity(lane.root, metadata)) !== candidate.diskActiveAt) {
    return { kept: 'changed', detail: 'used during inspection' };
  }
  if (await present(join(metadata, 'locked'))) return { kept: 'locked' };
  try {
    const now = (await git(lane.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal)).trim();
    if (now !== head) return { kept: 'changed', detail: 'HEAD moved during inspection' };
  } catch {
    signal?.throwIfAborted();
    return { kept: 'changed', detail: 'HEAD is unreadable' };
  }
  signal?.throwIfAborted();
  try {
    // Never --force: Git re-checks for changes and untracked files itself and refuses a dirty or locked worktree.
    await git(lane.checkoutRoot, ['worktree', 'remove', lane.root], undefined, GIT_REMOVE_NO_TIMEOUT);
  } catch (error) {
    return { kept: 'failed', detail: `remove: ${errorDetail(error)}` };
  }
  return 'retired';
}

/**
 * Retire linked worktrees beneath each checkout's `.worktrees` that are
 * verified, idle, clean, free of in-progress operations and locks, and whose
 * HEAD is contained in a remote-tracking ref or already merged into the
 * remote's default branch by content. Removal is `git worktree remove`
 * without `--force`, which also deletes that worktree's own metadata; no
 * repository-wide `git worktree prune` runs, since it would also expire other
 * registered worktrees that are only temporarily unavailable. Branches are
 * kept, so `git worktree add` restores any of them. Each worktree is judged
 * independently; one failure never ends the pass.
 */
export async function retireStaleWorktrees(
  options: WorktreeRetirementOptions,
  signal?: AbortSignal,
): Promise<WorktreeRetirementSummary> {
  const now = Date.now();
  const idleMs = options.idleMs ?? DEFAULT_WORKTREE_IDLE_DAYS * DAY_MS;
  const summary: WorktreeRetirementSummary = { retired: [], kept: {}, freedBytes: 0, truncated: false };
  const keep = (source: WorktreeRetirementSource, name: string, reason: WorktreeKeptReason, detail?: string): void => {
    summary.kept[reason] = (summary.kept[reason] ?? 0) + 1;
    options.log?.('debug', `worktree retirement kept ${source.workspaceId}:${name}: ${reason}${detail ? ` (${detail})` : ''}`);
  };
  const candidates: Candidate[] = [];
  for (const source of options.sources) {
    signal?.throwIfAborted();
    try {
      if (await options.isQuarantined?.(source.workspaceId)) {
        options.log?.('debug', `worktree retirement skipped ${source.workspaceId}: checkout is quarantined`);
        continue;
      }
      const { names, truncated } = await worktreeNames(source.root);
      if (truncated) {
        options.log?.('debug', `worktree retirement read only the first ${SCAN_LIMIT} entries of ${source.workspaceId}`);
      }
      for (const name of names) {
        signal?.throwIfAborted();
        let lane: VerifiedLinkedWorktree;
        try {
          lane = await verifyLinkedWorktree(source.root, name, source.identity);
        } catch (error) {
          keep(source, name, 'unverified', errorDetail(error));
          continue;
        }
        const metadata = join(lane.commonGitDir, 'worktrees', name);
        const diskActiveAt = await lastActivity(lane.root, metadata);
        const usedAt = options.activity?.lastUsed(source.workspaceId, name);
        const activeAt = Math.max(diskActiveAt, usedAt ?? 0);
        if (now - activeAt < idleMs) {
          keep(source, name, 'recent');
          continue;
        }
        candidates.push({ source, name, lane, metadata, diskActiveAt, usedAt, activeAt });
      }
    } catch (error) {
      signal?.throwIfAborted();
      options.log?.('debug', `worktree retirement skipped ${source.workspaceId}: ${errorDetail(error)}`);
    }
  }
  if (candidates.length === 0) {
    options.rotation?.clear();
    return summary;
  }
  const { rotation } = options;
  const key = (candidate: Candidate): string => `${candidate.source.workspaceId}\0${candidate.name}`;
  if (rotation) {
    const current = new Set(candidates.map(key));
    for (const entry of rotation) {
      if (!current.has(entry)) rotation.delete(entry);
    }
    if (rotation.size === current.size) rotation.clear();
  }
  const visited = (candidate: Candidate): number => (rotation?.has(key(candidate)) ? 1 : 0);
  candidates.sort((a, b) => visited(a) - visited(b) || a.activeAt - b.activeAt);
  const checkouts = [...new Set(candidates.map((candidate) => candidate.lane.checkoutRoot))];
  const before = await freeSpace(checkouts);
  const retiredCheckouts = new Set<string>();
  let inspected = 0;
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const { source, name } = candidate;
    if (
      inspected >= (options.limits?.inspect ?? INSPECT_LIMIT) ||
      summary.retired.length >= (options.limits?.retire ?? RETIRE_LIMIT)
    ) {
      summary.truncated ||= visited(candidate) === 0;
      keep(source, name, 'deferred');
      continue;
    }
    inspected += 1;
    rotation?.add(key(candidate));
    try {
      candidate.checkoutAt = options.activity?.checkoutActivity(source.workspaceId);
      const verdict = await inspect(candidate, options, signal);
      if ('kept' in verdict) {
        keep(source, name, verdict.kept, verdict.detail);
        continue;
      }
      const retire = (): Promise<Kept | 'retired'> => remove(candidate, verdict.head, options, signal);
      const reserved = options.activity
        ? await options.activity.whileIdle(source.workspaceId, name, retire)
        : { ran: true as const, value: await retire() };
      if (!reserved.ran) {
        keep(source, name, 'active');
        continue;
      }
      if (reserved.value !== 'retired') {
        keep(source, name, reserved.value.kept, reserved.value.detail);
        continue;
      }
      summary.retired.push(`${source.workspaceId}:${name}`);
      retiredCheckouts.add(candidate.lane.checkoutRoot);
      options.log?.('debug', `worktree retirement retired ${source.workspaceId}:${name} (${verdict.basis}); its branch is kept`);
    } catch (error) {
      signal?.throwIfAborted();
      keep(source, name, 'failed', errorDetail(error));
    }
  }
  if (retiredCheckouts.size > 0) {
    const after = await freeSpace(checkouts);
    for (const [device, free] of after) {
      summary.freedBytes += Math.max(0, free - (before.get(device) ?? free));
    }
  }
  return summary;
}

export interface WorktreeRetirementSchedulerOptions extends WorktreeRetirementOptions {
  intervalMs?: number;
  startDelayMs?: number;
  continuationMs?: number;
}

/**
 * Runs retirement passes in the background: once shortly after start, then
 * every interval, sooner while a backlog remains. Passes never overlap; a pass
 * requested while one runs joins it.
 */
export class WorktreeRetirementScheduler {
  private readonly controller = new AbortController();
  private readonly rotation = new Set<string>();
  private running?: Promise<WorktreeRetirementSummary | undefined>;
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: WorktreeRetirementSchedulerOptions) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    if (this.running == null) this.schedule(this.options.startDelayMs ?? WORKTREE_RETIREMENT_START_DELAY_MS);
  }

  /** Run a pass now, or join the one already running. */
  runNow(): Promise<WorktreeRetirementSummary | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Stop scheduling; a removal already under way finishes first. */
  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    if (!this.started || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => void this.runNow(), delayMs);
    this.timer.unref();
  }

  private async pass(): Promise<WorktreeRetirementSummary | undefined> {
    clearTimeout(this.timer);
    let summary: WorktreeRetirementSummary | undefined;
    try {
      summary = await retireStaleWorktrees(
        { ...this.options, rotation: this.rotation },
        this.controller.signal,
      );
      this.options.log?.('info', describeWorktreeRetirement(summary));
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.options.log?.('info', `worktree retirement pass failed: ${errorDetail(error)}`);
      }
    }
    this.schedule(
      summary?.truncated
        ? (this.options.continuationMs ?? WORKTREE_RETIREMENT_CONTINUATION_MS)
        : (this.options.intervalMs ?? WORKTREE_RETIREMENT_INTERVAL_MS),
    );
    return summary;
  }
}
