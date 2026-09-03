import assert from 'node:assert/strict';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { FileHandle } from 'node:fs/promises';

import {
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
    await writeFile(path, '{bad json', 'utf8');
    await assert.rejects(
      loadWorkspaceMutationQuarantine(path),
      /invalid workspace quarantine file/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
