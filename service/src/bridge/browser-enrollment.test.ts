import { createHash, randomBytes } from 'crypto';

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';

import {
  browserSetupRequestHash,
  canonicalBrowserSetupProof,
  canonicalBrowserSetupRequest,
  canonicalEnrollmentRedemption,
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentRedemption,
  normalizeBrowserEnrollmentInstance,
  signBrowserSetupProof,
  signEnrollmentRedemption,
  validateBrowserSetupProof,
  validateBrowserSetupRequest,
  verifyBrowserSetupProof,
  verifyEnrollmentRedemption,
} from '../../../packages/code/src/browser-enrollment-protocol';
import type {
  BrowserEnrollmentApproval,
  BrowserEnrollmentRedemption,
  BrowserSetupProof,
  BrowserSetupRequest,
} from '../../../packages/code/src/browser-enrollment-protocol';
import {
  createBridgeIdentity,
  signBridgeRecovery,
  signBridgeRecoveryStart,
  signBridgeRequest,
} from '../../../packages/code/src/identity';
import { RedisBridgePairingStore } from './pairing';
import type { BridgeRecoveryOptions, BridgeWorkerCredential } from './pairing';
import { RedisBridgeStore } from './store';

const redis = process.env.BROWSER_ENROLLMENT_REDIS_PORT
  ? new Redis({ host: '127.0.0.1', port: Number(process.env.BROWSER_ENROLLMENT_REDIS_PORT) })
  : new RedisMock() as unknown as Redis;
const serverId = 'https://code.example.test';
const adminToken = 'test-browser-enrollment-administrator-secret';
const identity = createBridgeIdentity();
const outsider = createBridgeIdentity();
const workerId = 'browser-enrolled-worker';

function store(options: Partial<BridgeRecoveryOptions> = {}, credentialTtl = 900): RedisBridgePairingStore {
  return new RedisBridgePairingStore(redis, 600, credentialTtl, 5_000, '', { serverId, ...options });
}

function request(): BrowserSetupRequest {
  return {
    version: 1,
    instance: 'https://chat.example.test/base',
    attemptId: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
    publicKey: identity.publicKey,
    machineName: 'My VM (development)',
    workspace: { type: 'directory' },
    allowWorkspaceWrites: true,
    allowWorkspaceCommands: false,
  };
}

function approval(overrides: Partial<BrowserEnrollmentApproval> = {}): BrowserEnrollmentApproval {
  const setup = request();
  return {
    protocolVersion: 1,
    operation: 'enrollment.redeem',
    serverId,
    instance: setup.instance,
    attemptId: setup.attemptId,
    requestHash: browserSetupRequestHash(setup),
    workerId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publicKey: identity.publicKey,
    binding: { tenantId: 'tenant-one', principal: { type: 'user', id: 'owner-one' } },
    ...overrides,
  };
}

function redemption(input: BrowserEnrollmentApproval, privateKey = identity.privateKey): BrowserEnrollmentRedemption {
  const { operation, serverId, instance, attemptId, requestHash, workerId, expiresAt } = input;
  const contract = { operation, serverId, instance, attemptId, requestHash, workerId, expiresAt };
  return { protocolVersion: 1, ...contract, signature: signEnrollmentRedemption(privateKey, contract) };
}

function authorized(credential: BridgeWorkerCredential): Parameters<RedisBridgePairingStore['authorize']>[0] {
  const proof = {
    credential: credential.credential,
    method: 'POST',
    path: `/bridge/workers/${workerId}/lease`,
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
    body: '{}',
  };
  return { ...proof, workerId, signature: signBridgeRequest(identity.privateKey, proof) };
}

afterEach(async () => { await redis.flushall(); });
afterAll(() => { redis.disconnect(); });

