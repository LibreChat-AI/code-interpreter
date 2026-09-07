import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitHubAppCredentialProvider } from './github.js';
import { assertPrivateStorageAncestors } from './private-storage.js';
import {
  assertIdentityPathIsPrivate, clearWorkspaceMutationQuarantine,
  ensurePrivateWorkspaceDirectory, loadBridgeIdentity, loadWorkspaceMutationQuarantine,
  saveBridgeIdentity, saveWorkspaceMutationQuarantine,
} from './storage.js';

const identity = {
  protocolVersion: 1 as const, workerId: 'worker', codeApiUrl: 'https://code.example/v1',
  credential: 'secret', expiresAt: '2099-01-01T00:00:00Z', publicKey: 'public', privateKey: 'private',
};
const marker = {
  version: 1 as const, workerId: 'worker', workspaceId: 'workspace', ownerId: 'owner',
  quarantinedAt: '2026-01-01T00:00:00Z', reason: 'uncertain result',
};

test('a writable ancestor blocks every storage operation before changing private descendants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-ancestors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'shared');
  const privateDir = join(parent, 'private');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const credential = join(privateDir, 'identity.json');
  const quarantine = join(privateDir, 'quarantine.json');
  await saveBridgeIdentity(credential, identity);
  await saveWorkspaceMutationQuarantine(quarantine, marker);
  const reservation = await assertIdentityPathIsPrivate(join(privateDir, 'reserved.json'));
  await chmod(parent, 0o777);
  for (const operation of [
    () => loadBridgeIdentity(credential),
    () => saveBridgeIdentity(credential, identity),
    () => assertIdentityPathIsPrivate(credential),
    () => assertIdentityPathIsPrivate(join(privateDir, 'missing', 'identity.json')),
    () => loadWorkspaceMutationQuarantine(quarantine),
    () => loadWorkspaceMutationQuarantine(join(privateDir, 'absent.json')),
    () => saveWorkspaceMutationQuarantine(join(privateDir, 'new.json'), marker),
    () => clearWorkspaceMutationQuarantine(quarantine),
    () => clearWorkspaceMutationQuarantine(quarantine, 'owner'),
    () => ensurePrivateWorkspaceDirectory(join(privateDir, 'workspace')),
    () => reservation.release(),
  ]) await assert.rejects(operation(), /writable by other accounts/);
  assert.deepEqual((await readdir(privateDir)).sort(), ['identity.json', 'quarantine.json', 'reserved.json']);
  assert.deepEqual(JSON.parse(await readFile(credential, 'utf8')), identity);
  assert.deepEqual(JSON.parse(await readFile(quarantine, 'utf8')), marker);

  // A trusted sticky parent protects this account's private directory entry.
  await chmod(parent, 0o1777);
  assert.deepEqual(await loadBridgeIdentity(credential), identity);
  await clearWorkspaceMutationQuarantine(quarantine, 'owner');
  await reservation.release();
});

test('intermediate symlinks cannot hide replaceable entry or target ancestors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, 'shared');
  const privateDir = join(shared, 'private');
  const safe = join(root, 'safe');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await mkdir(safe, { mode: 0o700 });
  const file = join(safe, 'identity.json');
  await saveBridgeIdentity(file, identity);
  await symlink(safe, join(privateDir, 'alias'));
  await symlink(join(privateDir, 'alias'), join(root, 'indirect'));
  await symlink(privateDir, join(root, 'target'));
  await chmod(shared, 0o777);
  for (const path of [
    join(privateDir, 'alias', 'identity.json'),
    join(root, 'indirect', 'identity.json'),
    join(root, 'target', 'missing.json'),
    // Do not lexically normalize away a component the kernel traverses.
    `${root}/indirect/../safe/identity.json`,
  ]) await assert.rejects(assertIdentityPathIsPrivate(path), /writable by other accounts/);
  await assert.rejects(loadBridgeIdentity(join(root, 'indirect', 'identity.json')), /writable by other accounts/);
});

test('a symlink owned by another account is rejected even under a trusted sticky parent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-link-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'alias');
  await symlink(root, link);
  // Use a metadata fixture: changing real ownership requires administrator access.
  const fs = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.default.lstat;
  t.after(() => { fs.default.lstat = original; syncBuiltinESMExports(); });
  fs.default.lstat = (async (...args: Parameters<typeof original>) => {
    const metadata = await original(...args);
    if (String(args[0]).endsWith('/alias')) Object.defineProperty(metadata, 'uid', { value: process.getuid!() + 1000 });
    return metadata;
  }) as typeof original;
  syncBuiltinESMExports();
  await chmod(root, 0o1777);
  await assert.rejects(assertPrivateStorageAncestors(link), /owned by another account/);
});

test('GitHub App keys reject writable ancestors before making a token request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-ancestors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateDir = join(root, 'private');
  await mkdir(privateDir, { mode: 0o700 });
  const path = join(privateDir, 'app.pem');
  await writeFile(path, 'never read', { mode: 0o600 });
  await chmod(root, 0o777);
  let requested = false;
  const provider = new GitHubAppCredentialProvider({
    appId: '1', installationId: '2', privateKeyPath: path,
    fetch: async () => { requested = true; throw new Error('unexpected request'); },
  });
  await assert.rejects(provider.getCredential(), /writable by other accounts/);
  assert.equal(requested, false);
});
