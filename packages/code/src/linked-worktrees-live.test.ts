import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { verifyLinkedWorktree } from './linked-worktrees.js';
import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import { resolveNativeSrtCommandPolicy } from './native-policy.js';

const execFileAsync = promisify(execFile);
const IDENTITY = ['-c', 'user.name=lane', '-c', 'user.email=lane@example.com', '-c', 'commit.gpgsign=false'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', [...IDENTITY, ...args], { cwd })).stdout.trim();
}

async function snapshot(paths: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await readFile(path, 'utf8').catch(() => null)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * The worker's home is read-denied, so a checkout beneath it exercises the
 * sandbox's tmpfs re-binding; one beneath the system temporary directory does not.
 */
for (const [location, parent] of [
  ['beneath the worker home', homedir()],
  ['outside the worker home', tmpdir()],
] as const) {
  test(`real SRT lets a linked worktree lane commit while checkout and sibling Git metadata stay intact (${location})`, {
    skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
    timeout: 60_000,
  }, async (t) => {
    const base = await realpath(await mkdtemp(join(parent, 'lane-live-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'repo');
    await mkdir(root);
    await git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'tracked.txt'), 'checkout\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'init');
    await mkdir(join(root, '.worktrees'));
    await git(root, 'worktree', 'add', '-q', '-b', 'task-a', '.worktrees/task-a');
    await git(root, 'worktree', 'add', '-q', '-b', 'task-b', '.worktrees/task-b');

    const commonGitDir = join(root, '.git');
    const protectedFiles = [
      join(commonGitDir, 'HEAD'),
      join(commonGitDir, 'index'),
      join(commonGitDir, 'config'),
      join(commonGitDir, 'MERGE_HEAD'),
      join(commonGitDir, 'packed-refs'),
      join(commonGitDir, 'hooks', 'pre-commit'),
      join(commonGitDir, 'worktrees', 'task-b', 'HEAD'),
      join(root, 'tracked.txt'),
    ];
    const before = await snapshot(protectedFiles);
    const lane = await verifyLinkedWorktree(root, 'task-a');
    const sandbox = new NativeSrtWorkspaceCommandSandbox({
      workspaceRoot: lane.root,
      workspaceIdentity: lane.identity,
      linkedWorktree: {
        checkoutRoot: lane.checkoutRoot,
        commonGitDir: lane.commonGitDir,
        writableGitPaths: lane.writableGitPaths,
      },
      commandPolicy: resolveNativeSrtCommandPolicy('trusted-vm'),
      environment: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    });
    t.after(() => sandbox.close());
    const run = (command: string) =>
      sandbox.execute({
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'lane',
        command,
        timeoutMs: 30_000,
        maxOutputBytes: 16_384,
      });
    const gitInLane = `git ${IDENTITY.join(' ')}`;

    const committed = await run(
      `printf lane > lane.txt && ${gitInLane} add lane.txt && ${gitInLane} commit -qm lane && ${gitInLane} branch lane-extra`,
    );
    assert.equal(committed.exitCode, 0, committed.stderr);

    for (const path of protectedFiles) {
      await run(`printf tampered > '${path}'`);
    }
    // Packing must not move refs into storage that vanishes with the sandbox.
    await run(`${gitInLane} pack-refs --all`);
    await sandbox.close();

    for (const branch of ['main', 'task-a', 'task-b', 'lane-extra']) {
      assert.ok(await git(root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`), branch);
    }

    assert.equal(await git(root, 'log', '-1', '--format=%s', 'task-a'), 'lane');
    assert.deepEqual(await snapshot(protectedFiles), before);
    assert.equal(await git(root, 'status', '--porcelain', '--untracked-files=no'), '');
    await assert.rejects(stat(join(commonGitDir, 'MERGE_HEAD')), { code: 'ENOENT' });
  });
}
