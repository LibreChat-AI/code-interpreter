import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';

import {
  createBridgeIdentity,
  signBridgeRequest,
} from '../../../packages/code/src/identity';
import { RedisBridgePairingStore } from './pairing';

const redis = new RedisMock() as unknown as Redis;
const pairings = new RedisBridgePairingStore(redis);

afterEach(async () => {
  await redis.flushall();
});

describe('RedisBridgePairingStore', () => {
  test('preserves a tenant and generic principal binding across credential rotation', async () => {
    const identity = createBridgeIdentity();
    const binding = {
      tenantId: 'tenant-1',
      principal: { type: 'group' as const, id: 'engineering' },
    };
    const pairing = await pairings.issue('vm-bound', binding);
    const issued = await pairings.redeem({
      workerId: 'vm-bound',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const requestFor = (
      credential: string,
      nonce: string,
    ): Parameters<RedisBridgePairingStore['authorize']>[0] => {
      const proof = {
        credential,
        method: 'POST',
        path: '/v1/bridge/workers/vm-bound/lease',
        timestamp: new Date().toISOString(),
        nonce,
        body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
      };
      return {
        ...proof,
        workerId: 'vm-bound',
        signature: signBridgeRequest(identity.privateKey, proof),
      };
    };

    const originalAuthorization = await pairings.authorize(
      requestFor(issued.credential, 'original-bound-worker-proof'),
    );
    const rotated = await pairings.rotate('vm-bound');

    const rotatedAuthorization = await pairings.authorize(
      requestFor(rotated.credential, 'bound-worker-proof'),
    );
    expect(rotatedAuthorization).toMatchObject({ workerId: 'vm-bound', binding });
    expect(typeof originalAuthorization.identityId).toBe('string');
    expect(rotatedAuthorization.identityId).toBe(
      originalAuthorization.identityId,
    );
    await expect(
      pairings.authorize(requestFor(issued.credential, 'superseded-bound-proof')),
    ).resolves.toMatchObject({
      workerId: 'vm-bound',
      identityId: originalAuthorization.identityId,
    });
  });

  test('preserves a legacy unmarked identity across its first rotation', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('legacy-vm');
    const issued = await pairings.redeem({
      workerId: 'legacy-vm',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const issuedDigest = createHash('sha256')
      .update(issued.credential)
      .digest('hex');
    const credentialKey = `codeapi:bridge:v1:credential:${issuedDigest}`;
    const stored = JSON.parse((await redis.get(credentialKey)) ?? '{}') as {
      identityId?: string;
    };
    delete stored.identityId;
    await redis.set(credentialKey, JSON.stringify(stored), 'EX', 300);

    const rotated = await pairings.rotate('legacy-vm');
    const proof = {
      credential: rotated.credential,
      method: 'POST',
      path: '/v1/bridge/workers/legacy-vm/lease',
      timestamp: new Date().toISOString(),
      nonce: 'legacy-rotation-proof',
      body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
    };
    const authorization = await pairings.authorize({
      ...proof,
      workerId: 'legacy-vm',
      signature: signBridgeRequest(identity.privateKey, proof),
    });

    expect(authorization.identityId).toBeUndefined();
  });

  test('redeems a pairing code exactly once for the intended worker identity', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');

    const credential = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });

    expect(credential.workerId).toBe('vm-1');
    expect(credential.credential.length).toBeGreaterThanOrEqual(32);
    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: pairing.code,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
  });

  test('preserves a pairing code after public-key validation fails', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-public-key-retry');

    await expect(
      pairings.redeem({
        workerId: 'vm-public-key-retry',
        code: pairing.code,
        publicKey: 'not-a-public-key',
      }),
    ).rejects.toMatchObject({ code: 'PUBLIC_KEY_INVALID' });

    await expect(
      pairings.redeem({
        workerId: 'vm-public-key-retry',
        code: pairing.code,
        publicKey: identity.publicKey,
      }),
    ).resolves.toMatchObject({ workerId: 'vm-public-key-retry' });
  });

  test('only the newest pairing code can rebind a worker identity', async () => {
    const identity = createBridgeIdentity();
    const older = await pairings.issue('vm-1', {
      tenantId: 'tenant-a',
      principal: { type: 'user', id: 'user-a' },
    });
    const newer = await pairings.issue('vm-1', {
      tenantId: 'tenant-b',
      principal: { type: 'user', id: 'user-b' },
    });

    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: older.code,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: newer.code,
        publicKey: identity.publicKey,
      }),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('does not let a paused redemption overwrite a newer pairing identity', async () => {
    const firstIdentity = createBridgeIdentity();
    const secondIdentity = createBridgeIdentity();
    const firstPairing = await pairings.issue('vm-race', {
      tenantId: 'tenant-a',
      principal: { type: 'user', id: 'user-a' },
    });
    const originalEval = redis.eval.bind(redis);
    let releaseFirst!: () => void;
    let firstRedeemed!: () => void;
    const firstRedeemedPromise = new Promise<void>((resolve) => {
      firstRedeemed = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let paused = false;
    redis.eval = (async (script: string, ...args: unknown[]) => {
      if (!paused && script.includes('if pairing ~= ARGV[1]')) {
        paused = true;
        firstRedeemed();
        await releaseFirstPromise;
      }
      return await (originalEval as (...evalArgs: unknown[]) => Promise<unknown>)(
        script,
        ...args,
      );
    }) as typeof redis.eval;

    try {
      const staleRedemption = pairings.redeem({
        workerId: 'vm-race',
        code: firstPairing.code,
        publicKey: firstIdentity.publicKey,
      });
      await firstRedeemedPromise;
      const secondPairing = await pairings.issue('vm-race', {
        tenantId: 'tenant-b',
        principal: { type: 'user', id: 'user-b' },
      });
      const current = await pairings.redeem({
        workerId: 'vm-race',
        code: secondPairing.code,
        publicKey: secondIdentity.publicKey,
      });
      releaseFirst();

      await expect(staleRedemption).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
      const proof = {
        credential: current.credential,
        method: 'POST',
        path: '/v1/bridge/workers/vm-race/lease',
        timestamp: new Date().toISOString(),
        nonce: 'current-race-proof',
        body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
      };
      await expect(
        pairings.authorize({
          ...proof,
          workerId: 'vm-race',
          signature: signBridgeRequest(secondIdentity.privateKey, proof),
        }),
      ).resolves.toMatchObject({
        binding: {
          tenantId: 'tenant-b',
          principal: { type: 'user', id: 'user-b' },
        },
      });
    } finally {
      redis.eval = originalEval as typeof redis.eval;
      releaseFirst();
    }
  });

  test('authorizes a credential only with proof from its worker key', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const issued = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path: '/v1/bridge/workers/vm-1/lease',
      timestamp: new Date().toISOString(),
      nonce: 'request-nonce-1',
      body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
    };

    await expect(
      pairings.authorize({
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(identity.privateKey, proof),
      }),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('rejects replay of an already accepted worker proof', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const issued = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path: '/v1/bridge/workers/vm-1/lease',
      timestamp: new Date().toISOString(),
      nonce: 'single-use-nonce',
      body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
    };
    const request = {
      ...proof,
      workerId: 'vm-1',
      signature: signBridgeRequest(identity.privateKey, proof),
    };

    await pairings.authorize(request);

    await expect(pairings.authorize(request)).rejects.toMatchObject({
      code: 'PROOF_REPLAYED',
    });
  });

  test('rejects a correctly signed proof outside the clock window', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const issued = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path: '/v1/bridge/workers/vm-1/lease',
      timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      nonce: 'stale-request-nonce',
      body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
    };

    await expect(
      pairings.authorize({
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(identity.privateKey, proof),
      }),
    ).rejects.toMatchObject({ code: 'PROOF_INVALID' });
  });

  test('revocation immediately invalidates the active worker credential', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const issued = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path: '/v1/bridge/workers/register',
      timestamp: new Date().toISOString(),
      nonce: 'post-revocation-request',
      body: JSON.stringify({ protocolVersion: 1, workerId: 'vm-1' }),
    };

    await pairings.revoke('vm-1');

    await expect(
      pairings.authorize({
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(identity.privateKey, proof),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  test('revocation invalidates an unredeemed pairing code', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');

    await pairings.revoke('vm-1');

    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: pairing.code,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
  });

  test('revocation removes pairing codes issued by a pre-fence replica', async () => {
    const legacyCode = 'legacy-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({ workerId: 'vm-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      'EX',
      60,
    );

    await pairings.revoke('vm-1');

    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('retries legacy cleanup after a transient scan failure', async () => {
    const legacyCode = 'retryable-legacy-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-scan-retry',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    const scan = redis.scan.bind(redis);
    let failScan = true;
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      if (failScan) {
        failScan = false;
        throw new Error('transient scan failure');
      }
      return scan(...args);
    }) as Redis['scan'];

    await expect(pairings.revoke('vm-scan-retry')).rejects.toThrow(
      'transient scan failure',
    );
    redis.scan = scan;
    await pairings.revoke('vm-scan-retry');

    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('retries a claimed cleanup after the migration deadline', async () => {
    const legacyCode = 'post-deadline-retry-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-post-deadline-retry',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    await redis.set(
      'codeapi:bridge:v1:migration:legacy-pairing-scan-until',
      String(Date.now() + 15),
    );
    const scan = redis.scan.bind(redis);
    let failScan = true;
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      if (failScan) {
        failScan = false;
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('scan failed after deadline');
      }
      return scan(...args);
    }) as Redis['scan'];

    await expect(pairings.revoke('vm-post-deadline-retry')).rejects.toThrow(
      'scan failed after deadline',
    );
    await pairings.revoke('vm-post-deadline-retry');

    redis.scan = scan;
    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('renews the cleanup claim while a shared-keyspace scan is in flight', async () => {
    const store = new RedisBridgePairingStore(redis, 600, 300, 30);
    const legacyCode = 'renewed-claim-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-renewed-claim',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    const scan = redis.scan.bind(redis);
    let scanCalls = 0;
    let renewCalls = 0;
    let markScanStarted = () => {};
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      scanCalls += 1;
      if (scanCalls === 1) {
        markScanStarted();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return scan(...args);
    }) as Redis['scan'];
    const originalEval = redis.eval.bind(redis);
    redis.eval = (async (script: string, ...args: unknown[]) => {
      if (script.includes("redis.call('PEXPIRE'")) renewCalls += 1;
      return await (originalEval as (...evalArgs: unknown[]) => Promise<unknown>)(
        script,
        ...args,
      );
    }) as typeof redis.eval;

    try {
      const first = store.revoke('vm-renewed-claim');
      await scanStarted;
      await new Promise((resolve) => setTimeout(resolve, 45));
      expect(renewCalls).toBeGreaterThan(0);
      await first;

      expect(scanCalls).toBe(1);
      await expect(redis.get(legacyKey)).resolves.toBeNull();
    } finally {
      redis.scan = scan;
      redis.eval = originalEval as typeof redis.eval;
    }
  });

  test('rescans an ambiguous marker written by the preceding build', async () => {
    const legacyCode = 'ambiguous-predecessor-marker-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    const workerId = 'vm-ambiguous-predecessor-marker';
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    await redis.set(
      `codeapi:bridge:v1:migration:legacy-pairing-scanned:${workerId}`,
      'predecessor-random-token',
      'PX',
      60_000,
    );

    await pairings.revoke(workerId);

    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('starts the advertised pairing lifetime after legacy cleanup', async () => {
    const store = new RedisBridgePairingStore(redis, 60);
    const scan = redis.scan.bind(redis);
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      const result = await scan(...args);
      now += 10;
      return result;
    }) as Redis['scan'];

    try {
      const pairing = await store.issue('vm-post-cleanup-expiry');
      expect(Date.parse(pairing.expiresAt) - Date.now()).toBe(60_000);
    } finally {
      Date.now = originalNow;
      redis.scan = scan;
    }
  });

  test('waits for a failed in-progress cleanup and confirms legacy removal itself', async () => {
    const legacyCode = 'overlapping-legacy-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-overlapping-cleanup',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    const scan = redis.scan.bind(redis);
    let releaseFirstScan = () => {};
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    let markFirstScanStarted = () => {};
    const firstScanStarted = new Promise<void>((resolve) => {
      markFirstScanStarted = resolve;
    });
    let scanCalls = 0;
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      scanCalls += 1;
      if (scanCalls === 1) {
        markFirstScanStarted();
        await firstScanGate;
        throw new Error('interrupted claimed scan');
      }
      return scan(...args);
    }) as Redis['scan'];

    const interrupted = pairings.revoke('vm-overlapping-cleanup');
    await firstScanStarted;
    const overlapping = pairings.revoke('vm-overlapping-cleanup');
    let overlappingSettled = false;
    void overlapping.then(
      () => {
        overlappingSettled = true;
      },
      () => {
        overlappingSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(overlappingSettled).toBe(false);
    releaseFirstScan();

    await expect(interrupted).rejects.toThrow('interrupted claimed scan');
    await expect(overlapping).resolves.toBeUndefined();
    redis.scan = scan;
    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('legacy cleanup does not delete generation-fenced pairings', async () => {
    const fencedCode = 'concurrent-generation-pairing';
    const fencedKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(fencedCode)
      .digest('hex')}`;
    await redis.set(
      fencedKey,
      JSON.stringify({
        workerId: 'vm-generation-fenced',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        generation: 'new-generation',
      }),
      'EX',
      60,
    );

    await pairings.revoke('vm-generation-fenced');

    await expect(redis.get(fencedKey)).resolves.not.toBeNull();
  });

  test('reopens legacy cleanup after a rollback outlives the prior scan window', async () => {
    const legacyCode = 'later-rollback-pairing-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    const deadlineKey = 'codeapi:bridge:v1:migration:legacy-pairing-scan-until';
    await redis.set(deadlineKey, '0');
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-later-rollback',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    await redis.set(
      'codeapi:bridge:v1:pairing-index:vm-later-rollback',
      legacyKey,
      'EX',
      60,
    );
    await redis.set(
      'codeapi:bridge:v1:migration:legacy-pairing-scanned:vm-later-rollback',
      'done',
    );

    await pairings.revoke('vm-later-rollback');

    await expect(redis.get(legacyKey)).resolves.toBeNull();
    await expect(redis.get(deadlineKey)).resolves.toBe('0');
  });

  test('does not restart an expired migration window without rollback evidence', async () => {
    const legacyCode = 'unindexed-post-migration-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    const deadlineKey = 'codeapi:bridge:v1:migration:legacy-pairing-scan-until';
    await redis.set(deadlineKey, '0');
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-no-rollback-signal',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );

    await pairings.revoke('vm-no-rollback-signal');

    await expect(redis.get(legacyKey)).resolves.not.toBeNull();
    await expect(redis.get(deadlineKey)).resolves.toBe('0');
  });

  test('restarts legacy cleanup once for an explicit rollback epoch', async () => {
    const legacyCode = 'unindexed-rollback-epoch-code';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    const deadlineKey = 'codeapi:bridge:v1:migration:legacy-pairing-scan-until';
    await redis.set(deadlineKey, '0');
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-rollback-epoch',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    await redis.set(
      'codeapi:bridge:v1:migration:legacy-pairing-scanned:vm-rollback-epoch',
      'done',
    );
    const rollbackAwarePairings = new RedisBridgePairingStore(
      redis,
      600,
      300,
      5_000,
      'rollback-epoch-1',
    );

    await rollbackAwarePairings.revoke('vm-rollback-epoch');

    await expect(redis.get(legacyKey)).resolves.toBeNull();
    await expect(redis.get(deadlineKey)).resolves.toBe('0');
    const epochHash = createHash('sha256')
      .update('rollback-epoch-1')
      .digest('hex');
    const epochStateKey =
      `codeapi:bridge:v1:migration:legacy-pairing-scanned:` +
      `vm-rollback-epoch:${epochHash}`;
    await expect(redis.get(epochStateKey)).resolves.toBe('done');
    await expect(redis.pttl(epochStateKey)).resolves.toBe(-1);
  });

  test('cleans a revoked legacy code before rollback-epoch redemption', async () => {
    const identity = createBridgeIdentity();
    const workerId = 'vm-rollback-redeem';
    const legacyCode = 'revoked-rollback-pairing';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set('codeapi:bridge:v1:migration:legacy-pairing-scan-until', '0');
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    const rollbackAwarePairings = new RedisBridgePairingStore(
      redis,
      600,
      300,
      5_000,
      'rollback-epoch-redeem',
    );

    await expect(
      rollbackAwarePairings.redeem({
        workerId,
        code: legacyCode,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    await expect(redis.get(legacyKey)).resolves.toBeNull();
  });

  test('does not scan for a nonexistent rollback-epoch pairing code', async () => {
    const identity = createBridgeIdentity();
    const scan = redis.scan.bind(redis);
    let scanCalls = 0;
    redis.scan = (async (...args: Parameters<Redis['scan']>) => {
      scanCalls += 1;
      return scan(...args);
    }) as Redis['scan'];
    const rollbackAwarePairings = new RedisBridgePairingStore(
      redis,
      600,
      300,
      5_000,
      'rollback-epoch-missing-code',
    );

    try {
      await expect(
        rollbackAwarePairings.redeem({
          workerId: 'attacker-chosen-worker',
          code: 'nonexistent-code',
          publicKey: identity.publicKey,
        }),
      ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
      expect(scanCalls).toBe(0);
      await expect(
        redis.keys(
          'codeapi:bridge:v1:migration:legacy-pairing-scanned:attacker-chosen-worker*',
        ),
      ).resolves.toEqual([]);
    } finally {
      redis.scan = scan;
    }
  });

  test('redeems an unrevoked pairing code issued by a pre-fence replica', async () => {
    const identity = createBridgeIdentity();
    const legacyCode = 'unrevoked-legacy-pairing';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({ workerId: 'vm-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      'EX',
      60,
    );

    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: legacyCode,
        publicKey: identity.publicKey,
      }),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('redeems an indexed legacy code issued after rollback', async () => {
    const identity = createBridgeIdentity();
    await pairings.issue('vm-rollback');
    const legacyCode = 'rollback-issued-legacy-pairing';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({
        workerId: 'vm-rollback',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'EX',
      60,
    );
    await redis.set(
      'codeapi:bridge:v1:pairing-index:vm-rollback',
      legacyKey,
      'EX',
      60,
    );

    await expect(
      pairings.redeem({
        workerId: 'vm-rollback',
        code: legacyCode,
        publicKey: identity.publicKey,
      }),
    ).resolves.toMatchObject({ workerId: 'vm-rollback' });
  });

  test('replacement invalidates a pairing code issued by a pre-fence replica', async () => {
    const identity = createBridgeIdentity();
    const legacyCode = 'replaced-legacy-pairing';
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256')
      .update(legacyCode)
      .digest('hex')}`;
    await redis.set(
      legacyKey,
      JSON.stringify({ workerId: 'vm-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      'EX',
      60,
    );

    await pairings.issue('vm-1');

    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: legacyCode,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
  });

  test('issuing a replacement invalidates the prior unredeemed pairing code', async () => {
    const identity = createBridgeIdentity();
    const first = await pairings.issue('vm-1');
    const replacement = await pairings.issue('vm-1');

    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: first.code,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    await expect(
      pairings.redeem({
        workerId: 'vm-1',
        code: replacement.code,
        publicKey: identity.publicKey,
      }),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('rotation retains the prior same-identity credential for recovery', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const original = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });

    const rotated = await pairings.rotate('vm-1');

    const proofFor = (
      credential: string,
      nonce: string,
    ): Parameters<RedisBridgePairingStore['authorize']>[0] => {
      const proof = {
        credential,
        method: 'POST',
        path: '/v1/bridge/workers/vm-1/lease',
        timestamp: new Date().toISOString(),
        nonce,
        body: JSON.stringify({ protocolVersion: 1, waitMs: 25_000 }),
      };
      return {
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(identity.privateKey, proof),
      };
    };

    await expect(
      pairings.authorize(proofFor(original.credential, 'old-credential')),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
    await expect(
      pairings.authorize(proofFor(rotated.credential, 'new-credential')),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('recovers when a refresh response is lost after the server commits it', async () => {
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue('vm-1');
    const original = await pairings.redeem({
      workerId: 'vm-1',
      code: pairing.code,
      publicKey: identity.publicKey,
    });
    const proofFor = (
      credential: string,
      nonce: string,
    ): Parameters<RedisBridgePairingStore['authorize']>[0] => {
      const proof = {
        credential,
        method: 'POST',
        path: '/v1/bridge/workers/vm-1/credentials/refresh',
        timestamp: new Date().toISOString(),
        nonce,
        body: JSON.stringify({ protocolVersion: 1 }),
      };
      return {
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(identity.privateKey, proof),
      };
    };

    await pairings.rotate('vm-1');
    const retryAuthorization = await pairings.authorize(
      proofFor(original.credential, 'refresh-response-lost'),
    );
    const recovered = await pairings.rotate(
      'vm-1',
      retryAuthorization.credentialId,
    );

    await expect(
      pairings.authorize(proofFor(recovered.credential, 'refresh-recovered')),
    ).resolves.toMatchObject({ workerId: 'vm-1' });
  });

  test('rejects a stale credential refresh after the worker is paired again', async () => {
    const originalIdentity = createBridgeIdentity();
    const originalPairing = await pairings.issue('vm-1');
    const original = await pairings.redeem({
      workerId: 'vm-1',
      code: originalPairing.code,
      publicKey: originalIdentity.publicKey,
    });
    const proof = {
      credential: original.credential,
      method: 'POST',
      path: '/v1/bridge/workers/vm-1/credentials/refresh',
      timestamp: new Date().toISOString(),
      nonce: 'authorized-before-repairing',
      body: JSON.stringify({ protocolVersion: 1 }),
    };
    const staleAuthorization = await pairings.authorize({
      ...proof,
      workerId: 'vm-1',
      signature: signBridgeRequest(originalIdentity.privateKey, proof),
    });

    const replacementIdentity = createBridgeIdentity();
    const replacementPairing = await pairings.issue('vm-1');
    await pairings.redeem({
      workerId: 'vm-1',
      code: replacementPairing.code,
      publicKey: replacementIdentity.publicKey,
    });

    await expect(
      pairings.rotate('vm-1', staleAuthorization.credentialId),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  test('repairing a worker invalidates its previously paired credential', async () => {
    const firstIdentity = createBridgeIdentity();
    const firstPairing = await pairings.issue('vm-1');
    const first = await pairings.redeem({
      workerId: 'vm-1',
      code: firstPairing.code,
      publicKey: firstIdentity.publicKey,
    });
    const nextIdentity = createBridgeIdentity();
    const nextPairing = await pairings.issue('vm-1');
    await pairings.redeem({
      workerId: 'vm-1',
      code: nextPairing.code,
      publicKey: nextIdentity.publicKey,
    });
    const proof = {
      credential: first.credential,
      method: 'POST',
      path: '/v1/bridge/workers/register',
      timestamp: new Date().toISOString(),
      nonce: 'superseded-pairing',
      body: JSON.stringify({ protocolVersion: 1, workerId: 'vm-1' }),
    };

    await expect(
      pairings.authorize({
        ...proof,
        workerId: 'vm-1',
        signature: signBridgeRequest(firstIdentity.privateKey, proof),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });
});
