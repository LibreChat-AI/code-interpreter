import { randomBytes } from 'crypto';
import { createServer, type Server } from 'http';

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import express, { json } from 'express';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';

import {
  browserSetupRequestHash,
  signEnrollmentRedemption,
} from '../../../packages/code/src/browser-enrollment-protocol';
import type { BrowserEnrollmentApproval, BrowserEnrollmentRedemption } from '../../../packages/code/src/browser-enrollment-protocol';
import { createBridgeIdentity } from '../../../packages/code/src/identity';
import { RedisBridgePairingStore } from './pairing';
import type { BridgeRecoveryOptions } from './pairing';
import { createBridgeRouter } from './router';
import type { BridgeRouterOptions } from './router';
import { RedisBridgeStore } from './store';

const redis = process.env.BROWSER_ENROLLMENT_REDIS_PORT
  ? new Redis({ host: '127.0.0.1', port: Number(process.env.BROWSER_ENROLLMENT_REDIS_PORT) })
  : new RedisMock() as unknown as Redis;
const serverId = 'https://code.example.test';
const adminToken = 'browser-enrollment-test-admin';
const identity = createBridgeIdentity();
const outsider = createBridgeIdentity();
const servers: Server[] = [];

function pairings(options: Partial<BridgeRecoveryOptions> = {}): RedisBridgePairingStore {
  return new RedisBridgePairingStore(redis, 600, 900, 5_000, '', { serverId, ...options });
}

async function router(options: Partial<BridgeRouterOptions> = {}): Promise<string> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(json());
  app.use('/bridge', createBridgeRouter({
    store: new RedisBridgeStore(redis), pairings: pairings(), authMode: 'paired', adminToken,
    allowDynamicWorkers: true, configuredWorkerId: 'browser-http-worker', ...options,
  }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}/bridge`;
}

function approved(): BrowserEnrollmentApproval {
  const request = {
    version: 1 as const, instance: 'https://chat.example.test', attemptId: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(), publicKey: identity.publicKey, machineName: 'HTTP worker',
    workspace: { type: 'private' as const }, allowWorkspaceWrites: false, allowWorkspaceCommands: false,
  };
  return {
    protocolVersion: 1, operation: 'enrollment.redeem', serverId, instance: request.instance,
    attemptId: request.attemptId, requestHash: browserSetupRequestHash(request), workerId: 'browser-http-worker',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), publicKey: identity.publicKey,
    binding: { tenantId: 'tenant-one', principal: { type: 'user', id: 'owner-one' } },
  };
}

function proof(approval: BrowserEnrollmentApproval, privateKey = identity.privateKey): BrowserEnrollmentRedemption {
  const { publicKey: _publicKey, binding: _binding, ...contract } = approval;
  return { ...contract, signature: signEnrollmentRedemption(privateKey, contract) };
}

function post(url: string, body: object, token = adminToken, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function capability(url: string, token = adminToken): Promise<Response> {
  return fetch(`${url}/enrollments/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await redis.flushall();
});
afterAll(() => { redis.disconnect(); });

