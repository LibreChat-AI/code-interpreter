import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { GitWorktreeManager } from './worktrees.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';

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

async function source(root: string) {
  return { root, identity: await captureWorkspaceRootIdentity(root) };
}

test('creates and reuses an isolated worktree for one conversation identity', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 4,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const id = 'a'.repeat(64);

  const [first, concurrent] = await Promise.all([
    manager.resolve('primary', id),
    manager.resolve('primary', id),
  ]);
  assert.deepEqual(concurrent, first);
  assert.notEqual(first.root, fixture.root);
  assert.equal(first.gitSharedObjectDirectory.startsWith(first.root), true);
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
    sources: new Map([['primary', await source(fixture.root)]]),
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
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const first = await manager.resolve('primary', id);
  await writeFile(join(first.root, 'README.md'), 'partial mutation\n');
  await rm(`${first.root}.complete`);

  const restarted = new GitWorktreeManager({
    maxCount: 4,
    root: storage,
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const recovered = await restarted.resolve('primary', id);
  assert.equal(
    await readFile(join(recovered.root, 'README.md'), 'utf8'),
    'source\n',
  );
});

test('does not count an incomplete checkout against capacity after restart', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const storage = join(fixture.parent, 'instances');
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const abandoned = await manager.resolve('primary', 'c'.repeat(64));
  await rm(`${abandoned.root}.complete`);
  const staleMarker = `${abandoned.root}.complete.1.tmp`;
  await writeFile(staleMarker, '1\n');

  const restarted = new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const replacement = await restarted.resolve('primary', 'd'.repeat(64));
  assert.equal((await stat(replacement.root)).isDirectory(), true);
  await assert.rejects(stat(abandoned.root), { code: 'ENOENT' });
  await assert.rejects(stat(staleMarker), { code: 'ENOENT' });
});

test('keeps a conversation checkout independent of source object pruning', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await writeFile(join(fixture.root, 'SECOND.md'), 'second\n');
  await git(fixture.root, 'add', 'SECOND.md');
  await git(
    fixture.root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'second',
  );
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const instance = await manager.resolve('primary', 'e'.repeat(64));
  const retainedHead = await git(instance.root, 'rev-parse', 'HEAD');

  await git(fixture.root, 'reset', '--hard', 'HEAD~1');
  await git(fixture.root, 'reflog', 'expire', '--expire=now', '--all');
  await git(fixture.root, 'gc', '--prune=now');

  assert.equal(await git(instance.root, 'rev-parse', 'HEAD'), retainedHead);
  assert.equal(
    await readFile(join(instance.root, 'SECOND.md'), 'utf8'),
    'second\n',
  );
  await assert.rejects(
    readFile(join(instance.gitSharedObjectDirectory, 'info', 'alternates')),
    { code: 'ENOENT' },
  );
});

test('dissociates a checkout from inherited source alternates', async (t) => {
  const upstream = await repository();
  const sharedParent = await mkdtemp(join(tmpdir(), 'librechat-shared-source-'));
  const sharedRoot = join(sharedParent, 'source');
  t.after(() =>
    Promise.all([
      rm(upstream.parent, { recursive: true, force: true }),
      rm(sharedParent, { recursive: true, force: true }),
    ]),
  );
  await execFileAsync('git', ['clone', '--shared', upstream.root, sharedRoot]);
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(sharedParent, 'instances'),
    sources: new Map([['primary', await source(await realpath(sharedRoot))]]),
  });
  const instance = await manager.resolve('primary', 'f'.repeat(64));
  await rm(upstream.root, { recursive: true, force: true });

  assert.equal(
    await git(instance.root, 'rev-parse', 'HEAD^{commit}'),
    await git(instance.root, 'rev-parse', 'HEAD'),
  );
  await assert.rejects(
    readFile(join(instance.gitSharedObjectDirectory, 'info', 'alternates')),
    { code: 'ENOENT' },
  );
});

