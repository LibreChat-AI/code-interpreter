import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { LinkedWorktreeWorkspaceTools } from './linked-worktrees.js';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';
import {
  WorktreeRetirementScheduler,
  describeWorktreeRetirement,
  retireStaleWorktrees,
  worktreeRetirementSettings,
} from './worktree-retirement.js';

import type { NativeWorkspaceCommandPool } from './native-pool.js';
import type { NativeProcessSandboxOptions } from './native-process.js';
import type { WorktreeRetirementOptions } from './worktree-retirement.js';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  );
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A checkout on `main` with an `origin` bare remote and an ignored `node_modules`. */
async function repository(t: test.TestContext): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'worktree-retirement-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = join(parent, 'remote.git');
  await git(parent, 'init', '-q', '--bare', remote);
  const root = join(parent, 'repo');
  await mkdir(root);
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'root\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.worktrees/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'init');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-q', 'origin', 'main');
  await mkdir(join(root, '.worktrees'));
  return root;
}

/** A task worktree with one commit of its own and ignored dependencies. */
async function worktree(root: string, name: string, push = true): Promise<string> {
  await git(root, 'worktree', 'add', '-q', '-b', name, `.worktrees/${name}`);
  const path = join(root, '.worktrees', name);
  await writeFile(join(path, `${name}.txt`), `${name}\n`);
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', name);
  if (push) await git(path, 'push', '-q', 'origin', name);
  await mkdir(join(path, 'node_modules', 'dependency'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'dependency', 'index.js'), 'module.exports = 1;\n');
  return path;
}

/** Backdate every on-disk activity signal, as if nobody had touched the worktree for `days`. */
async function age(root: string, name: string, days = 30): Promise<void> {
  const when = new Date(Date.now() - days * DAY_MS);
  const metadata = join(root, '.git', 'worktrees', name);
  const paths = [
    join(root, '.worktrees', name),
    metadata,
    ...['HEAD', 'index', join('logs', 'HEAD'), 'ORIG_HEAD', 'FETCH_HEAD'].map((path) => join(metadata, path)),
  ];
  for (const path of paths) {
    await utimes(path, when, when).catch(() => undefined);
  }
}

function sources(root: string): WorktreeRetirementOptions['sources'] {
  return [{ workspaceId: 'repo', root }];
}

/** A command pool whose lane commands wait until released. */
function blockingPool(): {
  pool: NativeWorkspaceCommandPool;
  started: Promise<void>;
  finish: () => void;
} {
  let started!: () => void;
  let finish!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const pool = {
    async registerRoot() {},
    async unregisterRoot() {},
    async execute(request: { workspaceId: string }) {
      started();
      await finished;
      return {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: request.workspaceId,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
      };
    },
  } as unknown as NativeWorkspaceCommandPool;
  return { pool, started: startedPromise, finish };
}

async function laneTools(root: string, pool?: NativeWorkspaceCommandPool): Promise<LinkedWorktreeWorkspaceTools> {
  const delegate = await LocalWorkspaceTools.create({
    repositoryInstructions: false,
    workspaces: [{ id: 'repo', root, writable: true }],
  });
  return new LinkedWorktreeWorkspaceTools({
    commandPool: pool,
    delegate,
    sources: new Map([
      ['repo', {
        root,
        command: { workspaceRoot: root } as NativeProcessSandboxOptions,
        repositoryInstructions: false,
        writable: true,
      }],
    ]),
  });
}

