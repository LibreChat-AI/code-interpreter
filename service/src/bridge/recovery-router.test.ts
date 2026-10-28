import { randomBytes } from 'crypto';
import { createServer, type Server } from 'http';

import { afterEach, describe, expect, test } from 'bun:test';
import express, { json } from 'express';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';
import type { BridgeRecoveryChallengeRequest, BridgeRecoveryChallengeResponse } from '../../../packages/code/src/protocol';

import {
  createBridgeIdentity,
  signBridgeRecovery,
  signBridgeRecoveryStart,
} from '../../../packages/code/src/identity';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgePairingStore } from './pairing';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const workerId = 'http-recovery-worker';
const serverId = 'https://code.example.test';
const servers: Server[] = [];

function signedStart(privateKey: string): BridgeRecoveryChallengeRequest {
  const request = {
    operation: 'credential.challenge' as const,
    serverId,
    workerId,
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
  };
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ...request,
    signature: signBridgeRecoveryStart(privateKey, request),
  };
}

async function startRouter(pairings: RedisBridgePairingStore): Promise<string> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(json());
  app.use('/v1/bridge', createBridgeRouter({
    store: new RedisBridgeStore(redis),
    pairings,
    authMode: 'paired',
    adminToken: 'operator-only',
    configuredWorkerId: workerId,
  }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}/v1/bridge/workers/${workerId}/credentials`;
}

function post(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  await redis.flushall();
});

describe('machine credential recovery HTTP API', () => {
  test('does not expose recovery until the server identity is enabled', async () => {
    const baseUrl = await startRouter(new RedisBridgePairingStore(redis));
    const response = await post(`${baseUrl}/challenge`, { protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(response.status).toBe(404);
  });

  test('recovers using the stored key without administrator authentication and never leaks the binding', async () => {
    const pairings = new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
      serverId,
    });
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue(workerId, {
      tenantId: 'tenant-one', principal: { type: 'user', id: 'owner-one' },
    });
    await pairings.redeem({ workerId, code: pairing.code, publicKey: identity.publicKey });
    const baseUrl = await startRouter(pairings);
    const unsigned = await post(`${baseUrl}/challenge`, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(unsigned.status).toBe(400);
    const outsider = createBridgeIdentity();
    const forged = await post(`${baseUrl}/challenge`, signedStart(outsider.privateKey));
    expect(forged.status).toBe(401);
    await expect(forged.json()).resolves.toMatchObject({ code: 'PROOF_INVALID' });

    const challengeResponse = await post(`${baseUrl}/challenge`, signedStart(identity.privateKey));
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as BridgeRecoveryChallengeResponse;
    expect(challenge).toMatchObject({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      serverId,
      workerId,
      operation: 'credential.recover',
    });
    expect(JSON.stringify(challenge)).not.toMatch(/tenant-one|owner-one|privateKey/);

    const signature = signBridgeRecovery(identity.privateKey, challenge);
    const rejected = await post(`${baseUrl}/recover`, {
      ...challenge,
      serverId: 'https://unrelated.example.test',
      signature,
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({ code: 'CHALLENGE_INVALID' });

    const recovered = await post(`${baseUrl}/recover`, { ...challenge, signature });
    expect(recovered.status).toBe(200);
    const credential = (await recovered.json()) as { workerId: string; credential: string };
    expect(credential.workerId).toBe(workerId);
    expect(credential.credential.length).toBeGreaterThanOrEqual(32);
    const replay = await post(`${baseUrl}/recover`, { ...challenge, signature });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });

  test('limits forged starts before signature work across replicas despite spoofed proxy headers', async () => {
    const first = new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
      serverId, maxUntrustedRequestsPerMinute: 2,
    });
    const second = new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
      serverId, maxUntrustedRequestsPerMinute: 2,
    });
    const identity = createBridgeIdentity();
    const attacker = createBridgeIdentity();
    const pairing = await first.issue(workerId);
    await first.redeem({ workerId, code: pairing.code, publicKey: identity.publicKey });
    const firstUrl = await startRouter(first);
    const secondUrl = await startRouter(second);
    let signatureChecks = 0;
    for (const store of [first, second]) {
      const original = store.createRecoveryChallenge.bind(store);
      store.createRecoveryChallenge = async (
        ...args
      ): ReturnType<RedisBridgePairingStore['createRecoveryChallenge']> => {
        signatureChecks += 1;
        return original(...args);
      };
    }

    const forged = async (url: string, suffix: number): Promise<Response> => post(
      `${url}/challenge`, signedStart(attacker.privateKey),
      { 'X-Forwarded-For': `198.51.100.${suffix}` },
    );
    const firstResponse = await forged(firstUrl, 1);
    const secondResponse = await forged(secondUrl, 2);
    const blocked = await forged(
      firstUrl.replace(`/workers/${workerId}/`, '/workers/attacker-selected-worker/'),
      3,
    );
    expect([firstResponse.status, secondResponse.status, blocked.status]).toEqual([401, 401, 429]);
    await expect(blocked.json()).resolves.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(signatureChecks).toBe(2);
    expect(await redis.keys('codeapi:bridge:v1:recovery:rate:start:*')).toEqual([]);

    // Bogus completions use another untrusted bucket, not the worker's signed quota.
    const fake = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'credential.recover',
      serverId,
      workerId,
      enrollmentGeneration: 'a'.repeat(24),
      challenge: randomBytes(32).toString('base64url'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: 'a'.repeat(86),
    };
    const rejected = await post(`${secondUrl}/recover`, fake);
    expect(rejected.status).toBe(401);
    expect(await redis.keys('codeapi:bridge:v1:recovery:rate:complete:*')).toEqual([]);
    const recovered = await post(`${secondUrl}/recover`, fake);
    expect(recovered.status).toBe(401);
    const blockedCompletion = await post(`${secondUrl}/recover`, fake);
    expect(blockedCompletion.status).toBe(429);
    await expect(blockedCompletion.json()).resolves.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
  });

  test('limits recovery challenges across two API routers sharing Redis', async () => {
    const first = new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
      serverId: 'https://code.example.test', maxChallengesPerMinute: 1,
    });
    const second = new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
      serverId: 'https://code.example.test', maxChallengesPerMinute: 1,
    });
    const identity = createBridgeIdentity();
    const pairing = await first.issue(workerId);
    await first.redeem({ workerId, code: pairing.code, publicKey: identity.publicKey });
    const baseUrl = await startRouter(second);
    const initial = signedStart(identity.privateKey);
    await first.createRecoveryChallenge(workerId, initial, initial.signature);
    const denied = await post(`${baseUrl}/challenge`, signedStart(identity.privateKey));
    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
  });
});
