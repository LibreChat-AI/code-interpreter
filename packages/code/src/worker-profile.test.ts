import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertIdentityPathIsPrivate } from './storage.js';
import {
  assertWorkerProfileIsolation,
  defaultWorkerProfilePath,
  loadWorkerProfile,
  saveWorkerProfile,
  workerProfileArguments,
} from './worker-profile.js';
import type { WorkerProfile } from './worker-profile.js';

function profile(directory: string): WorkerProfile {
  return {
    version: 1,
    identityPath: join(directory, 'identity.json'),
    workspace: { type: 'private' },
    allowWorkspaceWrites: false,
    allowWorkspaceCommands: false,
  };
}

test('the default worker profile is separate from identity storage', () => {
  assert.equal(
    defaultWorkerProfilePath(),
    join(homedir(), '.config', 'librechat', 'code', 'profiles', 'default.json'),
  );
});

test('worker profiles roundtrip atomically with owner-only file and directory permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profiles', 'default.json');
  const value = profile(directory);
  await saveWorkerProfile(path, value);
  assert.deepEqual(await loadWorkerProfile(path), value);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'profiles'))).mode & 0o777, 0o700);

  const updated: WorkerProfile = {
    ...value,
    workspace: {
      type: 'directory',
      path: join(directory, 'project with spaces'),
    },
    allowWorkspaceWrites: true,
    allowWorkspaceCommands: true,
  };
  await saveWorkerProfile(path, updated);
  assert.deepEqual(await loadWorkerProfile(path), updated);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(directory, 'profiles')), [
    'default.json',
  ]);
});

test('worker profile arguments enable only explicitly granted permissions', () => {
  for (const workspace of [
    { type: 'private' as const },
    { type: 'directory' as const, path: '/srv/project with spaces' },
  ]) {
    for (const allowWorkspaceWrites of [false, true]) {
      for (const allowWorkspaceCommands of [false, true]) {
        const value = {
          ...profile('/srv'),
          workspace,
          allowWorkspaceWrites,
          allowWorkspaceCommands,
        };
        assert.deepEqual(workerProfileArguments(value), [
          ...(workspace.type === 'private'
            ? ['--default-workspace']
            : ['--worker-dir', workspace.path]),
          ...(allowWorkspaceWrites ? ['--allow-workspace-writes'] : []),
          ...(allowWorkspaceCommands ? ['--allow-workspace-commands'] : []),
        ]);
      }
    }
  }
});

test('only an absent worker profile returns undefined', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(
    await loadWorkerProfile(join(directory, 'absent.json')),
    undefined,
  );
  assert.equal(
    await loadWorkerProfile(join(directory, 'missing', 'absent.json')),
    undefined,
  );
  await assert.rejects(loadWorkerProfile(directory), /size or type/);

  const dangling = join(directory, 'dangling.json');
  await symlink(join(directory, 'absent.json'), dangling);
  await assert.rejects(loadWorkerProfile(dangling), { code: 'ENOENT' });
  const loop = join(directory, 'loop.json');
  await symlink(loop, loop);
  await assert.rejects(loadWorkerProfile(loop), /Too many storage symlinks/);
});

test('malformed, empty, and oversized profiles fail without disclosing their contents', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-invalid-json-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  for (const content of ['', '   ', '{"credential":"do-not-disclose",']) {
    await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(loadWorkerProfile(path), (error: Error) => {
      assert.match(error.message, /Invalid private JSON file/);
      assert.doesNotMatch(error.message, /do-not-disclose/);
      return true;
    });
  }
  await writeFile(
    path,
    `${JSON.stringify(profile(directory))}${' '.repeat(32 * 1024)}`,
    { mode: 0o600 },
  );
  await assert.rejects(loadWorkerProfile(path), /size or type/);
});