describe('browser enrollment proof contract', () => {
  test('canonicalizes fixed request fields and preserves every authorization choice', () => {
    const input = request();
    expect(normalizeBrowserEnrollmentInstance('https://CHAT.example.test:443/base///')).toBe(input.instance);
    expect(() => normalizeBrowserEnrollmentInstance('http://untrusted.example.test')).toThrow();
    expect(() => normalizeBrowserEnrollmentInstance('https://user:password@chat.example.test')).toThrow();
    expect(() => normalizeBrowserEnrollmentInstance('https://chat.example.test/?query=1')).toThrow();
    const canonical = canonicalBrowserSetupRequest(input);
    expect(Object.keys(JSON.parse(canonical))).toEqual([
      'version', 'instance', 'attemptId', 'createdAt', 'publicKey', 'machineName', 'workspace',
      'allowWorkspaceWrites', 'allowWorkspaceCommands',
    ]);
    expect(browserSetupRequestHash(input)).toBe(createHash('sha256').update(canonical).digest('hex'));
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as BrowserSetupRequest;
    expect(browserSetupRequestHash(reordered)).toBe(browserSetupRequestHash(input));
    for (const change of [
      { allowWorkspaceWrites: false }, { allowWorkspaceCommands: true }, { workspace: { type: 'private' as const } },
      { machineName: 'Different VM' }, { publicKey: outsider.publicKey },
    ]) expect(browserSetupRequestHash({ ...input, ...change })).not.toBe(browserSetupRequestHash(input));
  });

  test('rejects noncanonical requests and malformed proofs without throwing from verification', () => {
    const input = request();
    for (const malformed of [
      null, [], { ...input, extra: true }, { ...input, version: 2 }, { ...input, machineName: 'x\ny' },
      { ...input, machineName: 'x'.repeat(81) }, { ...input, machineName: ' leading' },
      { ...input, instance: `${input.instance}/` }, { ...input, attemptId: 'x'.repeat(43) },
      { ...input, createdAt: '2026-10-21' }, { ...input, publicKey: outsider.privateKey },
      { ...input, workspace: { type: 'directory', path: '/secret' } }, { ...input, allowWorkspaceWrites: 1 },
    ]) expect(validateBrowserSetupRequest(malformed)).toBe(false);
    expect(verifyBrowserSetupProof('invalid key', {} as BrowserSetupProof, '!')).toBe(false);
  });

  test('binds operation, audience, attempt, request hash, time and nonce, with separate signing domains', () => {
    const input = request();
    const proof: BrowserSetupProof = {
      operation: 'setup.start', instance: input.instance, attemptId: input.attemptId,
      requestHash: browserSetupRequestHash(input), timestamp: input.createdAt,
      nonce: randomBytes(32).toString('base64url'),
    };
    const signature = signBrowserSetupProof(identity.privateKey, proof);
    expect(canonicalBrowserSetupProof(proof).split('\n')).toEqual([
      'librechat-code:browser-setup:v1', proof.operation, proof.instance, proof.attemptId,
      proof.requestHash, proof.timestamp, proof.nonce,
    ]);
    expect(validateBrowserSetupProof(proof)).toBe(true);
    expect(verifyBrowserSetupProof(identity.publicKey, proof, signature)).toBe(true);
    expect(verifyBrowserSetupProof(outsider.publicKey, proof, signature)).toBe(false);
    for (const change of [
      { operation: 'setup.poll' as const }, { operation: 'setup.cancel' as const }, { operation: 'setup.complete' as const },
      { instance: 'https://different.example.test' }, { attemptId: randomBytes(32).toString('base64url') },
      { requestHash: 'f'.repeat(64) }, { timestamp: new Date(Date.now() + 1_000).toISOString() },
      { nonce: randomBytes(32).toString('base64url') },
    ]) expect(verifyBrowserSetupProof(identity.publicKey, { ...proof, ...change }, signature)).toBe(false);
    const approved = approval({ instance: proof.instance, attemptId: proof.attemptId, requestHash: proof.requestHash });
    expect(canonicalEnrollmentRedemption(approved).split('\n')).toEqual([
      'librechat-code:browser-enrollment-redeem:v1', approved.operation, approved.serverId,
      approved.instance, approved.attemptId, approved.requestHash, approved.workerId, approved.expiresAt,
    ]);
    expect(verifyEnrollmentRedemption(identity.publicKey, approved, signature)).toBe(false);
    expect(verifyBrowserSetupProof(identity.publicKey, proof, signEnrollmentRedemption(identity.privateKey, approved))).toBe(false);
    expect(isBrowserEnrollmentRedemption({ ...redemption(approved), publicKey: identity.publicKey })).toBe(false);
    expect(isBrowserEnrollmentApproval({ ...approved, binding: { tenantId: 'x', principal: { type: 'bad', id: 'x' } } })).toBe(false);
  });
});

