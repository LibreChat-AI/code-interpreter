import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GitWorktreeManager } from './worktrees.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { GitSourceSnapshot } from './git-snapshot.js';

const execFileAsync = promisify(execFile);

test('aborting private staging releases its reservation only after cleanup', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const controller = new AbortController();
  const copy = GitSourceSnapshot.prototype.copyTo;
  const mocked = t.mock.method(
    GitSourceSnapshot.prototype,
    'copyTo',
    async function (
      this: GitSourceSnapshot,
      destination: string,
      signal?: AbortSignal
    ) {
      await copy.call(this, destination, signal);
      controller.abort();
    }
  );
  const id = 'b'.repeat(64);
  const path = await manager.plannedRoot('primary', id);
  await assert.rejects(manager.resolve('primary', id, controller.signal), {
    name: 'AbortError',
  });
  for (const name of [path, `${path}.source`, `${path}.complete`])
    await assert.rejects(stat(name), { code: 'ENOENT' });
  mocked.mock.restore();
  assert.ok(await manager.resolve('primary', 'c'.repeat(64)));
});

test('setup cannot publish a checkout that redirects its Git metadata', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
    prepareInstance: async (instance) => {
      await writeFile(
        join(instance.root, '.git', 'commondir'),
        join(fixture.root, '.git')
      );
    },
  });
  await assert.rejects(
    manager.resolve('primary', 'd'.repeat(64)),
    /must not redirect/
  );
});

test('private snapshots preserve SHA-256 repositories and the configured origin', async (t) => {
  const fixture = await repository('sha256');
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await git(
    fixture.root,
    'remote',
    'add',
    'origin',
    'https://github.com/example/repo.git'
  );
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const instance = await manager.resolve('primary', 'a'.repeat(64));
  assert.equal(
    await git(instance.root, 'rev-parse', '--show-object-format'),
    'sha256'
  );
  assert.equal(
    await git(instance.root, 'remote', 'get-url', 'origin'),
    'https://github.com/example/repo.git'
  );
  assert.equal(
    await readFile(join(instance.root, 'README.md'), 'utf8'),
    'source\n'
  );
});

test('sidecar-only crash reservations consume quota after restart', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const admitted = await source(fixture.root);
  const options = {
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', admitted]]),
  };
  const manager = new GitWorktreeManager(options);
  const path = await manager.plannedRoot('primary', 'a'.repeat(64));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    `${path}.complete`,
    JSON.stringify({
      version: 2,
      source: admitted.identity,
      sourceGit: (await GitSourceSnapshot.admit(admitted.identity)).fingerprint,
      provisioningFailed: true,
    })
  );
  const restarted = new GitWorktreeManager(options);
  await assert.rejects(
    restarted.resolve('primary', 'b'.repeat(64)),
    /capacity is exhausted/
  );
  await assert.rejects(
    restarted.resolve('primary', 'a'.repeat(64)),
    /operator recovery required/
  );
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('linked-worktree sources retain their own HEAD and admitted common objects', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const linked = join(fixture.parent, 'linked');
  await git(fixture.root, 'worktree', 'add', '-b', 'linked', linked);
  await writeFile(join(linked, 'linked.txt'), 'linked\n');
  await git(linked, 'add', 'linked.txt');
  await git(
    linked,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'linked'
  );
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(linked)]]),
  });
  const instance = await manager.resolve('primary', 'e'.repeat(64));
  assert.equal(
    await readFile(join(instance.root, 'linked.txt'), 'utf8'),
    'linked\n'
  );
});

test('restart cannot rebind a completed checkout to replacement source Git metadata', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const options = {
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  };
  const id = 'f'.repeat(64);
  const instance = await new GitWorktreeManager(options).resolve('primary', id);
  await writeFile(join(instance.root, 'uncommitted.txt'), 'keep');
  await rename(join(fixture.root, '.git'), join(fixture.root, '.git-original'));
  await git(fixture.root, 'init');
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', id),
    /source identity changed/
  );
  assert.equal(
    await readFile(join(instance.root, 'uncommitted.txt'), 'utf8'),
    'keep'
  );
});

