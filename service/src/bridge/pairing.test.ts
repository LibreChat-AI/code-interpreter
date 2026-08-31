import { afterEach, describe, expect, test } from 'bun:test';
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
