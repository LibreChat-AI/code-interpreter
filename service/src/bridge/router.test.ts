import { createServer, type Server } from 'http';

import { afterEach, describe, expect, test } from 'bun:test';
import express, { json } from 'express';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';

import {
  createBridgeIdentity,
  signBridgeRequest,
} from '../../../packages/code/src/identity';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { RedisBridgePairingStore } from './pairing';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
let server: Server | undefined;

afterEach(async () => {
  server?.close();
  server = undefined;
  await redis.flushall();
});

describe('paired bridge HTTP API', () => {
  test('rejects a malformed optional binding for a configured worker', async () => {
    const app = express();
    app.use(json());
    app.use(
      '/v1/bridge',
      createBridgeRouter({
        store: new RedisBridgeStore(redis),
        pairings: new RedisBridgePairingStore(redis),
        authMode: 'paired',
        adminToken: 'strong-administrator-bootstrap-token',
        configuredWorkerId: 'vm-1',
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/bridge/pairings`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer strong-administrator-bootstrap-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workerId: 'vm-1',
          binding: { tenantId: 'tenant-1', principal: { type: 'user' } },
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  test('requires and persists a trusted principal binding for dynamic workers', async () => {
    const store = new RedisBridgeStore(redis);
    const app = express();
    app.use(json());
    app.use(
      '/v1/bridge',
      createBridgeRouter({
        store,
        pairings: new RedisBridgePairingStore(redis),
        authMode: 'paired',
        adminToken: 'strong-administrator-bootstrap-token',
        allowDynamicWorkers: true,
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/v1/bridge`;
    const unboundResponse = await fetch(`${baseUrl}/pairings`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer strong-administrator-bootstrap-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workerId: 'user-vm' }),
    });
    expect(unboundResponse.status).toBe(400);

    const binding = {
      tenantId: 'tenant-1',
      principal: { type: 'user' as const, id: 'user-1' },
    };
    const pairingResponse = await fetch(`${baseUrl}/pairings`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer strong-administrator-bootstrap-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workerId: 'user-vm', binding }),
    });
    const pairing = (await pairingResponse.json()) as { code: string };
    expect(pairingResponse.status).toBe(200);

    const identity = createBridgeIdentity();
    const redemptionResponse = await fetch(`${baseUrl}/pairings/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'user-vm',
        code: pairing.code,
        publicKey: identity.publicKey,
      }),
    });
    const issued = (await redemptionResponse.json()) as { credential: string };
    expect(redemptionResponse.status).toBe(200);

    const path = '/v1/bridge/workers/register';
    const body = JSON.stringify({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'user-vm',
      incarnationId: 'incarnation-00000001',
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
      binding: {
        tenantId: 'tenant-2',
        principal: { type: 'user', id: 'attacker-selected-user' },
      },
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path,
      timestamp: new Date().toISOString(),
      nonce: 'dynamic-registration-nonce',
      body,
    };
    const registrationResponse = await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bridge ${issued.credential}`,
          'Content-Type': 'application/json',
          'X-LibreChat-Code-Timestamp': proof.timestamp,
          'X-LibreChat-Code-Nonce': proof.nonce,
          'X-LibreChat-Code-Signature': signBridgeRequest(
            identity.privateKey,
            proof,
          ),
        },
        body,
      },
    );
    expect(registrationResponse.status).toBe(200);
    await expect(
      store.dispatch({
        workerId: 'user-vm',
        tenantId: binding.tenantId,
        requireTenantBinding: true,
        body: { language: 'bash' } as never,
        headers: {},
        runtimeSessionId: 'stateful-session',
        deadlineAtMs: Date.now() + 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });

    await expect(
      store.dispatch({
        workerId: 'user-vm',
        tenantId: 'tenant-2',
        requireTenantBinding: true,
        body: { language: 'bash' } as never,
        headers: {},
        deadlineAtMs: Date.now() + 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_UNAUTHORIZED' });
  });

  test('pairs a worker and accepts its proof-of-possession registration', async () => {
    const app = express();
    const store = new RedisBridgeStore(redis);
    app.use(json());
    app.use(
      '/v1/bridge',
      createBridgeRouter({
        store,
        pairings: new RedisBridgePairingStore(redis),
        authMode: 'paired',
        adminToken: 'strong-administrator-bootstrap-token',
        configuredWorkerId: 'vm-1',
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/v1/bridge`;
    const pairingResponse = await fetch(`${baseUrl}/pairings`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer strong-administrator-bootstrap-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workerId: 'vm-1' }),
    });
    const pairing = (await pairingResponse.json()) as { code: string };
    expect(pairingResponse.status).toBe(200);

    const identity = createBridgeIdentity();
    const redemptionResponse = await fetch(`${baseUrl}/pairings/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'vm-1',
        code: pairing.code,
        publicKey: identity.publicKey,
      }),
    });
    const issued = (await redemptionResponse.json()) as {
      credential: string;
    };
    expect(redemptionResponse.status).toBe(200);

    const path = '/v1/bridge/workers/register';
    const body = JSON.stringify({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'nsjail',
        runtimes: ['bash'],
      },
    });
    const proof = {
      credential: issued.credential,
      method: 'POST',
      path,
      timestamp: new Date().toISOString(),
      nonce: 'http-registration-nonce',
      body,
    };
    const headers = {
      Authorization: `Bridge ${issued.credential}`,
      'Content-Type': 'application/json',
      'X-LibreChat-Code-Timestamp': proof.timestamp,
      'X-LibreChat-Code-Nonce': proof.nonce,
      'X-LibreChat-Code-Signature': signBridgeRequest(
        identity.privateKey,
        proof,
      ),
    };
    const registrationUrl = `http://127.0.0.1:${address.port}${path}`;
    const registrationResponse = await fetch(registrationUrl, {
      method: 'POST',
      headers,
      body,
    });

    expect(registrationResponse.status).toBe(200);
    await expect(registrationResponse.json()).resolves.toMatchObject({
      workerId: 'vm-1',
      incarnationId: 'incarnation-00000001',
      registrationGeneration: 1,
      supportedWorkspaceToolOperations: [
        'read_file',
        'search_text',
        'list_files',
        'write_file',
        'edit_file',
        'execute_command',
      ],
      supportedWorkspaceWriteFileModes: ['replace', 'create'],
      supportedWorkspaceEditFileModes: ['single', 'batch'],
    });

    const crossDeploymentRevoke = await fetch(
      `${baseUrl}/workers/another-deployments-worker/revoke`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer strong-administrator-bootstrap-token',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(crossDeploymentRevoke.status).toBe(400);

    const replayResponse = await fetch(registrationUrl, {
      method: 'POST',
      headers,
      body,
    });
    expect(replayResponse.status).toBe(401);
    await expect(replayResponse.json()).resolves.toMatchObject({
      code: 'PROOF_REPLAYED',
    });

    const revokeResponse = await fetch(`${baseUrl}/workers/vm-1/revoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer strong-administrator-bootstrap-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(revokeResponse.status).toBe(200);
    await expect(
      store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'vm-1',
        incarnationId: 'incarnation-00000001',
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'nsjail',
          runtimes: ['bash'],
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_FENCED' });
  });

  test('forwards pairing store failures to Express error middleware', async () => {
    const app = express();
    const pairings = new RedisBridgePairingStore(redis);
    pairings.issue = async () => {
      throw new Error('pairing store unavailable');
    };
    app.use(json());
    app.use(
      '/v1/bridge',
      createBridgeRouter({
        store: new RedisBridgeStore(redis),
        pairings,
        authMode: 'paired',
        adminToken: 'strong-administrator-bootstrap-token',
        configuredWorkerId: 'vm-1',
      }),
    );
    app.use(
      (
        error: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(503).json({ error: error.message });
      },
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/bridge/pairings`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer strong-administrator-bootstrap-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workerId: 'vm-1' }),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'pairing store unavailable',
    });
  });

  test('does not treat a missing configured worker ID as a wildcard', async () => {
    const app = express();
    app.use(json());
    app.use(
      '/v1/bridge',
      createBridgeRouter({
        store: new RedisBridgeStore(redis),
        pairings: new RedisBridgePairingStore(redis),
        authMode: 'paired',
        adminToken: 'strong-administrator-bootstrap-token',
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/bridge/pairings`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer strong-administrator-bootstrap-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workerId: 'vm-1' }),
      },
    );

    expect(response.status).toBe(400);
  });
});