test('profiles reject unknown fields, unsupported versions, invalid paths, and implicit grants', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-fields-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const value = profile(directory);
  const cases: [string, unknown][] = [
    ['null', null],
    ['array', []],
    ['unsupported version', { ...value, version: 2 }],
    ['unknown root field', { ...value, credential: 'not-allowed' }],
    [
      'unknown private workspace field',
      { ...value, workspace: { type: 'private', path: '/srv' } },
    ],
    [
      'unknown directory workspace field',
      { ...value, workspace: { type: 'directory', path: '/srv', extra: true } },
    ],
    ['unknown workspace type', { ...value, workspace: { type: 'shared' } }],
    ['missing workspace path', { ...value, workspace: { type: 'directory' } }],
    ['relative identity path', { ...value, identityPath: 'identity.json' }],
    [
      'relative workspace path',
      { ...value, workspace: { type: 'directory', path: './project' } },
    ],
    ['empty identity path', { ...value, identityPath: '' }],
    ['NUL identity path', { ...value, identityPath: '/srv/identity\0.json' }],
    [
      'NUL workspace path',
      { ...value, workspace: { type: 'directory', path: '/srv/project\0' } },
    ],
    [
      'oversized identity path',
      { ...value, identityPath: `/${'x'.repeat(4096)}` },
    ],
    [
      'oversized workspace path',
      {
        ...value,
        workspace: { type: 'directory', path: `/${'é'.repeat(2048)}` },
      },
    ],
    [
      'missing write permission',
      {
        version: 1,
        identityPath: value.identityPath,
        workspace: value.workspace,
        allowWorkspaceCommands: false,
      },
    ],
    ['string write permission', { ...value, allowWorkspaceWrites: 'true' }],
    ['numeric command permission', { ...value, allowWorkspaceCommands: 1 }],
  ];
  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      const serialized = JSON.stringify(invalid);
      await writeFile(path, serialized, { mode: 0o600 });
      await assert.rejects(loadWorkerProfile(path), /worker profile/i);
      await assert.rejects(
        saveWorkerProfile(path, invalid as WorkerProfile),
        /worker profile/i,
      );
      assert.equal(await readFile(path, 'utf8'), serialized);
      assert.throws(
        () => workerProfileArguments(invalid as WorkerProfile),
        /worker profile/i,
      );
    });
  }
  await assert.rejects(
    loadWorkerProfile('relative.json'),
    /paths must be absolute/,
  );
  await assert.rejects(
    saveWorkerProfile('relative.json', value),
    /paths must be absolute/,
  );
});

test('save rejects non-JSON fields and bounds the serialized profile size', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-serialization-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const value = profile(directory);
  await assert.rejects(
    saveWorkerProfile(path, { ...value, ignored: undefined } as WorkerProfile),
    /fields/,
  );
  await assert.rejects(
    saveWorkerProfile(path, { ...value, [Symbol('ignored')]: true }),
    /fields/,
  );
  await assert.rejects(
    saveWorkerProfile(path, { ...value, toJSON: () => value } as WorkerProfile),
    /fields/,
  );
  await assert.rejects(
    saveWorkerProfile(path, {
      ...value,
      identityPath: `/${'"'.repeat(4095)}`,
      workspace: { type: 'directory', path: `/${'"'.repeat(4095)}` },
    }),
    /16 KiB limit/,
  );
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('private profile reads remain bounded if the file grows after its size check', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-growth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  await saveWorkerProfile(path, profile(directory));
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const originalRead = prototype.read;
  let grown = false;
  t.mock.method(
    prototype,
    'read',
    async function (this: FileHandle, ...args: unknown[]) {
      if (!grown) {
        grown = true;
        await writeFile(
          path,
          `${JSON.stringify(profile(directory))}${' '.repeat(32 * 1024)}`,
        );
      }
      return Reflect.apply(originalRead, this, args);
    },
  );
  await assert.rejects(loadWorkerProfile(path), /size or type/);
  assert.equal(grown, true);
});

test('permission errors are not mistaken for an absent profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-permission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  await saveWorkerProfile(path, profile(directory));
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  t.mock.method(prototype, 'read', async () => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  await assert.rejects(loadWorkerProfile(path), { code: 'EACCES' });
});

test('exposed profiles and unsafe storage ancestry are rejected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const value = profile(directory);
  await saveWorkerProfile(path, value);
  await chmod(path, 0o644);
  await assert.rejects(loadWorkerProfile(path), /owner-only.*644/);
  await chmod(path, 0o600);
  await chmod(directory, 0o777);
  await assert.rejects(loadWorkerProfile(path), /writable by other accounts/);
  await assert.rejects(
    loadWorkerProfile(join(directory, 'missing.json')),
    /writable by other accounts/,
  );
  await assert.rejects(
    saveWorkerProfile(path, value),
    /writable by other accounts/,
  );
});

test('worker profile storage fails closed on unsupported platforms', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  Object.defineProperty(process, 'platform', {
    value: 'freebsd',
    configurable: true,
  });
  const value = profile('/srv');
  await assert.rejects(
    loadWorkerProfile('/srv/missing.json'),
    /unavailable on this platform/,
  );
  await assert.rejects(
    saveWorkerProfile('/srv/profile.json', value),
    /unavailable on this platform/,
  );
  await assert.rejects(
    assertWorkerProfileIsolation('/srv/profile.json', value.identityPath),
    /unavailable on this platform/,
  );
});

test('isolation accepts separate reserved files outside the workspace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const identity = join(directory, 'identity.json');
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const reservedProfile = await assertIdentityPathIsPrivate(path, true);
  const reservedIdentity = await assertIdentityPathIsPrivate(identity, true);
  await assertWorkerProfileIsolation(path, identity);
  await assertWorkerProfileIsolation(path, identity, workspace);
  await reservedIdentity.release();
  await reservedProfile.release();
  assert.deepEqual(await readdir(directory), ['workspace']);
});