describe('Redis browser enrollment ownership', () => {
  test('retries lost issue and redemption responses across replicas without rotating keys or widening access', async () => {
    const first = store();
    const approved = approval();
    await first.issueBrowserEnrollment(approved);
    const second = store();
    expect(await second.issueBrowserEnrollment(approved)).toEqual(approved);
    const original = await first.redeemBrowserEnrollment(redemption(approved), adminToken);
    expect(await second.issueBrowserEnrollment(approved)).toEqual(approved);
    expect(await second.redeemBrowserEnrollment(redemption(approved), adminToken)).toEqual(original);
    const auth = await second.authorize(authorized(original));
    expect(auth).toMatchObject({ workerId, binding: approved.binding, pairingGeneration: 0 });
    const enrollmentRaw = await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`);
    const allValues = await redis.mget(...await redis.keys('codeapi:bridge:v1:*'));
    expect(allValues.join('\n')).not.toContain(original.credential);
    expect(enrollmentRaw).toContain(identity.publicKey.trim().split('\n')[1]);
    await expect(second.redeemBrowserEnrollment(redemption(approved), 'wrong-encryption-key')).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`)).toBe(enrollmentRaw);
  });

  test('concurrent duplicates commit exactly one enrollment and return the identical response', async () => {
    const approved = approval();
    const replicas = [store(), store(), store()];
    const issued = await Promise.all(replicas.map(replica => replica.issueBrowserEnrollment(approved)));
    expect(issued).toEqual([approved, approved, approved]);
    const completed = await Promise.all(replicas.map(replica => replica.redeemBrowserEnrollment(redemption(approved), adminToken)));
    expect(completed[1]).toEqual(completed[0]);
    expect(completed[2]).toEqual(completed[0]);
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(1);
    expect(await redis.keys('codeapi:bridge:v1:enrollment:*')).toHaveLength(1);
  });

  test('does not depend on binding property order and retries after worker registration', async () => {
    const replica = store();
    const approved = approval({ binding: { principal: { id: 'owner-one', type: 'user' }, tenantId: 'tenant-one' } });
    await replica.issueBrowserEnrollment(approved);
    const credential = await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
    const auth = await replica.authorize(authorized(credential));
    const workers = new RedisBridgeStore(redis);
    await workers.register({
      protocolVersion: 1, workerId, incarnationId: 'browser-test-incarnation',
      identityId: auth.identityId, credentialId: auth.credentialId, binding: approved.binding,
      capabilities: { statefulWorkspace: false, runtimes: [], sandboxProfile: 'native-srt' },
    }, auth);
    expect(await replica.issueBrowserEnrollment(approved)).toEqual(approved);
    expect(await replica.redeemBrowserEnrollment(redemption(approved), adminToken)).toEqual(credential);
  });

  test('conflicting concurrent approvals cannot replace the winner or allocate a second worker', async () => {
    const approved = approval();
    const changed = { ...approved, workerId: 'other-worker', publicKey: outsider.publicKey };
    const results = await Promise.allSettled([store().issueBrowserEnrollment(approved), store().issueBrowserEnrollment(changed)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Expected one committed approval');
    const key = winner.value.publicKey === identity.publicKey ? identity.privateKey : outsider.privateKey;
    await store().redeemBrowserEnrollment(redemption(winner.value, key), adminToken);
    expect(await redis.keys('codeapi:bridge:v1:enrollment:*')).toHaveLength(1);
  });

  test('bounded credential replay cannot remint after its TTL but durable status remains available', async () => {
    const replica = store({}, 1);
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await expect(store({}, 1).redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    const { signature: _signature, ...statusRequest } = redemption(approved);
    expect(await store().browserEnrollmentStatus(statusRequest)).toMatchObject({ status: 'completed', workerId });
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
  });

  test('rejects replacement of immutable approval fields and reuse of the allocated worker', async () => {
    const replica = store();
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    for (const change of [
      { workerId: 'another-worker' }, { publicKey: outsider.publicKey }, { requestHash: 'f'.repeat(64) },
      { expiresAt: new Date(Date.now() + 120_000).toISOString() },
      { binding: { tenantId: 'tenant-two', principal: { type: 'deployment' as const, id: 'everyone' } } },
    ]) await expect(replica.issueBrowserEnrollment({ ...approved, ...change })).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    const first = await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(await replica.authorize(authorized(first))).toMatchObject({ binding: approved.binding });
  });

  test('rejects wrong key, audience, operation and every contract mismatch', async () => {
    const replica = store();
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    await expect(replica.redeemBrowserEnrollment(redemption(approved, outsider.privateKey), adminToken)).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    for (const change of [
      { serverId: 'https://other-code.example.test' }, { instance: 'https://other-chat.example.test' },
      { attemptId: randomBytes(32).toString('base64url') }, { requestHash: 'f'.repeat(64) },
      { workerId: 'another-worker' }, { expiresAt: new Date(Date.now() + 120_000).toISOString() },
    ]) await expect(replica.redeemBrowserEnrollment(redemption({ ...approved, ...change }), adminToken)).rejects.toBeDefined();
    await expect(replica.redeemBrowserEnrollment({ ...redemption(approved), operation: 'setup.complete' } as unknown as BrowserEnrollmentRedemption, adminToken)).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    await expect(replica.redeemBrowserEnrollment({ ...redemption(approved), signature: '?' }, adminToken)).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
    await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
  });

  test('never extends the immutable expiry or recreates an expired approval', async () => {
    const replica = store();
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 601_000).toISOString()]) {
      await expect(replica.issueBrowserEnrollment(approval({ expiresAt }))).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    }
    const approved = approval({ expiresAt: new Date(Date.now() + 2_000).toISOString() });
    await replica.issueBrowserEnrollment(approved);
    await new Promise(resolve => setTimeout(resolve, 2_100));
    await expect(replica.issueBrowserEnrollment(approved)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    const { signature: _signature, ...statusRequest } = redemption(approved);
    expect(await replica.browserEnrollmentStatus(statusRequest)).toMatchObject({ status: 'revoked' });
    await expect(replica.issueBrowserEnrollment({ ...approved, workerId: 'replacement-worker', expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
  });

  test('durable enrollment outlives setup expiry and recovers after restart and access credential loss', async () => {
    const replica = store();
    const approved = approval({ expiresAt: new Date(Date.now() + 2_000).toISOString() });
    await replica.issueBrowserEnrollment(approved);
    const original = await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
    const originalAuth = await replica.authorize(authorized(original));
    await new Promise(resolve => setTimeout(resolve, 2_100));
    expect(await store().redeemBrowserEnrollment(redemption(approved), adminToken)).toEqual(original);
    await redis.del(
      `codeapi:bridge:v1:identity:${workerId}`, `codeapi:bridge:v1:stable-identity:${workerId}`,
      `codeapi:bridge:v1:credential:${createHash('sha256').update(original.credential).digest('hex')}`,
    );
    const restarted = store();
    const { signature: _signature, ...statusRequest } = redemption(approved);
    expect(await restarted.browserEnrollmentStatus(statusRequest)).toEqual({ protocolVersion: 1, status: 'completed', workerId });
    await expect(restarted.browserEnrollmentStatus({ ...statusRequest, requestHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    const start = {
      operation: 'credential.challenge' as const, serverId, workerId,
      timestamp: new Date().toISOString(), nonce: randomBytes(32).toString('base64url'),
    };
    const challenge = await restarted.createRecoveryChallenge(workerId, start, signBridgeRecoveryStart(identity.privateKey, start));
    const recovered = await restarted.recoverCredential(workerId, challenge, signBridgeRecovery(identity.privateKey, challenge));
    expect(await restarted.authorize(authorized(recovered))).toMatchObject({ identityId: originalAuth.identityId, binding: approved.binding });
    await restarted.revoke(workerId);
    expect(await restarted.browserEnrollmentStatus(statusRequest)).toMatchObject({ status: 'revoked', workerId });
    await expect(restarted.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
  });

  test('revocation fences approval, completion, exact replay and recovery without clearing quarantine', async () => {
    const replica = store();
    const approved = approval();
    const quarantine = `codeapi:bridge:v1:worker:${workerId}:workspace:root:quarantined`;
    await redis.set(quarantine, 'existing-fence');
    await replica.issueBrowserEnrollment(approved);
    await replica.revoke(workerId);
    await expect(replica.issueBrowserEnrollment(approved)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(await redis.get(quarantine)).toBe('existing-fence');
    expect(await redis.get(`codeapi:bridge:v1:pairing-generation:${workerId}`)).toBe('1');

    const other = approval({ workerId: 'second-worker' });
    await replica.issueBrowserEnrollment(other);
    const credential = await replica.redeemBrowserEnrollment(redemption(other), adminToken);
    await replica.revoke(other.workerId);
    await expect(replica.redeemBrowserEnrollment(redemption(other), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(await redis.get(`codeapi:bridge:v1:enrollment:${other.workerId}`)).toBeNull();
    expect(credential.workerId).toBe(other.workerId);
  });

  test('status distinguishes pending, completed, revoked and unknown exact contracts without issuing credentials', async () => {
    const replica = store();
    const approved = approval();
    const { signature: _signature, ...statusRequest } = redemption(approved);
    await expect(replica.browserEnrollmentStatus(statusRequest)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await replica.issueBrowserEnrollment(approved);
    expect(await store().browserEnrollmentStatus(statusRequest)).toEqual({ protocolVersion: 1, status: 'pending', workerId });
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
    await expect(replica.browserEnrollmentStatus({ ...statusRequest, workerId: 'different-worker' })).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await replica.revoke(workerId);
    expect(await store().browserEnrollmentStatus(statusRequest)).toEqual({ protocolVersion: 1, status: 'revoked', workerId });
    await expect(replica.issueBrowserEnrollment(approved)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
  });

  test('manual issue supersedes only the pending fence and cannot be undone by a retry', async () => {
    const replica = store();
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    const manual = await replica.issue(workerId, approved.binding);
    await expect(replica.issueBrowserEnrollment(approved)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    const issued = await replica.redeem({ workerId, code: manual.code, publicKey: outsider.publicKey });
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    expect(issued.workerId).toBe(workerId);
  });

  for (const afterScanWindow of [false, true]) test(`unindexed legacy codes cannot supersede browser approval ${afterScanWindow ? 'after' : 'during'} migration`, async () => {
    const replica = store();
    const approved = approval();
    const legacyCode = randomBytes(24).toString('base64url');
    const legacyKey = `codeapi:bridge:v1:pairing:${createHash('sha256').update(legacyCode).digest('hex')}`;
    await redis.set(legacyKey, JSON.stringify({ workerId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      binding: { tenantId: 'other-tenant', principal: { type: 'user', id: 'other-owner' } } }), 'EX', 60);
    if (afterScanWindow) await redis.set('codeapi:bridge:v1:migration:legacy-pairing-scan-until', String(Date.now() - 1));
    await replica.issueBrowserEnrollment(approved);
    expect(await redis.get(`codeapi:bridge:v1:pairing-generation:${workerId}`)).toBe('0');
    if (!afterScanWindow) expect(await redis.get(legacyKey)).toBeNull();
    await expect(replica.redeem({ workerId, code: legacyCode, publicKey: outsider.publicKey })).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    const credential = await replica.redeemBrowserEnrollment(redemption(approved), adminToken);
    expect(await replica.authorize(authorized(credential))).toMatchObject({ workerId, binding: approved.binding });
  });

  test('cannot replace a preexisting manual enrollment or pending pairing', async () => {
    const replica = store();
    const manual = await replica.issue(workerId);
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await replica.redeem({ workerId, code: manual.code, publicKey: outsider.publicKey });
    await expect(replica.issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(replica.issueBrowserEnrollment(approval({ serverId: 'https://wrong.example.test' }))).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    await expect(new RedisBridgePairingStore(redis).issueBrowserEnrollment(approval())).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
  });

  test('per-attempt budgets are shared by replicas and wrong signatures cannot create credentials', async () => {
    const approved = approval();
    const first = store({ maxAttemptsPerMinute: 2 });
    const second = store({ maxAttemptsPerMinute: 2 });
    await first.issueBrowserEnrollment(approved);
    const forged = redemption(approved, outsider.privateKey);
    await expect(first.redeemBrowserEnrollment(forged, adminToken)).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    await expect(second.redeemBrowserEnrollment(forged, adminToken)).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    await expect(first.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'RECOVERY_RATE_LIMITED' });
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
  });

  test('manual issue between signature verification and completion permanently supersedes the browser attempt', async () => {
    const replica = store();
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    const originalEval = redis.eval.bind(redis);
    let manualCode = '';
    redis.eval = (async (...args: Parameters<Redis['eval']>): Promise<unknown> => {
      if (!manualCode && String(args[0]).includes('local replay =')) {
        manualCode = (await replica.issue(workerId)).code;
      }
      return originalEval(...args);
    }) as Redis['eval'];
    try {
      await expect(replica.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
      expect(manualCode.length).toBeGreaterThan(0);
      await replica.redeem({ workerId, code: manualCode, publicKey: outsider.publicKey });
      await expect(replica.issueBrowserEnrollment(approved)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
    } finally {
      redis.eval = originalEval as Redis['eval'];
    }
  });

  test('atomic generation comparison wins a revoke between proof validation and completion', async () => {
    const replica = store();
    const approved = approval();
    await replica.issueBrowserEnrollment(approved);
    const originalEval = redis.eval.bind(redis);
    let intercepted = false;
    redis.eval = (async (...args: Parameters<Redis['eval']>): Promise<unknown> => {
      if (!intercepted && String(args[0]).includes('local replay =')) {
        intercepted = true;
        await replica.revoke(workerId);
      }
      return originalEval(...args);
    }) as Redis['eval'];
    try {
      await expect(replica.redeemBrowserEnrollment(redemption(approved), adminToken)).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' });
      expect(intercepted).toBe(true);
      expect(await redis.get(`codeapi:bridge:v1:enrollment:${workerId}`)).toBeNull();
      expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
    } finally {
      redis.eval = originalEval as Redis['eval'];
    }
  });
});