describe('browser enrollment HTTP boundary', () => {
  test('advertises the version only for paired auth, durable recovery, dynamic workers and an authenticated admin', async () => {
    const url = await router();
    const response = await capability(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ browserEnrollmentVersion: 1, serverId });
    expect((await capability(url, 'outsider')).status).toBe(401);
    for (const options of [
      { enabled: false }, { authMode: 'static' as const }, { allowDynamicWorkers: false },
      { pairings: new RedisBridgePairingStore(redis) },
    ]) {
      const disabled = await router(options);
      expect((await capability(disabled)).status).toBe(404);
      expect((await post(`${disabled}/enrollments`, approved())).status).toBe(404);
      expect((await post(`${disabled}/enrollments/redeem`, proof(approved()))).status).toBe(404);
    }
    const unconfigured = await router({ adminToken: '' });
    expect((await capability(unconfigured)).status).toBe(503);
    expect((await post(`${unconfigured}/enrollments`, approved())).status).toBe(503);
  });

  test('preserves old manual pairing when browser enrollment is disabled', async () => {
    const url = await router({ allowDynamicWorkers: false, pairings: new RedisBridgePairingStore(redis) });
    const issue = await post(`${url}/pairings`, { workerId: 'browser-http-worker' });
    expect(issue.status).toBe(200);
    const pairing = await issue.json() as { code: string };
    const result = await post(`${url}/pairings/redeem`, {
      protocolVersion: 1, workerId: 'browser-http-worker', code: pairing.code, publicKey: identity.publicKey,
    }, '');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ protocolVersion: 1, workerId: 'browser-http-worker' });
  });

  test('requires admin auth for approval, redemption and reconciliation, independently of machine proof', async () => {
    const url = await router();
    const approval = approved();
    const redemption = proof(approval);
    const { signature: _signature, ...statusRequest } = redemption;
    for (const [path, body] of [
      ['enrollments', approval], ['enrollments/redeem', redemption], ['enrollments/status', statusRequest],
    ] as const) expect((await post(`${url}/${path}`, body, 'outsider')).status).toBe(401);
    expect(await redis.keys('codeapi:bridge:v1:browser-enrollment:*')).toHaveLength(0);
  });

  test('validates envelopes, binds approvals, and idempotently returns the same credential across HTTP replicas', async () => {
    const first = await router();
    const second = await router();
    const approval = approved();
    for (const body of [
      { ...approval, protocolVersion: 2 }, { ...approval, publicKey: outsider.privateKey },
      { ...approval, binding: null }, { ...approval, extra: true },
    ]) expect((await post(`${first}/enrollments`, body)).status).toBe(400);
    const issued = await post(`${first}/enrollments`, approval);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual(approval);
    expect((await post(`${second}/enrollments`, approval)).status).toBe(200);
    const { signature: _pendingSignature, ...pendingRequest } = proof(approval);
    const pending = await post(`${second}/enrollments/status`, pendingRequest);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ protocolVersion: 1, status: 'pending', workerId: approval.workerId });
    expect((await post(`${second}/enrollments`, { ...approval, publicKey: outsider.publicKey })).status).toBe(409);
    expect((await post(`${first}/enrollments/redeem`, { ...proof(approval), signature: '?' })).status).toBe(400);
    expect((await post(`${first}/enrollments/redeem`, { ...proof(approval), operation: 'setup.complete' })).status).toBe(400);
    expect((await post(`${first}/enrollments/redeem`, proof(approval, outsider.privateKey))).status).toBe(401);
    expect((await post(`${first}/enrollments/redeem`, proof({ ...approval, serverId: 'https://other.example.test' }))).status).toBe(401);
    expect((await post(`${first}/enrollments/redeem`, proof({ ...approval, instance: 'https://other.example.test' }))).status).toBe(409);
    const responses = await Promise.all([first, second].map(url => post(`${url}/enrollments/redeem`, proof(approval))));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [original, replay] = await Promise.all(responses.map(response => response.json()));
    expect(original).toEqual(replay);
    expect(original).toMatchObject({ protocolVersion: 1, workerId: approval.workerId });
    expect(JSON.stringify(original)).not.toMatch(/tenant-one|owner-one|publicKey|privateKey|binding/);
    const { signature: _signature, ...statusRequest } = proof(approval);
    expect((await post(`${second}/enrollments/status`, statusRequest)).status).toBe(200);
    expect((await post(`${second}/enrollments/status`, { ...statusRequest, requestHash: 'f'.repeat(64) })).status).toBe(409);
    expect((await post(`${first}/workers/${approval.workerId}/revoke`, {})).status).toBe(200);
    expect((await post(`${second}/enrollments/redeem`, proof(approval))).status).toBe(409);
    const revoked = await post(`${second}/enrollments/status`, statusRequest);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ protocolVersion: 1, status: 'revoked', workerId: approval.workerId });
  });

  test('shares a connection-peer budget across replicas and ignores spoofed forwarded IPs', async () => {
    const first = await router({ pairings: pairings({ maxUntrustedRequestsPerMinute: 2 }) });
    const second = await router({ pairings: pairings({ maxUntrustedRequestsPerMinute: 2 }) });
    const approval = approved();
    await post(`${first}/enrollments`, approval);
    const forged = proof(approval, outsider.privateKey);
    expect((await post(`${first}/enrollments/redeem`, forged, adminToken, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(401);
    expect((await post(`${second}/enrollments/redeem`, forged, adminToken, { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(401);
    const blocked = await post(`${second}/enrollments/redeem`, proof(approved()), adminToken, { 'X-Forwarded-For': '198.51.100.3' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(await redis.keys('codeapi:bridge:v1:credential:*')).toHaveLength(0);
  });
});