test('provisions an orphan branch for a repository with an unborn HEAD', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-empty-source-'));
  const root = join(parent, 'source');
  await execFileAsync('git', ['init', root]);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(parent, 'instances'),
    sources: new Map([['primary', await source(await realpath(root))]]),
  });

  const instance = await manager.resolve('primary', '0'.repeat(64));
  assert.match(
    await git(instance.root, 'branch', '--show-current'),
    /^librechat\/conversation-/,
  );
  await assert.rejects(git(instance.root, 'rev-parse', '--verify', 'HEAD'));
});

test('rejects replacement of the admitted worktree storage root', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const storage = join(fixture.parent, 'instances');
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  await manager.resolve('primary', '1'.repeat(64));
  await rename(storage, `${storage}.original`);
  await mkdir(storage, { mode: 0o700 });

  await assert.rejects(
    manager.resolve('primary', '1'.repeat(64)),
    /storage changed after admission/,
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
      ['first', await source(first.root)],
      ['second', await source(second.root)],
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
  assert.throws(
    () =>
      new GitWorktreeManager({
        cloneTimeoutMs: 29_999,
        maxCount: 1,
        root: join(fixture.parent, 'instances'),
        sources: new Map([
          [
            'primary',
            {
              root: fixture.root,
              identity: { path: fixture.root, dev: '1', ino: '1' },
            },
          ],
        ]),
      }),
    /clone timeout/,
  );
  const overlapping = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.root, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  await assert.rejects(
    overlapping.resolve('primary', 'a'.repeat(64)),
    /must not overlap/,
  );

  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  await assert.rejects(manager.resolve('primary', '../escape'), /SHA-256/);
  const first = await manager.resolve('primary', 'a'.repeat(64));
  assert.equal((await stat(first.root)).isDirectory(), true);
  await assert.rejects(
    manager.resolve('primary', 'b'.repeat(64)),
    /capacity is exhausted/,
  );
});

test('serializes provisioning across manager instances sharing storage', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const options = {
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  };
  const results = await Promise.allSettled([
    new GitWorktreeManager(options).resolve('primary', 'a'.repeat(64)),
    new GitWorktreeManager(options).resolve('primary', 'b'.repeat(64)),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(
    (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.message,
    /capacity is exhausted/,
  );
});

test('prepares a new checkout before publishing its completion marker', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  let attempts = 0;
  const options = {
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
    prepareInstance: async (instance: { root: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('setup failed');
      await writeFile(join(instance.root, 'prepared'), 'yes\n');
    },
  };
  const id = 'c'.repeat(64);
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', id),
    /setup failed/,
  );
  const instance = await new GitWorktreeManager(options).resolve('primary', id);
  assert.equal(await readFile(join(instance.root, 'prepared'), 'utf8'), 'yes\n');
  assert.equal(attempts, 2);
});

test('rebuilds a completed checkout when its admitted source changes', async (t) => {
  const first = await repository();
  const second = await repository();
  t.after(() => rm(first.parent, { recursive: true, force: true }));
  t.after(() => rm(second.parent, { recursive: true, force: true }));
  await writeFile(join(second.root, 'README.md'), 'replacement\n');
  await git(second.root, 'add', 'README.md');
  await git(
    second.root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'replacement',
  );
  const storage = join(first.parent, 'instances');
  const id = 'e'.repeat(64);
  await new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(first.root)]]),
  }).resolve('primary', id);
  const replacement = await new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(second.root)]]),
  }).resolve('primary', id);
  assert.equal(await readFile(join(replacement.root, 'README.md'), 'utf8'), 'replacement\n');
});

test('rejects a source whose admitted filesystem identity changed', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const metadata = await stat(fixture.root, { bigint: true });
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([
      [
        'primary',
        {
          root: fixture.root,
          identity: {
            path: fixture.root,
            dev: metadata.dev.toString(),
            ino: (metadata.ino + 1n).toString(),
          },
        },
      ],
    ]),
  });

  await assert.rejects(
    manager.resolve('primary', 'd'.repeat(64)),
    /source changed after admission/,
  );
});
