import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';
import type { BridgeRecoveryProofInput } from '../../../packages/code/src/identity';
import type {
  BridgeRecoveryChallenge,
  BridgeRecoveryOptions,
  BridgeWorkerBinding,
  BridgeWorkerCredential,
} from './pairing';

import {
  createBridgeIdentity,
  signBridgeRecovery,
  signBridgeRequest,
} from '../../../packages/code/src/identity';
import { RedisBridgePairingStore } from './pairing';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const serverId = 'https://code.example.test';
const workerId = 'durable-worker';
const binding: BridgeWorkerBinding = {
  tenantId: 'tenant-one',
  principal: { type: 'user', id: 'owner-one' },
};

function recoverableStore(options: Partial<BridgeRecoveryOptions> = {}): RedisBridgePairingStore {
  return new RedisBridgePairingStore(redis, 600, 300, 5_000, '', {
    serverId,
    ...options,
  });
}

function authorizedRequest(
  privateKey: string,
  credential: string,
  nonce: string,
): Parameters<RedisBridgePairingStore['authorize']>[0] {
  const proof = {
    credential,
    method: 'POST',
    path: '/v1/bridge/workers/register',
    timestamp: new Date().toISOString(),
    nonce,
    body: JSON.stringify({ protocolVersion: 1, workerId }),
  };
  return {
    ...proof,
    workerId,
    signature: signBridgeRequest(privateKey, proof),
  };
}

async function enroll(
  store: RedisBridgePairingStore,
  publicKey: string,
): Promise<BridgeWorkerCredential> {
  const pairing = await store.issue(workerId, binding);
  return store.redeem({ workerId, code: pairing.code, publicKey });
}

async function recover(
  store: RedisBridgePairingStore,
  privateKey: string,
): Promise<{ challenge: BridgeRecoveryChallenge; credential: BridgeWorkerCredential }> {
  const challenge = await store.createRecoveryChallenge(workerId);
  const credential = await store.recoverCredential(
    workerId,
    challenge,
    signBridgeRecovery(privateKey, challenge),
  );
  return { challenge, credential };
}

afterEach(async () => {
  await redis.flushall();
});

