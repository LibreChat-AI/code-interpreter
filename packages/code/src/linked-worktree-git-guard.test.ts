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
  assert.match(await readFile(wrapper, 'utf8'), /^#!\/bin\/bash/);
  await execFileAsync('/bin/bash', ['-n', wrapper]);
  assert.match(await readFile(wrapper, 'utf8'), /run storage maintenance from the checkout/);

  const run = (args: string[]) => execFileAsync('git', args, {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  await run(['init', '-q', '-b', 'main']);
  assert.match((await run(['--version'])).stdout, /git version/);
  assert.equal((await run(['-C', repo, '-c', 'core.quotepath=false', 'status', '--short'])).stdout, '');
  for (const option of ['--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']) {
    assert.equal((await run([option, '-C', repo, 'status', '--short'])).stdout, '', option);
  }
  await writeFile(join(repo, 'literal[abc].txt'), 'literal\n');
  await run(['--literal-pathspecs', 'add', '--', 'literal[abc].txt']);
  assert.match((await run(['status', '--short'])).stdout, /A  literal\[abc\]\.txt/);

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
    ['--literal-pathspecs', 'prune', '--expire', 'now'],
  ];
  for (const args of blocked) {
    await assert.rejects(run(args), (error: unknown) => {
      const result = error as { code?: number; stderr?: string };
      return result.code === 1 && /run storage maintenance from the checkout/.test(result.stderr ?? '');
    }, `must reject git ${args.join(' ')}`);
    assert.equal((await run(['cat-file', '-t', object])).stdout.trim(), 'blob');
  }
  await assert.rejects(run(['--unrecognized-option', 'prune']), /unsupported global option/);
  assert.match((await run(['-C', repo, 'status', '--short'])).stdout, /\?\? unpublished\.txt\n/);

  // The guard is deliberately not a sandbox boundary: resetting PATH or using
  // an absolute Git binary can still prune shared objects.
  await execFileAsync('git', ['prune', '--expire', 'now'], { cwd: repo });
  await assert.rejects(run(['cat-file', '-e', object]));
});

test('lane Git guard rejects aliases from checkout config, -c, include.path and --config-env', async t => {
  if (process.platform === 'win32') return t.skip('the lane Git guard requires POSIX');
  const parent = await mkdtemp(join(tmpdir(), 'linked-worktree-alias-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const bin = join(parent, 'bin');
  const repo = join(parent, 'repo');
  const otherRepo = join(parent, 'other');
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(otherRepo)]);
  await writeLinkedWorktreeGitGuard(bin);
  const run = (args: string[], extraEnv: Record<string, string> = {}) => execFileAsync('git', args, {
    cwd: repo,
    env: { ...process.env, ...extraEnv, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  await run(['init', '-q', '-b', 'main']);
  await run(['config', 'alias.cleanup', 'prune --expire now']);
  await run(['config', 'alias.inspect', 'status --short']);
  await run(['config', 'alias.indirect', 'cleanup']);
  await run(['-C', otherRepo, 'init', '-q', '-b', 'main']);
  await run(['-C', otherRepo, 'config', 'alias.othercleanup', 'prune --expire now']);
  await writeFile(join(parent, 'aliases.cfg'), '[alias]\n  frominclude = prune --expire now\n');
  await writeFile(join(repo, 'unpublished.txt'), 'a different lane wrote this object\n');
  const object = (await run(['hash-object', '-w', 'unpublished.txt'])).stdout.trim();
  const blocked: Array<[string[], Record<string, string>?]> = [
    [['cleanup']],
    [['-C', repo, 'cleanup']],
    [['-C', otherRepo, 'othercleanup']],
    [['--git-dir=' + join(otherRepo, '.git'), 'othercleanup']],
    [['inspect']],
    [['indirect']],
    [['-c', 'alias.fromoption=prune --expire now', 'fromoption']],
    [['-c', 'alias.fromshell=!git prune --expire now', 'fromshell']],
    [['--git-dir=' + join(repo, '.git'), '-c', 'alias.fromgitdir=prune --expire now', 'fromgitdir']],
    [['-c', `include.path=${join(parent, 'aliases.cfg')}`, 'frominclude']],
    [['--config-env=alias.fromenv=LANE_TEST_GIT_ALIAS', 'fromenv'], { LANE_TEST_GIT_ALIAS: 'prune --expire now' }],
  ];
  for (const [args, environment] of blocked) {
    await assert.rejects(run(args, environment), (error: unknown) => {
      const result = error as { code?: number; stderr?: string };
      return result.code === 1 && /Git aliases are unavailable in linked worktree lanes/.test(result.stderr ?? '');
    }, `must reject Git alias in ${JSON.stringify(args)}`);
    assert.equal((await run(['cat-file', '-t', object])).stdout.trim(), 'blob');
  }
  assert.match((await run(['status', '--short'])).stdout, /unpublished\.txt/);
});

test('a lane rejects a checkout-defined maintenance alias before pruning another lane’s unpublished object', async t => {
  if (process.platform === 'win32') return t.skip('the lane Git guard requires POSIX');
  const parent = await mkdtemp(join(tmpdir(), 'linked-worktree-shared-alias-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const checkout = join(parent, 'checkout');
  const bin = join(parent, 'bin');
  await Promise.all([mkdir(checkout), mkdir(bin)]);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: checkout });
  await execFileAsync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'seed',
  ], { cwd: checkout });
  await mkdir(join(checkout, '.worktrees'));
  const lane = join(checkout, '.worktrees', 'task');
  await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'task', lane], { cwd: checkout });
  await execFileAsync('git', ['config', 'alias.cleanup', 'prune --expire now'], { cwd: checkout });
  await writeLinkedWorktreeGitGuard(bin);
  await writeFile(join(lane, 'pending.txt'), 'another lane has not updated its ref\n');
  const run = (args: string[]) => execFileAsync('git', args, {
    cwd: lane,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  const object = (await run(['hash-object', '-w', 'pending.txt'])).stdout.trim();
  await assert.rejects(run(['cleanup']), (error: unknown) => {
    const result = error as { code?: number; stderr?: string };
    return result.code === 1 && /Git aliases are unavailable in linked worktree lanes/.test(result.stderr ?? '');
  });
  assert.equal((await run(['cat-file', '-t', object])).stdout.trim(), 'blob');
});
