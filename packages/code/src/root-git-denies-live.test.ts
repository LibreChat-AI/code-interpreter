import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import { resolveNativeSrtCommandPolicy } from './native-policy.js';

const execFileAsync = promisify(execFile);
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', [...IDENTITY, ...args], { cwd })).stdout.trim();
}

async function snapshot(paths: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await readFile(path, 'utf8').catch(() => null)] as const),
  );
  return Object.fromEntries(entries);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/**
 * SRT's Linux mandatory denies for `.git/hooks` and `.git/config` are computed
 * from the worker process's own current directory, which is never the registered
 * workspace root. This exercises the sandbox from a cwd outside the root and
 * asserts the root's executable Git metadata is unwritable anyway — hooks,
 * config, an existing per-worktree config, and a submodule's config cannot be
 * tampered, so nothing an attacker writes runs the next time git is invoked on
 * the host.
 */
test('real SRT denies a non-lane root its own Git hooks and config even when the worker cwd is elsewhere', {
  skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
  timeout: 90_000,
}, async (t) => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'git-denies-cwd-')));
  const base = await realpath(await mkdtemp(join(tmpdir(), 'git-denies-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // A standalone repo used only as a local submodule source.
  const upstream = join(base, 'sub-src');
  await mkdir(upstream);
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 's.txt'), 'sub\n');
  await git(upstream, 'add', 's.txt');
  await git(upstream, 'commit', '-qm', 'sub');

  const root = join(base, 'repo');
  await mkdir(root);
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'tracked.txt'), 'checkout\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-qm', 'init');
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub');
  await git(root, 'commit', '-qm', 'add submodule');
  await mkdir(join(root, '.worktrees'));
  await git(root, 'worktree', 'add', '-q', '.worktrees/wt', '-b', 'wt');
  // An existing per-worktree config for the linked worktree; --worktree needs
  // the repository extension enabled first.
  await git(root, 'config', 'extensions.worktreeConfig', 'true');
  await git(join(root, '.worktrees', 'wt'), 'config', '--worktree', 'core.testflag', 'true');

  const gitDir = join(root, '.git');
  const submoduleGitDir = join(gitDir, 'modules', 'sub');
  const worktreeGitDir = join(gitDir, 'worktrees', 'wt');
  const guarded = [
    join(gitDir, 'hooks', 'post-checkout'),
    join(gitDir, 'config'),
    join(submoduleGitDir, 'config'),
    join(submoduleGitDir, 'hooks', 'post-checkout'),
    join(worktreeGitDir, 'config.worktree'),
    join(worktreeGitDir, 'commondir'),
  ];
  for (const path of guarded) {
    assert.ok(await exists(path) || path.endsWith('post-checkout'), `precondition: ${path}`);
  }
  const before = await snapshot(guarded);

  const sandbox = new NativeSrtWorkspaceCommandSandbox({
    workspaceRoot: root,
    commandPolicy: resolveNativeSrtCommandPolicy('trusted-vm'),
    environment: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  t.after(() => sandbox.close());
  const run = (command: string) =>
    sandbox.execute({
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'root',
      command,
      timeoutMs: 30_000,
      maxOutputBytes: 16_384,
    });

  // The worker process runs from outside the registered root, the way the
  // systemd user unit does (its cwd is the worker home, not the workspace).
  const previousCwd = process.cwd();
  process.chdir(outside);
  t.after(() => process.chdir(previousCwd));

  for (const path of guarded) {
    const attempt = await run(`printf tampered > '${path}'`);
    assert.notEqual(attempt.exitCode, 0, `expected a write to ${path} to be denied`);
  }
  // Planting a fresh hook file (not just overwriting one) must also be blocked.
  const plantHook = await run(
    `printf '#!/bin/sh\\ntouch ${join(base, 'PWNED')}\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`,
  );
  assert.notEqual(plantHook.exitCode, 0);

  // Metadata the host creates while the worker runs is covered from the next
  // command, not only what existed when the sandbox initialized.
  await git(root, 'worktree', 'add', '-q', '.worktrees/late', '-b', 'late');
  const lateCommondir = join(gitDir, 'worktrees', 'late', 'commondir');
  const lateBefore = await readFile(lateCommondir, 'utf8');
  const lateAttempt = await run(`printf tampered > '${lateCommondir}'`);
  assert.notEqual(lateAttempt.exitCode, 0, 'expected the new worktree metadata to be denied');
  assert.equal(await readFile(lateCommondir, 'utf8'), lateBefore);

  // A benign commit in the workspace must still succeed: the guard makes Git
  // metadata read-only, not the checkout or the writable object store.
  const committed = await run(
    `printf work > work.txt && git ${IDENTITY.join(' ')} add work.txt && git ${IDENTITY.join(' ')} commit -qm work`,
  );
  assert.equal(committed.exitCode, 0, committed.stderr);

  await sandbox.close();

  assert.equal(await exists(join(base, 'PWNED')), false);
  assert.deepEqual(await snapshot(guarded), before);
  assert.equal(await git(root, 'log', '-1', '--format=%s'), 'work');
});