test('rejects source Git redirection without changing the admitted working-directory inode', async (t) => {
  const fixture = await repository();
  const other = await repository();
  t.after(() =>
    Promise.all(
      [fixture, other].map(({ parent }) =>
        rm(parent, { recursive: true, force: true })
      )
    )
  );
  const manager = new GitWorktreeManager({
    maxCount: 2,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  await manager.prepare();
  await rename(join(fixture.root, '.git'), join(fixture.root, '.git-original'));
  await writeFile(
    join(fixture.root, '.git'),
    `gitdir: ${join(other.root, '.git')}\n`
  );
  await assert.rejects(
    manager.resolve('primary', 'c'.repeat(64)),
    /Git metadata changed/
  );
});

test('source replacement after validation cannot redirect the private snapshot', async (t) => {
  const fixture = await repository();
  const other = await repository();
  t.after(() =>
    Promise.all(
      [fixture, other].map(({ parent }) =>
        rm(parent, { recursive: true, force: true })
      )
    )
  );
  const snapshot = await GitSourceSnapshot.admit(
    (
      await source(fixture.root)
    ).identity
  );
  const validate = snapshot.validate.bind(snapshot);
  t.mock.method(snapshot, 'validate', async () => {
    await validate();
    await rename(
      join(fixture.root, '.git'),
      join(fixture.root, '.git-original')
    );
    await symlink(join(other.root, '.git'), join(fixture.root, '.git'));
  });
  await assert.rejects(snapshot.copyTo(join(fixture.parent, 'snapshot')));
  await assert.rejects(
    stat(join(fixture.parent, 'snapshot', 'objects', 'pack')),
    { code: 'ENOENT' }
  );
});

test('cached instances reject object-directory redirection before executor recreation', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const id = 'd'.repeat(64);
  const instance = await manager.resolve('primary', id);
  await rename(
    join(instance.root, '.git', 'objects'),
    join(instance.root, '.git', 'objects-original')
  );
  await symlink(
    join(fixture.root, '.git', 'objects'),
    join(instance.root, '.git', 'objects')
  );
  await assert.rejects(
    manager.resolve('primary', id),
    /does not own its Git objects/
  );
});

test('snapshot rejects symlinked refs and never copies source hooks or config includes', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await git(fixture.root, 'config', 'include.path', '/not-readable/config');
  const snapshot = await GitSourceSnapshot.admit(
    (
      await source(fixture.root)
    ).identity
  );
  await snapshot.copyTo(join(fixture.parent, 'snapshot'));
  assert.equal(
    await readFile(join(fixture.parent, 'snapshot', 'config'), 'utf8'),
    '[core]\nrepositoryformatversion = 0\nbare = true\n'
  );
  await assert.rejects(stat(join(fixture.parent, 'snapshot', 'hooks')), {
    code: 'ENOENT',
  });
  await symlink(
    join(fixture.root, 'README.md'),
    join(fixture.root, '.git', 'refs', 'bad')
  );
  await assert.rejects(
    snapshot.copyTo(join(fixture.parent, 'snapshot-bad')),
    /symbolic link/
  );
});

test(
  'restart preserves a checkout reserved by a crashed provisioning process',
  { timeout: 10_000 },
  async (t) => {
    const fixture = await repository();
    const admitted = await source(fixture.root);
    const storage = join(fixture.parent, 'instances');
    const id = '9'.repeat(64);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { GitWorktreeManager } from ${JSON.stringify(
      new URL('./worktrees.js', import.meta.url).href
    )};
    const manager = new GitWorktreeManager({
      maxCount: 1, root: ${JSON.stringify(storage)},
      sources: new Map([['primary', ${JSON.stringify(admitted)}]]),
      prepareInstance: async () => {
        process.stdout.write('setup-started');
        await new Promise(() => { setInterval(() => {}, 1000); });
      },
    });
    await manager.resolve('primary', ${JSON.stringify(id)});
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill('SIGKILL');
      await closed;
      await rm(fixture.parent, { recursive: true, force: true });
    });
    await once(child.stdout!, 'data');
    child.kill('SIGKILL');
    await closed;
    const restarted = new GitWorktreeManager({
      maxCount: 1,
      root: storage,
      sources: new Map([['primary', admitted]]),
    });
    await assert.rejects(
      restarted.resolve('primary', id),
      /operator recovery required/
    );
    await assert.rejects(
      restarted.resolve('primary', '8'.repeat(64)),
      /capacity is exhausted/
    );
    assert.equal(
      await readFile(
        join(await restarted.plannedRoot('primary', id), 'README.md'),
        'utf8'
      ),
      'source\n'
    );
  }
);