const laneCommand = (worktree: string) => ({
  protocolVersion: 1 as const,
  operation: 'execute_command' as const,
  workspaceId: 'repo',
  worktree,
  command: 'true',
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('retires a clean, pushed, idle worktree and keeps its branch for recovery', async (t) => {
  const root = await repository(t);
  const path = await worktree(root, 'done');
  await age(root, 'done');

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, ['repo:done']);
  assert.deepEqual(summary.kept, {});
  assert.equal(await exists(path), false, 'the worktree and its ignored files are gone');
  assert.equal(await exists(join(root, '.git', 'worktrees', 'done')), false);
  assert.doesNotMatch(await git(root, 'worktree', 'list', '--porcelain'), /\.worktrees\/done/);
  const branch = await git(root, 'rev-parse', '--verify', 'refs/heads/done');
  assert.equal(branch, await git(root, 'rev-parse', '--verify', 'refs/remotes/origin/done'));

  await git(root, 'worktree', 'add', '-q', '.worktrees/done', 'done');
  assert.equal(await readFile(join(path, 'done.txt'), 'utf8'), 'done\n');
  assert.equal(await git(root, 'status', '--porcelain'), '', 'the main checkout is untouched');
  assert.equal(await git(root, 'branch', '--show-current'), 'main');
});

test('keeps every worktree that could lose work or is not a linked worktree', async (t) => {
  const root = await repository(t);
  const worktrees = join(root, '.worktrees');

  const dirty = await worktree(root, 'dirty');
  await writeFile(join(dirty, 'dirty.txt'), 'changed\n');
  const untracked = await worktree(root, 'untracked');
  await writeFile(join(untracked, 'notes.txt'), 'not yet added\n');
  await worktree(root, 'unpushed', false);
  await worktree(root, 'locked');
  await git(root, 'worktree', 'lock', '.worktrees/locked');
  const merging = await worktree(root, 'merging');
  await worktree(root, 'side');
  await git(merging, 'merge', '-q', '--no-commit', '--no-ff', 'side');
  await worktree(root, 'recent');
  const detached = await worktree(root, 'detached');
  await git(detached, 'checkout', '-q', '--detach');
  await writeFile(join(detached, 'local.txt'), 'local\n');
  await git(detached, 'add', '.');
  await git(detached, 'commit', '-q', '-m', 'detached and unpushed');
  await mkdir(join(worktrees, 'forged'));
  await writeFile(join(worktrees, 'forged', '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'side')}\n`);
  await mkdir(join(worktrees, 'plain'));
  for (const name of ['dirty', 'untracked', 'unpushed', 'locked', 'merging', 'side', 'detached']) {
    await age(root, name);
  }
  await age(root, 'forged');
  await age(root, 'plain');

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, ['repo:side']);
  assert.deepEqual(summary.kept, {
    dirty: 2,
    unpushed: 2,
    locked: 1,
    operation: 1,
    recent: 1,
    unverified: 2,
  });
  for (const name of ['dirty', 'untracked', 'unpushed', 'locked', 'merging', 'recent', 'detached', 'forged', 'plain']) {
    assert.ok(await exists(join(worktrees, name)), `${name} is kept`);
  }
  assert.equal(await readFile(join(dirty, 'dirty.txt'), 'utf8'), 'changed\n');
  assert.equal(await readFile(join(untracked, 'notes.txt'), 'utf8'), 'not yet added\n');
  assert.ok(await exists(join(root, '.git', 'worktrees', 'merging', 'MERGE_HEAD')));
  assert.equal(await git(root, 'status', '--porcelain'), '');
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'root\n');
});

test('a detached HEAD is retired only when a remote-tracking ref contains it', async (t) => {
  const root = await repository(t);
  const path = await worktree(root, 'review');
  await git(path, 'checkout', '-q', '--detach');
  await age(root, 'review');

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, ['repo:review']);
  assert.equal(await exists(path), false);
});

test('a squash- or rebase-merged branch whose remote branch was deleted is retired; unmerged work is kept', async (t) => {
  const root = await repository(t);
  const parent = join(root, '..');
  const tracked = async (name: string): Promise<string> => {
    const path = await worktree(root, name);
    await git(path, 'branch', '-q', '--set-upstream-to', `origin/${name}`);
    return path;
  };
  const squashed = await tracked('squashed');
  await writeFile(join(squashed, 'second.txt'), 'second\n');
  await git(squashed, 'add', '.');
  await git(squashed, 'commit', '-q', '-m', 'second');
  await git(squashed, 'push', '-q', 'origin', 'squashed');
  await tracked('rebased');
  await tracked('abandoned');
  const review = 'review-16677-1f35df8';
  await git(root, 'worktree', 'add', '-q', '--detach', `.worktrees/${review}`, await git(squashed, 'rev-parse', 'HEAD'));
  await git(root, 'worktree', 'add', '-q', '-b', 'ahead', '.worktrees/ahead');
  const ahead = join(root, '.worktrees', 'ahead');
  await git(ahead, 'push', '-q', '-u', 'origin', 'ahead');
  await writeFile(join(ahead, 'later.txt'), 'later\n');
  await git(ahead, 'add', '.');
  await git(ahead, 'commit', '-q', '-m', 'later, also landed on main but never pushed here');

  const hosting = join(parent, 'hosting');
  await git(parent, 'clone', '-q', join(parent, 'remote.git'), hosting);
  await git(hosting, 'merge', '-q', '--squash', 'origin/squashed');
  await git(hosting, 'commit', '-q', '-m', 'squash merge');
  await git(hosting, 'cherry-pick', 'origin/rebased');
  await writeFile(join(hosting, 'later.txt'), 'later\n');
  await git(hosting, 'add', '.');
  await git(hosting, 'commit', '-q', '-m', 'later');
  await git(hosting, 'push', '-q', 'origin', 'main');
  await git(hosting, 'push', '-q', 'origin', '--delete', 'squashed', 'rebased', 'abandoned');
  await git(root, 'fetch', '-q', '--prune', 'origin');
  for (const name of ['squashed', 'rebased', 'abandoned', review, 'ahead']) await age(root, name);

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual([...summary.retired].sort(), ['repo:rebased', `repo:${review}`, 'repo:squashed']);
  assert.deepEqual(summary.kept, { unpushed: 2 });
  assert.ok(await exists(join(root, '.worktrees', 'abandoned')), 'unmerged work with a deleted remote is kept');
  assert.ok(await exists(ahead), 'commits beyond a live upstream are kept even when main has the same change');
  for (const branch of ['squashed', 'rebased', 'abandoned', 'ahead']) {
    await git(root, 'rev-parse', '--verify', `refs/heads/${branch}`);
  }
});

