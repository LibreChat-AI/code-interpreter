import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { FileHandle } from 'node:fs/promises';

import {
  assertIdentityPathIsPrivate,
  clearWorkspaceMutationQuarantine,
  defaultBridgeIdentityPath,
  defaultWorkspaceQuarantinePath,
  defaultWorkspacePath,
  ensurePrivateWorkspaceDirectory,
  loadBridgeIdentity,
  loadWorkspaceMutationQuarantine,
  saveBridgeIdentity,
  saveWorkspaceMutationQuarantine,
} from './storage.js';

test('default identity paths do not collide after worker ID sanitization', () => {
  assert.notEqual(
    defaultBridgeIdentityPath('vm:a'),
    defaultBridgeIdentityPath('vm_a'),
  );
});

test('default workspace paths are stable and collision resistant', () => {
  const home = '/home/tester';
  const options = {
    codeApiUrl: 'https://code.example/v1',
    securityIdentity: 'bridge-public-key',
    workerId: 'vm-1',
    workspaceId: 'primary',
    homeDirectory: home,
  };
  assert.equal(
    defaultWorkspacePath(options),
    defaultWorkspacePath({ ...options, codeApiUrl: 'https://code.example/v1/' }),
  );
  assert.notEqual(
    defaultWorkspacePath({ ...options, workerId: 'vm:a' }),
    defaultWorkspacePath({ ...options, workerId: 'vm_a' }),
  );
  assert.notEqual(
    defaultWorkspacePath({ ...options, workerId: 'vm:a' }),
    defaultWorkspacePath({
      ...options,
      workerId: 'vm_a-2d4fcea9e21e004d',
    }),
  );
  assert.notEqual(
    defaultWorkspacePath({ ...options, workerId: 'VM-1' }).toLowerCase(),
    defaultWorkspacePath({ ...options, workerId: 'vm-1' }).toLowerCase(),
  );
  assert.notEqual(
    defaultWorkspacePath(options),
    defaultWorkspacePath({
      ...options,
      securityIdentity: 'new-pairing-public-key',
    }),
  );
  assert.notEqual(
    defaultWorkspacePath(options),
    defaultWorkspacePath({
      ...options,
      codeApiUrl: 'https://other-code.example/v1',
    }),
  );
});

test('default mutation quarantine paths are stable and worker scoped', () => {
  const options = {
    codeApiUrl: 'https://code.example/v1',
    workerId: 'vm-1',
    workspaceRoot: '/srv/workspaces/project',
    homeDirectory: '/home/tester',
  };
  assert.equal(
    defaultWorkspaceQuarantinePath(options),
    defaultWorkspaceQuarantinePath({
      ...options,
      codeApiUrl: 'https://code.example/v1/',
    }),
  );
  assert.equal(
    defaultWorkspaceQuarantinePath(options),
    defaultWorkspaceQuarantinePath({
      ...options,
      codeApiUrl: 'https://CODE.EXAMPLE:443/v1',
    }),
  );
  assert.notEqual(
    defaultWorkspaceQuarantinePath(options),
    defaultWorkspaceQuarantinePath({
      ...options,
      workspaceRoot: '/srv/workspaces/secondary',
    }),
  );
  assert.notEqual(
    defaultWorkspaceQuarantinePath(options),
    defaultWorkspaceQuarantinePath({ ...options, workerId: 'vm-2' }),
  );
});