test('cached checkouts revalidate their admitted source without deleting user work', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  const id = 'f'.repeat(64);
  const instance = await manager.resolve('primary', id);
  await writeFile(join(instance.root, 'pending.txt'), 'user work');
  await rename(fixture.root, `${fixture.root}.original`);
  await mkdir(fixture.root);
  await assert.rejects(
    manager.resolve('primary', id),
    /source changed after admission/
  );
  assert.equal(
    await readFile(join(instance.root, 'pending.txt'), 'utf8'),
    'user work'
  );
});

test('preserves a failed setup checkout until executor cleanup is confirmed', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const options = {
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
    prepareInstance: async () => {
      throw new Error('setup failed');
    },
    discardInstance: async () => {
      throw new Error('child cleanup unconfirmed');
    },
  };
  const manager = new GitWorktreeManager(options);
  const id = 'a'.repeat(64);
  await assert.rejects(manager.resolve('primary', id), /cleanup unconfirmed/);
  const root = await manager.plannedRoot('primary', id);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'source\n');
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', id),
    /operator recovery required/
  );
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', 'b'.repeat(64)),
    /capacity is exhausted/
  );
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'source\n');
});

test('cancellation waits for setup cleanup before releasing provisioning ownership', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  let started!: () => void;
  const setupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cleanupFinished = false;
  let setupRoot = '';
  const manager = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
    prepareInstance: async (instance, signal) => {
      const reservation = JSON.parse(
        await readFile(`${instance.root}.complete`, 'utf8')
      );
      assert.equal(reservation.provisioningFailed, true);
      setupRoot = instance.root;
      started();
      try {
        await delay(60_000, undefined, { signal });
        await writeFile(join(instance.root, 'LATE'), 'should never happen');
      } finally {
        await delay(20);
        cleanupFinished = true;
      }
    },
  });
  const controller = new AbortController();
  const pending = manager.resolve('primary', 'a'.repeat(64), controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setupStarted;
  controller.abort();
  await rejected;
  assert.equal(cleanupFinished, true);
  await assert.rejects(stat(setupRoot), { code: 'ENOENT' });
  await assert.rejects(stat(`${setupRoot}.complete`), { code: 'ENOENT' });
});

test('cancels lock wait without provisioning while another caller continues', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  let started!: () => void;
  const setupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  let setups = 0;
  const options = {
    maxCount: 2,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
    prepareInstance: async () => {
      setups++;
      started();
      await released;
    },
  };
  const active = new GitWorktreeManager(options).resolve(
    'primary',
    'a'.repeat(64)
  );
  await setupStarted;
  const controller = new AbortController();
  const manager = new GitWorktreeManager(options);
  const waiting = manager.resolve('primary', 'b'.repeat(64), controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await delay(75);
  controller.abort();
  await rejected;
  assert.equal(setups, 1);
  release();
  await active;
  await assert.rejects(
    stat(await manager.plannedRoot('primary', 'b'.repeat(64))),
    { code: 'ENOENT' }
  );
});

test('recovery preserves unknown directories and malformed completion records', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const options = {
    maxCount: 4,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  };
  const manager = new GitWorktreeManager(options);
  const first = await manager.resolve('primary', 'a'.repeat(64));
  const unrelated = join(options.root, 'operator-backups', 'important');
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, 'notes'), 'keep');
  await manager.resolve('primary', 'b'.repeat(64));
  assert.equal(await readFile(join(unrelated, 'notes'), 'utf8'), 'keep');
  await writeFile(`${first.root}.complete`, '{"version":0}');
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', 'a'.repeat(64)),
    /completion record is invalid/
  );
  await assert.rejects(
    new GitWorktreeManager(options).resolve('primary', 'c'.repeat(64)),
    /completion record is invalid/
  );
  assert.equal(
    await readFile(join(first.root, 'README.md'), 'utf8'),
    'source\n'
  );
});

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