describe('durable bridge enrollment', () => {
  test('keeps legacy pairing and refresh compatible until recovery is enabled', async () => {
    const legacy = new RedisBridgePairingStore(redis);
    const identity = createBridgeIdentity();
    const issued = await enroll(legacy, identity.publicKey);
    expect(await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`)).toBeNull();

    const replica = recoverableStore();
    await expect(replica.createRecoveryChallenge(workerId)).rejects.toMatchObject({
      code: 'ENROLLMENT_INVALID',
    });
    const rotated = await replica.rotate(workerId);
    await expect(
      replica.authorize(authorizedRequest(identity.privateKey, rotated.credential, 'legacy-proof')),
    ).resolves.toMatchObject({ workerId, binding });
    expect(issued.credential).not.toBe(rotated.credential);
  });

  test('recovers after access expiry and restart with the same identity and binding', async () => {
    const identity = createBridgeIdentity();
    const firstReplica = recoverableStore();
    const issued = await enroll(firstReplica, identity.publicKey);
    const original = await firstReplica.authorize(
      authorizedRequest(identity.privateKey, issued.credential, 'before-outage'),
    );
    const digest = createHash('sha256').update(issued.credential).digest('hex');
    await redis.del(
      `codeapi:bridge:v1:credential:${digest}`,
      `codeapi:bridge:v1:identity:${workerId}`,
      `codeapi:bridge:v1:stable-identity:${workerId}`,
    );
    await expect(firstReplica.rotate(workerId)).rejects.toMatchObject({
      code: 'CREDENTIAL_INVALID',
    });

    const restartedReplica = recoverableStore();
    const { challenge, credential } = await recover(restartedReplica, identity.privateKey);
    expect(challenge).toMatchObject({
      operation: 'credential.recover',
      serverId,
      workerId,
    });
    const restored = await firstReplica.authorize(
      authorizedRequest(identity.privateKey, credential.credential, 'after-outage'),
    );
    expect(restored).toMatchObject({ identityId: original.identityId, binding });
    expect(credential.expiresAt).toBeString();
    const rotated = await restartedReplica.rotate(workerId, restored.credentialId);
    await expect(firstReplica.authorize(
      authorizedRequest(identity.privateKey, rotated.credential, 'after-rotation'),
    )).resolves.toMatchObject({ identityId: original.identityId, binding });
  });

  test('requires the enrolled key and binds proofs to server, worker, generation, operation, and expiry', async () => {
    const enrolled = createBridgeIdentity();
    const outsider = createBridgeIdentity();
    const store = recoverableStore();
    await enroll(store, enrolled.publicKey);
    const challenge = await store.createRecoveryChallenge(workerId);

    await expect(store.recoverCredential(
      workerId, challenge, signBridgeRecovery(outsider.privateKey, challenge),
    )).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    for (const modified of [
      { ...challenge, serverId: 'https://other.example.test' },
      { ...challenge, workerId: 'another-worker' },
      { ...challenge, enrollmentGeneration: '0'.repeat(24) },
      { ...challenge, operation: 'credential.recover-other' as 'credential.recover' },
      { ...challenge, expiresAt: new Date(Date.now() + 120_000).toISOString() },
    ]) {
      await expect(store.recoverCredential(
        workerId,
        modified,
        signBridgeRecovery(enrolled.privateKey, modified as BridgeRecoveryProofInput),
      )).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    }
    const signature = signBridgeRecovery(enrolled.privateKey, challenge);
    await store.recoverCredential(workerId, challenge, signature);
    await expect(store.recoverCredential(workerId, challenge, signature))
      .rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });

  test('rejects a signed challenge after its short-lived Redis window expires', async () => {
    const identity = createBridgeIdentity();
    const store = recoverableStore({ challengeTtlSeconds: 1 });
    await enroll(store, identity.publicKey);
    const challenge = await store.createRecoveryChallenge(workerId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(store.recoverCredential(
      workerId, challenge, signBridgeRecovery(identity.privateKey, challenge),
    )).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });

  test('retries a lost recovery response without changing the enrolled identity', async () => {
    const identity = createBridgeIdentity();
    const first = recoverableStore();
    const originalCredential = await enroll(first, identity.publicKey);
    const original = await first.authorize(
      authorizedRequest(identity.privateKey, originalCredential.credential, 'before-lost-response'),
    );
    await recover(first, identity.privateKey); // The caller lost this credential response.
    const second = recoverableStore();
    const retried = await recover(second, identity.privateKey);
    const auth = await second.authorize(
      authorizedRequest(identity.privateKey, retried.credential.credential, 'after-lost-response'),
    );
    expect(auth.identityId).toBe(original.identityId);
    expect(auth.binding).toEqual(binding);
    const enrolled = JSON.parse((await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`))!) as {
      generation: string;
    };
    expect(await redis.get(`codeapi:bridge:v1:enrollment-required:${workerId}`))
      .toBe(enrolled.generation);
  });

  test('rejects expired and missing enrollment even when an access credential remains live', async () => {
    const identity = createBridgeIdentity();
    const store = recoverableStore({ enrollmentTtlSeconds: 1 });
    const issued = await enroll(store, identity.publicKey);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(store.createRecoveryChallenge(workerId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(store.rotate(workerId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(store.authorize(
      authorizedRequest(identity.privateKey, issued.credential, 'expired-enrollment'),
    )).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
  });

  test('never treats an unmarked access token as legacy after authorization state is lost', async () => {
    const identity = createBridgeIdentity();
    const store = recoverableStore();
    const issued = await enroll(store, identity.publicKey);
    const credentialKey = `codeapi:bridge:v1:credential:${createHash('sha256').update(issued.credential).digest('hex')}`;
    const raw = JSON.parse((await redis.get(credentialKey))!) as { enrollmentGeneration?: string };
    delete raw.enrollmentGeneration; // Simulate a refresh by a pre-recovery replica.
    await redis.set(credentialKey, JSON.stringify(raw), 'EX', 300);
    await redis.del(`codeapi:bridge:v1:enrollment:${workerId}`);

    expect(await redis.get(`codeapi:bridge:v1:enrollment-required:${workerId}`)).not.toBeNull();
    await expect(store.authorize(
      authorizedRequest(identity.privateKey, issued.credential, 'lost-authorization'),
    )).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(store.rotate(workerId)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(store.createRecoveryChallenge(workerId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await redis.set(`codeapi:bridge:v1:enrollment:${workerId}`, 'null');
    await expect(store.createRecoveryChallenge(workerId))
      .rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
  });

  test('re-pairing explicitly supersedes a previous key and binds to the new principal', async () => {
    const first = createBridgeIdentity();
    const second = createBridgeIdentity();
    const store = recoverableStore();
    const initial = await enroll(store, first.publicKey);
    const pending = await store.createRecoveryChallenge(workerId);
    const replacement = await store.issue(workerId, {
      tenantId: 'tenant-two', principal: { type: 'user', id: 'owner-two' },
    });
    await store.redeem({ workerId, code: replacement.code, publicKey: second.publicKey });

    await expect(store.recoverCredential(
      workerId, pending, signBridgeRecovery(first.privateKey, pending),
    )).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    await expect(store.authorize(
      authorizedRequest(first.privateKey, initial.credential, 'superseded-key'),
    )).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    const { credential } = await recover(store, second.privateKey);
    await expect(store.authorize(
      authorizedRequest(second.privateKey, credential.credential, 'new-owner'),
    )).resolves.toMatchObject({
      binding: { tenantId: 'tenant-two', principal: { type: 'user', id: 'owner-two' } },
    });
  });

  test('revocation beats a signed recovery pending on a different replica', async () => {
    const identity = createBridgeIdentity();
    const first = recoverableStore();
    const second = recoverableStore();
    await enroll(first, identity.publicKey);
    const challenge = await first.createRecoveryChallenge(workerId);
    const originalEval = redis.eval.bind(redis);
    let release!: () => void;
    let enter!: () => void;
    const paused = new Promise<void>((resolve) => { enter = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    redis.eval = (async (script: string, ...args: unknown[]) => {
      if (script.includes('local stableIdentity = redis.call')) {
        enter();
        await resume;
      }
      return (originalEval as (...evalArgs: unknown[]) => Promise<unknown>)(script, ...args);
    }) as Redis['eval'];
    try {
      const pending = first.recoverCredential(
        workerId, challenge, signBridgeRecovery(identity.privateKey, challenge),
      );
      await paused;
      await second.revoke(workerId);
      release();
      await expect(pending).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
      expect(await redis.get(`codeapi:bridge:v1:identity:${workerId}`)).toBeNull();
      expect(await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`)).toBeNull();
    } finally {
      redis.eval = originalEval as Redis['eval'];
      release();
    }
  });

  test('rate limits challenge creation and signing attempts across replicas', async () => {
    const identity = createBridgeIdentity();
    const first = recoverableStore({ maxChallengesPerMinute: 1, maxAttemptsPerMinute: 1 });
    const second = recoverableStore({ maxChallengesPerMinute: 1, maxAttemptsPerMinute: 1 });
    await enroll(first, identity.publicKey);
    const challenge = await first.createRecoveryChallenge(workerId);
    await expect(second.createRecoveryChallenge(workerId))
      .rejects.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
    await expect(first.recoverCredential(workerId, challenge, 'invalid'))
      .rejects.toMatchObject({ code: 'PROOF_INVALID' });
    await expect(second.recoverCredential(
      workerId, challenge, signBridgeRecovery(identity.privateKey, challenge),
    )).rejects.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
  });

  test('recovering credentials never clears worker or workspace quarantine', async () => {
    const identity = createBridgeIdentity();
    const store = recoverableStore();
    await enroll(store, identity.publicKey);
    const workerQuarantine = `codeapi:bridge:v1:worker:${workerId}:incarnation:incarnation-00000001:quarantined`;
    const workspaceQuarantine = `codeapi:bridge:v1:worker:${workerId}:workspace:${createHash('sha256').update('session-one').digest('hex')}:quarantined`;
    await redis.set(workerQuarantine, '1');
    await redis.set(workspaceQuarantine, '1');
    const { credential } = await recover(store, identity.privateKey);
    expect(await redis.get(workerQuarantine)).toBe('1');
    expect(await redis.get(workspaceQuarantine)).toBe('1');
    const auth = await store.authorize(
      authorizedRequest(identity.privateKey, credential.credential, 'quarantined-machine'),
    );
    await expect(new RedisBridgeStore(redis).register({
      protocolVersion: 1,
      workerId,
      incarnationId: 'incarnation-00000001',
      capabilities: { statefulWorkspace: true, sandboxProfile: 'nsjail', runtimes: ['bash'] },
    }, auth)).rejects.toMatchObject({ code: 'WORKER_QUARANTINED' });
  });

  test('refuses non-HTTPS or non-origin deployment identity and unbounded recovery policy', () => {
    for (const invalid of ['http://code.example.test', 'https://code.example.test/path', 'https://user@code.example.test']) {
      expect(() => recoverableStore({ serverId: invalid })).toThrow();
    }
    expect(() => recoverableStore({ maxAttemptsPerMinute: 0 })).toThrow();
    expect(() => recoverableStore({ challengeTtlSeconds: 301 })).toThrow();
  });
});
