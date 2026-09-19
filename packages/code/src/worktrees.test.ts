import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { GitWorktreeManager } from './worktrees.js';

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  return result.stdout.trim();
}

async function repository(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-worktrees-'));
  const root = join(parent, 'source');
  await execFileAsync('git', ['init', root]);
  await writeFile(join(root, 'README.md'), 'source\n');
  await git(root, 'add', 'README.md');
  await git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  );
  return { parent, root: await realpath(root) };
}

test('creates and reuses an isolated worktree for one conversation identity', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 4,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  const id = 'a'.repeat(64);

  const [first, concurrent] = await Promise.all([
    manager.resolve('primary', id),
    manager.resolve('primary', id),
  ]);
  assert.deepEqual(concurrent, first);
  assert.notEqual(first.root, fixture.root);
  assert.equal(first.gitSharedObjectDirectory.startsWith(fixture.root), true);
  const instanceCommon = await realpath(
    await git(
      first.root,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ),
  );
  assert.equal(instanceCommon.startsWith(first.root), true);
  assert.equal(
    await readFile(join(first.root, 'README.md'), 'utf8'),
    'source\n',
  );

  await writeFile(join(first.root, 'README.md'), 'conversation\n');
  assert.equal(
    await readFile(join(fixture.root, 'README.md'), 'utf8'),
    'source\n',
  );

  const restarted = new GitWorktreeManager({
    maxCount: 4,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  assert.equal((await restarted.resolve('primary', id)).root, first.root);
});

test('replaces an incomplete checkout before admitting it after restart', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const storage = join(fixture.parent, 'instances');
  const id = 'c'.repeat(64);
  const manager = new GitWorktreeManager({
    maxCount: 4,
    root: storage,
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  const first = await manager.resolve('primary', id);
  await writeFile(join(first.root, 'README.md'), 'partial mutation\n');
  await rm(`${first.root}.complete`);

  const restarted = new GitWorktreeManager({
    maxCount: 4,
    root: storage,
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  const recovered = await restarted.resolve('primary', id);
  assert.equal(
    await readFile(join(recovered.root, 'README.md'), 'utf8'),
    'source\n',
  );
});

test('keeps conversations and source repositories isolated', async (t) => {
  const first = await repository();
  const second = await repository();
  t.after(() =>
    Promise.all([
      rm(first.parent, { recursive: true, force: true }),
      rm(second.parent, { recursive: true, force: true }),
    ]),
  );
  const storage = await mkdtemp(join(tmpdir(), 'librechat-worktree-storage-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 4,
    root: storage,
    sources: new Map([
      ['first', { root: first.root }],
      ['second', { root: second.root }],
    ]),
  });

  const firstConversation = await manager.resolve('first', '1'.repeat(64));
  const secondConversation = await manager.resolve('first', '2'.repeat(64));
  const otherRepository = await manager.resolve('second', '1'.repeat(64));
  assert.equal(
    new Set([
      firstConversation.root,
      secondConversation.root,
      otherRepository.root,
    ]).size,
    3,
  );
});

test('rejects invalid identities, overlapping storage and exhausted capacity', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const overlapping = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.root, 'instances'),
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  await assert.rejects(
    overlapping.resolve('primary', 'a'.repeat(64)),
    /must not overlap/,
  );

  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  await assert.rejects(manager.resolve('primary', '../escape'), /SHA-256/);
  const first = await manager.resolve('primary', 'a'.repeat(64));
  assert.equal((await stat(first.root)).isDirectory(), true);
  await assert.rejects(
    manager.resolve('primary', 'b'.repeat(64)),
    /capacity is exhausted/,
  );
});
