import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { chmod, mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertPrivateStorageAcl, assertPrivateStorageAncestors, removePrivateStorageAcl } from './private-storage.js';
import { assertIdentityPathIsPrivate, saveBridgeIdentity, loadBridgeIdentity,
  saveWorkspaceMutationQuarantine, loadWorkspaceMutationQuarantine,
  clearWorkspaceMutationQuarantine, ensurePrivateWorkspaceDirectory } from './storage.js';
import { GitHubAppCredentialProvider } from './github.js';

const exec = promisify(execFile);
const mac = { skip: process.platform !== 'darwin' };
const identity = { protocolVersion: 1 as const, workerId: 'worker',
  codeApiUrl: 'https://example.com', credential: 'secret', privateKey: 'private',
  publicKey: 'public', expiresAt: '2099-01-01T00:00:00Z' };
const quarantine = { version: 1 as const, workerId: 'worker', workspaceId: 'primary',
  ownerId: 'owner', reason: 'uncertain', quarantinedAt: '2026-01-01T00:00:00Z' };

async function grant(path: string, permissions: string): Promise<void> {
  await exec('/bin/chmod', ['+a', `everyone allow ${permissions}`, path]);
}

// Real kernel ACLs: chmod(0600) alone leaves these grants effective.
test('macOS removes inherited ACLs before publishing identity and quarantine state', mac, async t => {
  const root = await mkdtemp(join(tmpdir(), 'macos-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await grant(root, 'read,readattr,readextattr,readsecurity,file_inherit,directory_inherit');
  let guardedWrites = 0;
  const originalOpen = fs.open;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        await assertPrivateStorageAcl(handle, String(args[0]));
        guardedWrites += 1;
        return write(...values);
      };
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  t.after(() => { fs.open = originalOpen; syncBuiltinESMExports(); });
  const path = join(root, 'identity.json');
  const reservation = await assertIdentityPathIsPrivate(path);
  assert.equal(await readFile(path, 'utf8'), '');
  await saveBridgeIdentity(path, identity);
  await reservation.release();
  assert.deepEqual(await loadBridgeIdentity(path), identity);
  const marker = join(root, 'quarantine.json');
  await saveWorkspaceMutationQuarantine(marker, quarantine);
  assert.deepEqual(await loadWorkspaceMutationQuarantine(marker), quarantine);
  for (const file of [path, marker]) {
    const listing = await exec('/bin/ls', ['-lde', file]);
    assert.doesNotMatch(listing.stdout, /\n\s*0:/);
  }
  // Re-pairing exercises native mount verification and sibling publication.
  await (await assertIdentityPathIsPrivate(path)).release();
  await clearWorkspaceMutationQuarantine(marker, 'owner');
  assert.equal(guardedWrites, 2);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await grant(workspace, 'read,write,delete');
  await ensurePrivateWorkspaceDirectory(workspace);
  assert.doesNotMatch((await exec('/bin/ls', ['-lde', workspace])).stdout, /\n\s*0:/);
});

test('macOS refuses exposed 0600 identities, quarantine markers, and GitHub keys', mac, async t => {
  const root = await mkdtemp(join(tmpdir(), 'macos-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'identity.json');
  const marker = join(root, 'quarantine.json');
  await saveBridgeIdentity(path, identity);
  await saveWorkspaceMutationQuarantine(marker, quarantine);
  for (const file of [path, marker]) {
    await grant(file, 'read');
    await chmod(file, 0o600);
  }
  await assert.rejects(loadBridgeIdentity(path), /macOS ACL grants/);
  await assert.rejects(assertIdentityPathIsPrivate(path), /macOS ACL grants/);
  await assert.rejects(loadWorkspaceMutationQuarantine(marker), /macOS ACL grants/);
  let fetched = false;
  const provider = new GitHubAppCredentialProvider({
    appId: '1', installationId: '1', privateKeyPath: path,
    fetch: async () => { fetched = true; throw new Error('unexpected fetch'); },
  });
  await assert.rejects(provider.getCredential(), /macOS ACL grants/);
  assert.equal(fetched, false);
  assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(identity, null, 2)}\n`);
});

test('macOS rejects ACL-writable ancestors and accepts deny-only home-style ACLs', mac, async t => {
  const root = await mkdtemp(join(tmpdir(), 'macos-acl-'));
  t.after(async () => {
    await exec('/bin/chmod', ['-N', root]);
    await rm(root, { recursive: true, force: true });
  });
  await exec('/bin/chmod', ['+a', 'everyone deny delete', root]);
  await assertPrivateStorageAncestors(root);
  await grant(root, 'add_file,delete_child');
  await chmod(root, 0o700);
  await assert.rejects(assertIdentityPathIsPrivate(join(root, 'identity.json')), /macOS ACL grants/);
});

test('macOS ACL checks and removal operate on the held inode after path replacement', mac, async t => {
  const root = await mkdtemp(join(tmpdir(), 'macos-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file');
  await writeFile(path, '', { mode: 0o600 });
  await grant(path, 'read');
  const handle = await open(path, 'r');
  try {
    await rename(path, join(root, 'old'));
    await writeFile(path, '', { mode: 0o600 });
    await assert.rejects(assertPrivateStorageAcl(handle, path), /macOS ACL grants/);
    await removePrivateStorageAcl(handle, path);
    await assertPrivateStorageAcl(handle, path);
  } finally {
    await handle.close();
  }
  await assert.rejects(assertPrivateStorageAcl(handle, path), /Cannot verify macOS/);
  await assert.rejects(removePrivateStorageAcl(handle, path), /Cannot verify macOS/);
});


test('macOS checks mount status without procfs', mac, async () => {
  const { macOsMountPoint } = await import('./macos-storage.js');
  assert.equal(macOsMountPoint('/'), '/');
  assert.throws(() => macOsMountPoint('/nonexistent-macos-acl-test'), /Cannot verify macOS identity mount/);
});
