import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { writeLinkedWorktreeGitGuard } from './linked-worktree-git-guard.js';

const execFileAsync = promisify(execFile);

test('lane Git guard prevents destructive maintenance after global options without breaking ordinary Git', async t => {
  if (process.platform === 'win32') return t.skip('the lane Git guard requires POSIX');
  const parent = await mkdtemp(join(tmpdir(), 'linked-worktree-git-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const bin = join(parent, 'bin');
  const repo = join(parent, 'repo');
  await Promise.all([mkdir(bin), mkdir(repo)]);
  await writeLinkedWorktreeGitGuard(bin);
  const wrapper = join(bin, 'git');
  assert.equal((await stat(wrapper)).mode & 0o222, 0, 'the script is not writable');
  assert.match(await readFile(wrapper, 'utf8'), /run storage maintenance from the checkout/);

  const run = (args: string[]) => execFileAsync('git', args, {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  await run(['init', '-q', '-b', 'main']);
  assert.match((await run(['--version'])).stdout, /git version/);
  assert.equal((await run(['-C', repo, '-c', 'core.quotepath=false', 'status', '--short'])).stdout, '');

  // Git has created this object, but no ref points to it yet. Another lane can be
  // in exactly this window between writing objects and updating a ref.
  await writeFile(join(repo, 'unpublished.txt'), 'from a second lane\n');
  const object = (await run(['hash-object', '-w', 'unpublished.txt'])).stdout.trim();
  const blocked = [
    ['prune', '--expire', 'now'],
    ['-C', repo, 'prune', '--expire=now'],
    ['-C' + repo, '-c', 'gc.auto=0', '--git-dir=' + join(repo, '.git'), 'prune', '--expire=now'],
    ['--no-pager', '-cgc.auto=0', 'gc', '--force'],
    ['repack', '-ad'],
    ['prune-packed'],
    ['maintenance', 'run', '--task=gc'],
    ['multi-pack-index', 'expire'],
    ['lfs', 'prune'],
  ];
  for (const args of blocked) {
    await assert.rejects(run(args), (error: unknown) => {
      const result = error as { code?: number; stderr?: string };
      return result.code === 1 && /run storage maintenance from the checkout/.test(result.stderr ?? '');
    }, `must reject git ${args.join(' ')}`);
    assert.equal((await run(['cat-file', '-t', object])).stdout.trim(), 'blob');
  }
  await assert.rejects(run(['--unrecognized-option', 'prune']), /unsupported global option/);
  assert.equal((await run(['-C', repo, 'status', '--short'])).stdout, '?? unpublished.txt\n');

  // The guard is deliberately not a sandbox boundary: resetting PATH or using
  // an absolute Git binary can still prune shared objects.
  await execFileAsync('git', ['prune', '--expire', 'now'], { cwd: repo });
  await assert.rejects(run(['cat-file', '-e', object]));
});