test('default workspace directories are created with owner-only permissions', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'librechat-code-workspace-home-'),
  );
  const path = join(directory, 'workspaces', 'primary');
  try {
    await ensurePrivateWorkspaceDirectory(path);
    const metadata = await stat(path);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('paired identity is persisted atomically with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-'));
  const path = join(directory, 'identity.json');
  const identity = {
    protocolVersion: 1 as const,
    workerId: 'vm-1',
    codeApiUrl: 'https://code.example/v1',
    credential: 'issued-short-lived-credential-value',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    publicKey: 'public-key',
    privateKey: 'private-key',
  };

  try {
    await saveBridgeIdentity(path, identity);

    assert.deepEqual(await loadBridgeIdentity(path), identity);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace mutation quarantine persists until explicitly cleared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-quarantine-'));
  const path = join(directory, 'state', 'quarantine.json');
  const record = {
    version: 1 as const,
    workerId: 'vm-1',
    workspaceId: 'primary',
    quarantinedAt: new Date().toISOString(),
    reason: 'ambiguous settlement delivery',
  };
  try {
    const probe = await open(directory, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    await probe.close();
    const originalSync = fileHandlePrototype.sync;
    let syncCalls = 0;
    t.mock.method(fileHandlePrototype, 'sync', async function (this: FileHandle) {
      await originalSync.call(this);
      syncCalls += 1;
    });
    await saveWorkspaceMutationQuarantine(path, record);
    assert.deepEqual(await loadWorkspaceMutationQuarantine(path), record);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(syncCalls, process.platform === 'win32' ? 1 : 3);
    await clearWorkspaceMutationQuarantine(path);
    assert.equal(syncCalls, process.platform === 'win32' ? 1 : 4);
    assert.equal(await loadWorkspaceMutationQuarantine(path), undefined);
    /* Owner-only, so this exercises the parse failure and not the mode check. */
    await writeFile(path, '{bad json', { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(
      loadWorkspaceMutationQuarantine(path),
      /invalid workspace quarantine file/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace mutation quarantine cannot be replaced or cleared by another owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-quarantine-'));
  const path = join(directory, 'quarantine.json');
  const first = {
    version: 1 as const,
    workerId: 'vm-1',
    workspaceId: 'primary',
    ownerId: 'incarnation-1',
    quarantinedAt: new Date().toISOString(),
    reason: 'mutation pending settlement',
  };
  try {
    await saveWorkspaceMutationQuarantine(path, first);
    await assert.rejects(
      saveWorkspaceMutationQuarantine(path, {
        ...first,
        ownerId: 'incarnation-2',
      }),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'EEXIST',
    );
    assert.deepEqual(await loadWorkspaceMutationQuarantine(path), first);
    await assert.rejects(
      clearWorkspaceMutationQuarantine(path, 'incarnation-2'),
      /owned by another worker incarnation/i,
    );
    assert.deepEqual(await loadWorkspaceMutationQuarantine(path), first);
    await clearWorkspaceMutationQuarantine(path, 'incarnation-1');
    assert.equal(await loadWorkspaceMutationQuarantine(path), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Locate a mount that ignores POSIX permissions (WSL2 DrvFs under `/mnt/<drive>`).
 * Returns undefined on hosts where every writable filesystem honours chmod.
 */
async function findChmodIgnoringDirectory(): Promise<string | undefined> {
  const roots: string[] = [];
  const configured = process.env.LIBRECHAT_CODE_TEST_NONPOSIX_DIR?.trim();
  if (configured) roots.push(configured);
  try {
    for (const entry of await readdir('/mnt')) roots.push(join('/mnt', entry));
  } catch {
    /* No /mnt on this host. */
  }
  for (const root of roots) {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(root, 'librechat-code-mode-'));
      const probe = join(directory, 'probe');
      await writeFile(probe, '', { mode: 0o600 });
      await chmod(probe, 0o600);
      if (((await stat(probe)).mode & 0o077) !== 0) return directory;
    } catch {
      /* Root is absent or not writable. */
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return undefined;
}

test('credential storage fails closed on filesystems that ignore chmod', async (t) => {
  const directory = await findChmodIgnoringDirectory();
  if (!directory) {
    t.skip('no chmod-ignoring filesystem available on this host');
    return;
  }
  try {
    const identityPath = join(directory, 'worker.json');
    await assert.rejects(
      saveBridgeIdentity(identityPath, {
        protocolVersion: 1,
        workerId: 'vm-1',
        codeApiUrl: 'https://code.example/v1',
        credential: 'credential',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        publicKey: 'public',
        privateKey: 'private',
      }),
      /owner-only access/,
    );
    /* The private key must not be left behind on a world-readable path. */
    await assert.rejects(stat(identityPath), { code: 'ENOENT' });

    await assert.rejects(
      ensurePrivateWorkspaceDirectory(join(directory, 'workspace')),
      /owner-only access/,
    );

    const quarantinePath = join(directory, 'quarantine.json');
    await assert.rejects(
      saveWorkspaceMutationQuarantine(quarantinePath, {
        version: 1,
        workerId: 'vm-1',
        workspaceId: 'primary',
        quarantinedAt: new Date().toISOString(),
        reason: 'test',
      }),
      /owner-only access/,
    );
    /* An unreadable half-written marker would wedge every later load. */
    await assert.rejects(stat(quarantinePath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an already-exposed identity is refused on load', async (t) => {
  const directory = await findChmodIgnoringDirectory();
  if (!directory) {
    t.skip('no chmod-ignoring filesystem available on this host');
    return;
  }
  try {
    /* Write it the way a release without the save-time check would have. */
    const path = join(directory, 'legacy-worker.json');
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        workerId: 'vm-1',
        codeApiUrl: 'https://code.example/v1',
        credential: 'credential',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        publicKey: 'public',
        privateKey: 'private',
      }),
      { mode: 0o600 },
    );
    await assert.rejects(loadBridgeIdentity(path), /accessible beyond its owner/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the identity destination is rejected before a pairing code is spent', async (t) => {
  const directory = await findChmodIgnoringDirectory();
  if (!directory) {
    t.skip('no chmod-ignoring filesystem available on this host');
    return;
  }
  try {
    const identityPath = join(directory, 'worker.json');
    await assert.rejects(
      assertIdentityPathIsPrivate(identityPath),
      /owner-only access/,
    );
    /* The probe must not survive the rejection. */
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.probe')),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a symlinked owner-only identity is accepted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const target = join(base, 'real.json');
    await saveBridgeIdentity(target, identity);
    /* A link's own mode is always 0777; the credential's mode is the target's. */
    const link = join(base, 'link.json');
    await symlink(target, link);
    assert.deepEqual(await loadBridgeIdentity(link), identity);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an already-exposed quarantine marker is refused on load', async (t) => {
  const directory = await findChmodIgnoringDirectory();
  if (!directory) {
    t.skip('no chmod-ignoring filesystem available on this host');
    return;
  }
  try {
    /* Write it the way a release without the save-time check would have. */
    const path = join(directory, 'quarantine.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        workerId: 'vm-1',
        workspaceId: 'primary',
        ownerId: 'incarnation-1',
        quarantinedAt: new Date().toISOString(),
        reason: 'test',
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadWorkspaceMutationQuarantine(path),
      /accessible beyond its owner/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a directory at the identity path is rejected before the code is spent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identityPath = join(base, 'worker.json');
    await mkdir(identityPath);
    await assert.rejects(
      assertIdentityPathIsPrivate(identityPath),
      /is a directory/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('re-pairing over an existing owner-only identity is still allowed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const identityPath = join(base, 'worker.json');
    await saveBridgeIdentity(identityPath, identity);
    await assertIdentityPathIsPrivate(identityPath);
    const replacement = { ...identity, credential: 'rotated' };
    await saveBridgeIdentity(identityPath, replacement);
    assert.deepEqual(await loadBridgeIdentity(identityPath), replacement);
    /* No probe may survive a successful preflight either. */
    assert.deepEqual(
      (await readdir(base)).filter((name) => name.includes('.probe')),
      [],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an owned identity file in a sticky directory is still replaceable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    /* Ownership only blocks rename under the sticky bit, and only for a file
     * this account does not own - which /tmp-style directories make common. */
    const sticky = join(base, 'sticky');
    await mkdir(sticky);
    await chmod(sticky, 0o1777);
    const identityPath = join(sticky, 'worker.json');
    await writeFile(identityPath, '{}', { mode: 0o600 });
    await assertIdentityPathIsPrivate(identityPath);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a credential in a shared writable directory is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const shared = join(base, 'shared');
    await mkdir(shared);
    const identityPath = join(shared, 'worker.json');
    await saveBridgeIdentity(identityPath, identity);
    /* 0600 still, but anyone may now unlink and substitute it. */
    await chmod(shared, 0o777);
    await assert.rejects(
      loadBridgeIdentity(identityPath),
      /writable by other accounts/,
    );
    await assert.rejects(
      assertIdentityPathIsPrivate(identityPath),
      /writable by other accounts/,
    );

    /* The sticky bit restores owner-only unlink, so /tmp-style parents work. */
    await chmod(shared, 0o1777);
    assert.deepEqual(await loadBridgeIdentity(identityPath), identity);
    await assertIdentityPathIsPrivate(identityPath);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a symlink entry in a shared writable directory is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    /* Credential is private; the link naming it is not, so the link can be
     * repointed at an attacker's file. */
    const priv = join(base, 'private');
    await mkdir(priv, { mode: 0o700 });
    const target = join(priv, 'worker.json');
    await saveBridgeIdentity(target, identity);
    const shared = join(base, 'shared');
    await mkdir(shared);
    const link = join(shared, 'worker.json');
    await symlink(target, link);
    assert.deepEqual(await loadBridgeIdentity(link), identity);
    await chmod(shared, 0o777);
    await assert.rejects(
      loadBridgeIdentity(link),
      /writable by other accounts/,
    );
    /* Pairing publishes by replacing the link entry, so the same directory
     * governs the write path too. */
    await assert.rejects(
      assertIdentityPathIsPrivate(link),
      /writable by other accounts/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a symlink into a shared writable directory is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const shared = join(base, 'shared');
    await mkdir(shared);
    const target = join(shared, 'worker.json');
    await saveBridgeIdentity(target, identity);
    /* The link sits in a private directory; the credential does not. */
    const priv = join(base, 'private');
    await mkdir(priv, { mode: 0o700 });
    const link = join(priv, 'worker.json');
    await symlink(target, link);
    assert.deepEqual(await loadBridgeIdentity(link), identity);
    await chmod(shared, 0o777);
    await assert.rejects(
      loadBridgeIdentity(link),
      /writable by other accounts/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the identity destination is reserved across pairing and released on failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identityPath = join(base, 'worker.json');
    const reservation = await assertIdentityPathIsPrivate(identityPath);
    /* The name is claimed while the pairing request is in flight, so another
     * account cannot take it and strand a spent code. */
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
    await reservation.release();
    await assert.rejects(stat(identityPath), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('releasing never removes a pre-existing identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const identityPath = join(base, 'worker.json');
    await saveBridgeIdentity(identityPath, identity);
    const reservation = await assertIdentityPathIsPrivate(identityPath);
    await reservation.release();
    assert.deepEqual(await loadBridgeIdentity(identityPath), identity);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('releasing never removes an identity another pairing published', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    const identityPath = join(base, 'worker.json');
    const first = await assertIdentityPathIsPrivate(identityPath);
    /* A concurrent pair publishes over the reserved name and completes. */
    await saveBridgeIdentity(identityPath, identity);
    /* The first invocation then fails and unwinds; its credential is gone, but
     * the one that succeeded must survive. */
    await first.release();
    assert.deepEqual(await loadBridgeIdentity(identityPath), identity);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an identity in a directory that denies creation is rejected before pairing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  const locked = join(base, 'locked');
  try {
    const identity = {
      protocolVersion: 1 as const,
      workerId: 'vm-1',
      codeApiUrl: 'https://code.example/v1',
      credential: 'credential',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: 'public',
      privateKey: 'private',
    };
    await mkdir(locked, { mode: 0o700 });
    const identityPath = join(locked, 'worker.json');
    await saveBridgeIdentity(identityPath, identity);
    /* Readable and owner-only, but the publish writes a sibling first. */
    await chmod(locked, 0o500);
    await assert.rejects(
      assertIdentityPathIsPrivate(identityPath),
      /could not be published there/,
    );
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('default workspace directories are tightened when they already exist', async () => {
  const base = await mkdtemp(join(tmpdir(), 'librechat-code-storage-'));
  try {
    const workspace = join(base, 'workspace');
    await mkdir(workspace, { mode: 0o777 });
    await chmod(workspace, 0o777);
    await ensurePrivateWorkspaceDirectory(workspace);
    assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
