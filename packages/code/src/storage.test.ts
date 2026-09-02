import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultBridgeIdentityPath,
  defaultWorkspacePath,
  ensurePrivateWorkspaceDirectory,
  loadBridgeIdentity,
  saveBridgeIdentity,
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
