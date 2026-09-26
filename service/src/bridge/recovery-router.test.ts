import { createServer, type Server } from 'http';

import { afterEach, describe, expect, test } from 'bun:test';
import express, { json } from 'express';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';
import type { BridgeRecoveryChallengeResponse } from '../../../packages/code/src/protocol';

import { createBridgeIdentity, signBridgeRecovery } from '../../../packages/code/src/identity';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgePairingStore } from './pairing';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const workerId = 'http-recovery-worker';
let server: Server | undefined;

async function startRouter(pairings: RedisBridgePairingStore): Promise<string> {
  const app = express();
  app.use(json());
  app.use('/v1/bridge', createBridgeRouter({
    store: new RedisBridgeStore(redis),
    pairings,
    authMode: 'paired',
    adminToken: 'operator-only',
    configuredWorkerId: workerId,
  }));
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}/v1/bridge/workers/${workerId}/credentials`;
}

function post(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  server?.close();
  server = undefined;
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
      serverId: 'https://code.example.test',
    });
    const identity = createBridgeIdentity();
    const pairing = await pairings.issue(workerId, {
      tenantId: 'tenant-one', principal: { type: 'user', id: 'owner-one' },
    });
    await pairings.redeem({ workerId, code: pairing.code, publicKey: identity.publicKey });
    const baseUrl = await startRouter(pairings);
    const challengeResponse = await post(`${baseUrl}/challenge`, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as BridgeRecoveryChallengeResponse;
    expect(challenge).toMatchObject({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      serverId: 'https://code.example.test',
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
    await first.createRecoveryChallenge(workerId);
    const denied = await post(`${baseUrl}/challenge`, { protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
  });
});