test('never touches the main checkout or worktrees outside .worktrees', async (t) => {
  const root = await repository(t);
  const outside = join(root, '..', 'outside');
  await git(root, 'worktree', 'add', '-q', '-b', 'outside', outside);
  await git(outside, 'push', '-q', 'origin', 'outside');
  const nested = join(root, 'nested');
  await git(root, 'worktree', 'add', '-q', '-b', 'nested', nested);
  await git(nested, 'push', '-q', 'origin', 'nested');
  const old = new Date(Date.now() - 30 * DAY_MS);
  for (const path of [root, join(root, '.git'), join(root, '.git', 'HEAD'), join(root, '.git', 'index'), outside, nested]) {
    await utimes(path, old, old);
  }

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, []);
  assert.ok(await exists(join(root, 'README.md')));
  assert.ok(await exists(outside));
  assert.ok(await exists(nested));
  assert.equal((await git(root, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)?.length, 3);
});

test('this worker\'s own lane use counts as activity, and an active lane is never retired', async (t) => {
  const root = await repository(t);
  const path = await worktree(root, 'busy');
  await age(root, 'busy');
  const { pool, started, finish } = blockingPool();
  const tools = await laneTools(root, pool);

  const running = tools.execute(laneCommand('busy'));
  await started;
  await pause(5);
  const during = await retireStaleWorktrees({ sources: sources(root), activity: tools, idleMs: 1 });
  assert.deepEqual(during.kept, { active: 1 });
  assert.ok(await exists(path));

  finish();
  await running;
  const recent = await retireStaleWorktrees({ sources: sources(root), activity: tools });
  assert.deepEqual(recent.kept, { recent: 1 }, 'the default threshold counts this process\'s last use');
  assert.ok(await exists(path));

  await pause(5);
  const after = await retireStaleWorktrees({ sources: sources(root), activity: tools, idleMs: 1 });
  assert.deepEqual(after.retired, ['repo:busy']);
  assert.equal(await exists(path), false);
  await assert.rejects(
    tools.execute(laneCommand('busy')),
    (error: unknown) => error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('a lane request that arrives during retirement waits, then finds the lane gone', async (t) => {
  const root = await repository(t);
  await worktree(root, 'leaving');
  let executions = 0;
  const pool = {
    async registerRoot() {},
    async unregisterRoot() {},
    async execute() {
      executions += 1;
      throw new Error('a retired lane must not run commands');
    },
  } as unknown as NativeWorkspaceCommandPool;
  const tools = await laneTools(root, pool);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const retiring = tools.whileIdle('repo', 'leaving', async () => {
    await gate;
    await git(root, 'worktree', 'remove', '.worktrees/leaving');
    return 'removed';
  });
  let settled = false;
  const request = tools.execute(laneCommand('leaving'));
  request.catch(() => undefined).finally(() => { settled = true; });
  let checkoutSettled = false;
  const checkout = tools.execute({ protocolVersion: 1, operation: 'read_file', workspaceId: 'repo', path: 'README.md' });
  checkout.finally(() => { checkoutSettled = true; });
  const cancelled = new AbortController();
  const abandoned = tools.execute(laneCommand('leaving'), cancelled.signal);
  await pause(20);
  assert.equal(settled, false, 'the lane request waits for retirement');
  assert.equal(checkoutSettled, false, 'a checkout request waits too: it can reach the lane being removed');
  assert.deepEqual(await tools.whileIdle('repo', 'leaving', async () => 'again'), { ran: false });
  cancelled.abort(new Error('caller gave up'));
  await assert.rejects(abandoned, /caller gave up/, 'cancellation ends the wait without the retirement');

  release();
  assert.deepEqual(await retiring, { ran: true, value: 'removed' });
  await assert.rejects(
    request,
    (error: unknown) => error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
  const read = await checkout;
  assert.equal(read.operation === 'read_file' && read.content.trimEnd(), 'root');
  assert.equal(executions, 0);
});

test('retirement never prunes other registered worktrees that are temporarily missing', async (t) => {
  const root = await repository(t);
  const external = join(root, '..', 'external');
  await git(root, 'worktree', 'add', '-q', '-b', 'external', external);
  await rename(external, `${external}.unmounted`);
  await worktree(root, 'done');
  await age(root, 'done');

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, ['repo:done']);
  assert.ok(await exists(join(root, '.git', 'worktrees', 'external')), 'the unavailable worktree stays registered');
  assert.equal(await exists(join(root, '.git', 'worktrees', 'done')), false, 'removal deletes its own metadata');
  await rename(`${external}.unmounted`, external);
  assert.equal(await git(external, 'branch', '--show-current'), 'external');
});

test('a checkout request in flight defers retirement of its lanes', async (t) => {
  const root = await repository(t);
  const path = await worktree(root, 'quiet');
  await age(root, 'quiet');
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delegate = await LocalWorkspaceTools.create({
    repositoryInstructions: false,
    workspaces: [{ id: 'repo', root, writable: true }],
  });
  const tools = new LinkedWorktreeWorkspaceTools({
    delegate: {
      capabilities: delegate.capabilities,
      async execute(request, signal) {
        entered();
        await gate;
        return await delegate.execute(request, signal);
      },
    },
    sources: new Map([['repo', { root, repositoryInstructions: false, writable: true }]]),
  });

  const reading = tools.execute({ protocolVersion: 1, operation: 'read_file', workspaceId: 'repo', path: 'README.md' });
  await inside;
  const during = await retireStaleWorktrees({ sources: sources(root), activity: tools });
  assert.deepEqual(during.kept, { active: 1 });
  release();
  await reading;
  assert.ok(await exists(path));

  const after = await retireStaleWorktrees({ sources: sources(root), activity: tools });
  assert.deepEqual(after.retired, ['repo:quiet']);
});

test('quarantined lanes and checkouts are left for the operator', async (t) => {
  const root = await repository(t);
  await worktree(root, 'held');
  await worktree(root, 'free');
  await age(root, 'held');
  await age(root, 'free');

  const checkoutHeld = await retireStaleWorktrees({
    sources: sources(root),
    isQuarantined: async (_workspaceId, worktree) => worktree == null,
  });
  assert.deepEqual(checkoutHeld, { retired: [], kept: {}, freedBytes: 0, truncated: false });

  const laneHeld = await retireStaleWorktrees({
    sources: sources(root),
    isQuarantined: async (_workspaceId, worktree) => worktree === 'held',
  });
  assert.deepEqual(laneHeld.retired, ['repo:free']);
  assert.deepEqual(laneHeld.kept, { quarantined: 1 });
  assert.ok(await exists(join(root, '.worktrees', 'held')));
});

test('a quarantine that appears after inspection is caught under the lane reservation', async (t) => {
  const root = await repository(t);
  await worktree(root, 'late');
  await age(root, 'late');
  for (const quarantinedLater of [undefined, 'late']) {
    const asked: string[] = [];
    const summary = await retireStaleWorktrees({
      sources: sources(root),
      activity: await laneTools(root),
      isQuarantined: async (_workspaceId, worktree) => {
        asked.push(worktree ?? '<checkout>');
        // Clear for the scan and inspection; quarantined once the lane is reserved.
        return asked.length > 2 && worktree === quarantinedLater;
      },
    });
    assert.deepEqual(summary.kept, { quarantined: 1 });
    assert.deepEqual(asked, ['<checkout>', 'late', '<checkout>', ...(quarantinedLater ? ['late'] : [])]);
    assert.ok(await exists(join(root, '.worktrees', 'late')));
  }
});

test('one worktree failing does not stop the pass', async (t) => {
  const root = await repository(t);
  await worktree(root, 'broken');
  await worktree(root, 'fine');
  await rm(join(root, '.git', 'worktrees', 'broken', 'HEAD'));
  await age(root, 'broken');
  await age(root, 'fine');

  const summary = await retireStaleWorktrees({ sources: sources(root) });

  assert.deepEqual(summary.retired, ['repo:fine']);
  assert.equal(Object.values(summary.kept).reduce((total, count) => total + (count ?? 0), 0), 1);
  assert.ok(await exists(join(root, '.worktrees', 'broken')));
});

test('worktrees kept for lasting reasons cannot starve the rest of a backlog', async (t) => {
  const root = await repository(t);
  for (const [index, name] of ['first', 'second', 'third'].entries()) {
    await worktree(root, name, false);
    await age(root, name, 40 - index);
  }
  await worktree(root, 'newest');
  await age(root, 'newest', 10);
  const rotation = new Set<string>();
  const options = { sources: sources(root), rotation, limits: { inspect: 2 } };

  const first = await retireStaleWorktrees(options);
  assert.deepEqual(first.retired, []);
  assert.deepEqual(first.kept, { unpushed: 2, deferred: 2 });
  assert.equal(first.truncated, true, 'uninspected worktrees remain in this rotation');

  const second = await retireStaleWorktrees(options);
  assert.deepEqual(second.retired, ['repo:newest']);
  assert.deepEqual(second.kept, { unpushed: 1, deferred: 2 });
  assert.equal(second.truncated, false, 'the rotation is complete');

  const third = await retireStaleWorktrees(options);
  assert.deepEqual(third.kept, { unpushed: 2, deferred: 1 }, 'a new rotation starts from the oldest');
  assert.equal(third.truncated, true);
});

test('retirement is on by default and can be disabled or retuned', () => {
  assert.deepEqual(worktreeRetirementSettings({ optOut: false }), { enabled: true, idleMs: 7 * DAY_MS });
  assert.equal(worktreeRetirementSettings({ optOut: true }).enabled, false);
  assert.equal(worktreeRetirementSettings({ optOut: false, enabled: 'FALSE' }).enabled, false);
  assert.equal(worktreeRetirementSettings({ optOut: true, enabled: 'true' }).enabled, false);
  assert.equal(worktreeRetirementSettings({ optOut: false, enabled: ' ' }).enabled, true);
  assert.equal(worktreeRetirementSettings({ optOut: false, idleDays: '14' }).idleMs, 14 * DAY_MS);
  assert.throws(() => worktreeRetirementSettings({ optOut: false, enabled: 'off' }), /must be true or false/);
  for (const idleDays of ['0', '-1', '1.5', 'week', '3651']) {
    assert.throws(() => worktreeRetirementSettings({ optOut: false, idleDays }), /IDLE_DAYS/);
  }
});

test('scheduled passes never overlap and stop cleanly', async (t) => {
  const root = await repository(t);
  await worktree(root, 'scheduled');
  await age(root, 'scheduled');
  const messages: string[] = [];
  const scheduler = new WorktreeRetirementScheduler({
    sources: sources(root),
    startDelayMs: 60_000,
    log: (level, message) => {
      if (level === 'info') messages.push(message);
    },
  });
  scheduler.start();

  const first = scheduler.runNow();
  assert.equal(scheduler.runNow(), first, 'a pass requested while one runs joins it');
  const summary = await first;
  assert.deepEqual(summary?.retired, ['repo:scheduled']);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^worktree retirement: retired 1, kept 0(, freed about .+)?$/);

  await scheduler.stop();
  assert.equal(await scheduler.runNow(), undefined, 'a stopped scheduler runs nothing');
});

test('summaries count reasons and note a remaining backlog', () => {
  assert.equal(
    describeWorktreeRetirement({
      retired: ['repo:a', 'repo:b'],
      kept: { unpushed: 2, dirty: 1, recent: 4 },
      freedBytes: 3 * 1024 ** 3,
      truncated: true,
    }),
    'worktree retirement: retired 2, kept 7 (dirty 1, recent 4, unpushed 2), freed about 3.0 GiB, more next pass',
  );
});
