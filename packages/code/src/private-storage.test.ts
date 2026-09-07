import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrivateStorageSupported } from './private-storage.js';
import { assertIdentityPathIsPrivate, saveBridgeIdentity, loadBridgeIdentity,
  saveWorkspaceMutationQuarantine, loadWorkspaceMutationQuarantine,
  clearWorkspaceMutationQuarantine, ensurePrivateWorkspaceDirectory } from './storage.js';
import { GitHubAppCredentialProvider } from './github.js';

const identity = { protocolVersion: 1 as const, workerId: 'worker',
  codeApiUrl: 'https://example.com', credential: 'private', privateKey: 'private',
  publicKey: 'public', expiresAt: '2099-01-01T00:00:00Z' };
const quarantine = { version: 1 as const, workerId: 'worker', workspaceId: 'primary',
  reason: 'uncertain mutation', quarantinedAt: '2026-01-01T00:00:00Z' };

for (const unsupported of ['win32', 'darwin', 'freebsd']) {
  test(`${unsupported} refuses storage before creation, reads, or deletion`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'private-storage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const existing = join(root, 'existing.json');
    await writeFile(existing, JSON.stringify(identity), { mode: 0o600 });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    t.after(() => Object.defineProperty(process, 'platform', platform));
    Object.defineProperty(process, 'platform', { ...platform, value: unsupported });
    const path = join(root, 'missing', 'identity.json');
    for (const action of [
      () => assertIdentityPathIsPrivate(path), () => saveBridgeIdentity(path, identity),
      () => loadBridgeIdentity(existing), () => saveWorkspaceMutationQuarantine(path, quarantine),
      () => loadWorkspaceMutationQuarantine(path), () => clearWorkspaceMutationQuarantine(existing),
      () => ensurePrivateWorkspaceDirectory(join(root, 'workspace')),
    ]) await assert.rejects(action(), /ACL verification is unavailable/);
    assert.deepEqual(await readdir(root), ['existing.json']);
    assert.equal(await readFile(existing, 'utf8'), JSON.stringify(identity));
  });
}

test('GitHub App credentials also reject unsupported ACL verification before signing or fetching', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  let fetched = false;
  const provider = new GitHubAppCredentialProvider({
    appId: '1', installationId: '1', privateKeyPath: '/must-not-be-read',
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  await assert.rejects(provider.getCredential(), /ACL verification is unavailable/);
  assert.equal(fetched, false);
});

test('Linux still requires an available ownership API', t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    else delete process.getuid;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  assert.throws(assertPrivateStorageSupported, /ACL verification is unavailable/);
});
