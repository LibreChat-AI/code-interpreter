import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadBridgeIdentity, saveBridgeIdentity } from './storage.js';

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