test('isolation rejects lexical, symlink, and hardlink aliases of the identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = join(directory, 'identity.json');
  await writeFile(identity, '', { mode: 0o600 });
  const symlinkPath = join(directory, 'symlink.json');
  const hardlinkPath = join(directory, 'hardlink.json');
  await symlink(identity, symlinkPath);
  await link(identity, hardlinkPath);
  for (const path of [
    identity,
    `${directory}/./identity.json`,
    symlinkPath,
    hardlinkPath,
  ]) {
    await assert.rejects(
      assertWorkerProfileIsolation(path, identity),
      /separate files, not aliases/,
    );
  }
});

test('isolation rejects either private file inside a read-only workspace', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-containment-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const profilePath = join(directory, 'profile.json');
  const identity = join(directory, 'identity.json');
  const inside = join(workspace, 'storage.json');
  for (const path of [profilePath, identity, inside])
    await writeFile(path, '', { mode: 0o600 });
  await assert.rejects(
    assertWorkerProfileIsolation(inside, identity, workspace),
    /outside the workspace/,
  );
  await assert.rejects(
    assertWorkerProfileIsolation(profilePath, inside, workspace),
    /outside the workspace/,
  );
  const workspaceAlias = join(directory, 'workspace-alias');
  await symlink(workspace, workspaceAlias);
  await assert.rejects(
    assertWorkerProfileIsolation(profilePath, inside, workspaceAlias),
    /outside the workspace/,
  );
});

test('isolation checks every intermediate symlink and traversed storage ancestor', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-link-ancestry-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  const outside = join(directory, 'workspace-private');
  await mkdir(workspace);
  await mkdir(outside);
  const profilePath = join(outside, 'profile.json');
  const identity = join(outside, 'identity.json');
  await writeFile(profilePath, '', { mode: 0o600 });
  await writeFile(identity, '', { mode: 0o600 });
  await assertWorkerProfileIsolation(profilePath, identity, workspace);

  const linkInWorkspace = join(workspace, 'storage');
  const indirect = join(directory, 'indirect');
  await symlink(outside, linkInWorkspace);
  await symlink(linkInWorkspace, indirect);
  const cases = [
    join(linkInWorkspace, 'profile.json'),
    join(indirect, 'profile.json'),
    `${workspace}/../workspace-private/profile.json`,
    `${indirect}/../workspace-private/profile.json`,
  ];
  for (const path of cases) {
    await assert.rejects(
      assertWorkerProfileIsolation(path, identity, workspace),
      /outside the workspace/,
    );
  }
  await assert.rejects(
    assertWorkerProfileIsolation(
      profilePath,
      join(indirect, 'identity.json'),
      workspace,
    ),
    /outside the workspace/,
  );
  const fileLink = join(workspace, 'identity-link.json');
  await symlink(identity, fileLink);
  await assert.rejects(
    assertWorkerProfileIsolation(profilePath, fileLink, workspace),
    /outside the workspace/,
  );
});

test('isolation fails on missing or non-file storage and missing or non-directory workspaces', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-isolation-invalid-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const identity = join(directory, 'identity.json');
  await writeFile(path, '', { mode: 0o600 });
  await writeFile(identity, '', { mode: 0o600 });
  await assert.rejects(
    assertWorkerProfileIsolation(join(directory, 'missing.json'), identity),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    assertWorkerProfileIsolation(directory, identity),
    /regular files/,
  );
  await assert.rejects(
    assertWorkerProfileIsolation(path, identity, join(directory, 'missing')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    assertWorkerProfileIsolation(path, identity, path),
    /must be a directory/,
  );
});

test('create-only reservations never overwrite existing profiles or identities', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-create-only-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const value = profile(directory);
  await saveWorkerProfile(path, value);
  const before = await stat(path, { bigint: true });
  await assert.rejects(
    assertIdentityPathIsPrivate(path, true),
    /already exists; choose a different identity\/profile path/,
  );
  assert.equal((await stat(path, { bigint: true })).ino, before.ino);
  assert.deepEqual(await loadWorkerProfile(path), value);
  const existing = await assertIdentityPathIsPrivate(path);
  await existing.release();
  assert.deepEqual(await loadWorkerProfile(path), value);
});

test('only one concurrent create-only reservation can claim a path', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-reservations-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const results = await Promise.allSettled([
    assertIdentityPathIsPrivate(path, true),
    assertIdentityPathIsPrivate(path, true),
  ]);
  const successes = results.filter(result => result.status === 'fulfilled');
  const failures = results.filter(result => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].reason), /already exists/);
  assert.equal((await stat(path)).size, 0);
  await successes[0].value.release();
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('reservation cleanup preserves a profile published over its placeholder', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'worker-profile-reservation-release-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.json');
  const reservation = await assertIdentityPathIsPrivate(path, true);
  const value = profile(directory);
  await saveWorkerProfile(path, value);
  await reservation.release();
  assert.deepEqual(await loadWorkerProfile(path), value);
});