async function repository(
  objectFormat = 'sha1'
): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-worktrees-'));
  const root = join(parent, 'source');
  await execFileAsync('git', ['init', `--object-format=${objectFormat}`, root]);
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
    'initial'
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
  assert.equal(
    (await realpath(join(first.root, '.git', 'objects'))).startsWith(
      first.root
    ),
    true
  );
  const instanceCommon = await realpath(
    await git(
      first.root,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    )
  );
  assert.equal(instanceCommon.startsWith(first.root), true);
  assert.equal(
    await readFile(join(first.root, 'README.md'), 'utf8'),
    'source\n'
  );

  await writeFile(join(first.root, 'README.md'), 'conversation\n');
  assert.equal(
    await readFile(join(fixture.root, 'README.md'), 'utf8'),
    'source\n'
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
    'source\n'
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
    'second'
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
    'second\n'
  );
  await assert.rejects(
    readFile(join(instance.root, '.git', 'objects', 'info', 'alternates')),
    { code: 'ENOENT' }
  );
});

test('dissociates a checkout from inherited source alternates', async (t) => {
  const upstream = await repository();
  const sharedParent = await mkdtemp(
    join(tmpdir(), 'librechat-shared-source-')
  );
  const sharedRoot = join(sharedParent, 'source');
  t.after(() =>
    Promise.all([
      rm(upstream.parent, { recursive: true, force: true }),
      rm(sharedParent, { recursive: true, force: true }),
    ])
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
    await git(instance.root, 'rev-parse', 'HEAD')
  );
  await assert.rejects(
    readFile(join(instance.root, '.git', 'objects', 'info', 'alternates')),
    { code: 'ENOENT' }
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
    /^librechat\/conversation-/
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
    /storage changed after admission/
  );
});

test('keeps conversations and source repositories isolated', async (t) => {
  const first = await repository();
  const second = await repository();
  t.after(() =>
    Promise.all([
      rm(first.parent, { recursive: true, force: true }),
      rm(second.parent, { recursive: true, force: true }),
    ])
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
    3
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
              identity: {
                path: fixture.root,
                dev: '1',
                ino: '1',
              },
            },
          ],
        ]),
      }),
    /clone timeout/
  );
  const overlapping = new GitWorktreeManager({
    maxCount: 1,
    root: join(fixture.root, 'instances'),
    sources: new Map([['primary', await source(fixture.root)]]),
  });
  await assert.rejects(
    overlapping.resolve('primary', 'a'.repeat(64)),
    /must not overlap/
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
    /capacity is exhausted/
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
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1
  );
  assert.match(
    (
      results.find(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult
    ).reason.message,
    /capacity is exhausted/
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
    /setup failed/
  );
  const instance = await new GitWorktreeManager(options).resolve('primary', id);
  assert.equal(
    await readFile(join(instance.root, 'prepared'), 'utf8'),
    'yes\n'
  );
  assert.equal(attempts, 2);
});

test('preserves a completed checkout when its admitted source changes', async (t) => {
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
    'replacement'
  );
  const storage = join(first.parent, 'instances');
  const id = 'e'.repeat(64);
  const original = await new GitWorktreeManager({
    maxCount: 1,
    root: storage,
    sources: new Map([['primary', await source(first.root)]]),
  }).resolve('primary', id);
  await writeFile(join(original.root, 'UNCOMMITTED.md'), 'user work\n');
  await assert.rejects(
    new GitWorktreeManager({
      maxCount: 1,
      root: storage,
      sources: new Map([['primary', await source(second.root)]]),
    }).resolve('primary', id),
    /source identity changed/
  );
  assert.equal(
    await readFile(join(original.root, 'UNCOMMITTED.md'), 'utf8'),
    'user work\n'
  );
  assert.equal(
    await readFile(join(original.root, 'README.md'), 'utf8'),
    'source\n'
  );
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
    /source changed after admission/
  );
});
