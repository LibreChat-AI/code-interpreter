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
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
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
      const result = await (originalEval as (...evalArgs: unknown[]) => Promise<unknown>)(
        script,
        ...args,
      );
      if (!paused && script.includes('return pairing')) {
        paused = true;
        firstRedeemed();
        await releaseFirstPromise;
      }
      return result;
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

  test('rotation keeps the prior same-identity credential usable for recovery', async () => {
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
