import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { identityIsMountPoint } from './identity-mount.js';
import { assertIdentityPathIsPrivate, saveBridgeIdentity } from './storage.js';

const rootMount = '1 0 8:1 / / rw - ext4 /dev/root rw\n';
const encode = (path: string) => path.replace(/[\\ \t\n]/g, (char) =>
  `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`,
);
const mount = (path: string) => `${rootMount}2 1 8:1 /source ${encode(path)} rw shared:1 - ext4 /dev/root rw\n`;
const identity = {
  protocolVersion: 1 as const, workerId: 'worker', codeApiUrl: 'https://code.example/v1',
  credential: 'secret', expiresAt: '2099-01-01T00:00:00Z', publicKey: 'public', privateKey: 'private',
};

test('mount parsing detects same-device bind mounts and escaped path names', () => {
  for (const path of ['/home/worker/key.json', '/home/worker/key with\tline\nbreak\\040']) {
    assert.equal(identityIsMountPoint(mount(path), path), true);
    assert.equal(identityIsMountPoint(mount(path), `${path}.sibling`), false);
  }
  assert.equal(identityIsMountPoint(mount('/home/worker'), '/home/worker/key.json'), false);
  for (const invalid of ['', 'malformed\n', '1 0 8:1 / /bad\\999 rw - ext4 /dev/root rw\n']) {
    assert.throws(() => identityIsMountPoint(invalid, '/key'), /malformed/);
  }
});

test('preflight and direct saves refuse mounted destinations without altering them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-mount-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'identity.json');
  const fixture = join(root, 'mountinfo');
  await writeFile(path, 'existing credential', { mode: 0o600 });
  await writeFile(fixture, mount(await realpath(path)));
  const original = fs.open;
  fs.open = ((path, ...args) => original(path === '/proc/self/mountinfo' ? fixture : path, ...args)) as typeof fs.open;
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(assertIdentityPathIsPrivate(path), /is a mount point/);
  await assert.rejects(saveBridgeIdentity(path, identity), /is a mount point/);
  assert.equal(await readFile(path, 'utf8'), 'existing credential');
  assert.deepEqual((await readdir(root)).sort(), ['identity.json', 'mountinfo']);

  // Parent aliases still name the mounted entry; a leaf link can be replaced.
  const parentAlias = join(root, 'alias');
  await symlink(root, parentAlias);
  await assert.rejects(assertIdentityPathIsPrivate(join(parentAlias, 'identity.json')), /is a mount point/);
  const leaf = join(root, 'leaf.json');
  await symlink(path, leaf);
  await assertIdentityPathIsPrivate(leaf);
  await saveBridgeIdentity(leaf, identity);
  assert.deepEqual(JSON.parse(await readFile(leaf, 'utf8')), identity);
  assert.equal(await readFile(path, 'utf8'), 'existing credential');
});

test('unavailable, malformed, and oversized mount tables fail before reserving a new identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-mount-info-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'mountinfo');
  const path = join(root, 'identity.json');
  const original = fs.open;
  fs.open = ((path, ...args) => original(path === '/proc/self/mountinfo' ? fixture : path, ...args)) as typeof fs.open;
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(assertIdentityPathIsPrivate(path), /Cannot verify identity mount status/);
  for (const content of ['bad', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(fixture, content);
    await assert.rejects(assertIdentityPathIsPrivate(path), /Cannot verify identity mount status/);
  }
  assert.deepEqual(await readdir(root), ['mountinfo']);
});

test('CLI refuses a mounted identity before redeeming the one-time pairing code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-mount-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'identity.json');
  const fixture = join(root, 'mountinfo');
  const preload = join(root, 'preload.mjs');
  await writeFile(path, 'existing credential', { mode: 0o600 });
  await writeFile(fixture, mount(await realpath(path)));
  await writeFile(preload, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
const original = fs.open;
fs.open = (path, ...args) => original(path === '/proc/self/mountinfo' ? ${JSON.stringify(fixture)} : path, ...args);
syncBuiltinESMExports();
globalThis.fetch = async () => { process.stderr.write('PAIRING_REQUEST_ATTEMPTED'); throw new Error('unexpected request'); };
`);
  const result = spawnSync(process.execPath, [
    '--import', preload, new URL('./cli.js', import.meta.url).pathname,
    'pair', 'https://code.example/v1', 'one-time-code', '--worker-id', 'worker', '--identity', path,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /is a mount point/);
  assert.doesNotMatch(result.stderr, /PAIRING_REQUEST_ATTEMPTED/);
  assert.equal(await readFile(path, 'utf8'), 'existing credential');
});
