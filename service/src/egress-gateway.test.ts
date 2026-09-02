process.env.CODEAPI_EGRESS_GATEWAY_AUTOSTART = 'false';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import RedisMock from 'ioredis-mock';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { env } from './config';
import {
  assertEgressGrantActive,
  createEgressLedger,
  setEgressLedgerRedisForTest,
} from './egress-ledger';
import {
  EGRESS_GRANT_HEADER,
  openEgressHandle,
  openEgressGrant,
  sealEgressGrant,
  sealEgressHandle,
  sealPtcCallbackToken,
  type EgressGrantClaims,
} from './egress-grant';
import { INTERNAL_SERVICE_TOKEN_HEADER } from './internal-service-auth';
import type * as t from './types';

const { app } = await import('./egress-gateway');

const SECRET = 'test-egress-gateway-secret-32-bytes';
const INTERNAL_TOKEN = 'internal-token';
const TOKEN_PREFIX = 'ceg1';
const AAD = Buffer.from('codeapi-egress-grant:v1', 'utf8');
const originalFetch = globalThis.fetch;

type UpstreamCall = {
  url: string;
  init: RequestInit;
};

let server: Server;
let baseUrl: string;
let upstreamCalls: UpstreamCall[] = [];
let upstreamResponse: globalThis.Response;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function claims(overrides: Partial<EgressGrantClaims> = {}): EgressGrantClaims {
  const now = nowSeconds();
  return {
    v: 1,
    typ: 'grant',
    grant_id: 'grant_123',
    exec_id: 'exec_123',
    tenant_id: 'tenant_abc',
    user_id: 'user_123',
    session_key: 'tenant:tenant_abc:user:user_123',
    input_files: [{ id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' }],
    read_sessions: ['sess_input'],
    output_session_id: 'sess_output',
    max_upload_bytes: 1024,
    max_output_files: 10,
    max_requests: 100,
    iat: now - 10,
    exp: now + 300,
    principal_source: 'librechat',
    auth_context_hash: 'hash_123',
    ...overrides,
  };
}

function grantHeader(grant: EgressGrantClaims = claims()): Record<string, string> {
  return { [EGRESS_GRANT_HEADER]: sealEgressGrant(grant, SECRET) };
}

function sealRawEgressToken(claims: unknown): string {
  const key = crypto.createHash('sha256').update(SECRET, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(claims), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_PREFIX,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function legacyGrantToken(overrides: Partial<EgressGrantClaims> = {}): string {
  const {
    grant_id: _grantId,
    legacy_grant: _legacyGrant,
    max_output_files: _maxOutputFiles,
    max_requests: _maxRequests,
    ...legacyClaims
  } = claims(overrides);
  return sealRawEgressToken(legacyClaims);
}

function executionClaims(): Omit<EgressGrantClaims, 'typ' | 'grant_id'> {
  const { typ: _typ, grant_id: _grantId, ...rest } = claims();
  return rest;
}

function payload(): t.PayloadBody {
  return {
    language: 'python',
    version: '3.14.4',
    session_id: 'sess_output',
    files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
  };
}

function sessionHandle(args: { dir: 'read' | 'write'; sessionId: string; execId?: string; grantId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'session',
    dir: args.dir,
    grant_id: args.grantId ?? 'grant_123',
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId,
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function legacySessionHandle(args: { dir: 'read' | 'write'; sessionId: string; execId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'session',
    dir: args.dir,
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId,
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function objectHandle(args: { fileId?: string; sessionId?: string; name?: string; execId?: string; grantId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'object',
    dir: 'read',
    grant_id: args.grantId ?? 'grant_123',
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId ?? 'sess_input',
    object_id: args.fileId ?? 'file_123',
    name: args.name ?? 'inputs/data.csv',
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function legacyObjectHandle(args: { fileId?: string; sessionId?: string; name?: string; execId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'object',
    dir: 'read',
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId ?? 'sess_input',
    object_id: args.fileId ?? 'file_123',
    name: args.name ?? 'inputs/data.csv',
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

async function gatewayFetch(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return originalFetch(`${baseUrl}${path}`, init);
}

beforeAll(() => {
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  env.EGRESS_GRANT_SECRET = SECRET;
  env.EGRESS_GATEWAY_FILE_SERVER_URL = 'http://file-server';
  env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = 'http://tool-call-server';
  env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES = 128;
  env.EGRESS_GATEWAY_MAX_FILE_BYTES = 10_000_000;
  env.EGRESS_GATEWAY_MAX_PATH_LENGTH = 256;
  env.EGRESS_GATEWAY_MAX_NESTING_DEPTH = 10;
  env.EGRESS_LEDGER_REQUIRED = false;
  process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
  upstreamCalls = [];
  upstreamResponse = new Response('ok', { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstreamCalls.push({ url: String(input), init: init ?? {} });
    return upstreamResponse;
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server.close();
  delete process.env.CODEAPI_INTERNAL_SERVICE_TOKEN;
});

describe('egress gateway routes', () => {
  test('protects internal grant create, restore, and revoke routes', async () => {
    const createBody = JSON.stringify({ payload: payload(), claims: executionClaims() });
    const unauthorized = await gatewayFetch('/internal/egress-grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createBody,
    });
    expect(unauthorized.status).toBe(401);

    const created = await gatewayFetch('/internal/egress-grants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: createBody,
    });
    expect(created.status).toBe(201);
    const prepared = await created.json() as {
      grant_id: string;
      payload: t.PayloadBody;
      egressGrantToken: string;
    };
    expect(openEgressGrant(prepared.egressGrantToken, SECRET).grant_id).toBe(prepared.grant_id);
    expect((prepared.payload.files[0] as { id: string }).id).not.toBe('file_123');
    expect((prepared.payload.files[0] as { storage_session_id: string }).storage_session_id).not.toBe('sess_input');

    const restored = await gatewayFetch(`/internal/egress-grants/${prepared.grant_id}/restore-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        egressGrantToken: prepared.egressGrantToken,
        result: {
          session_id: prepared.payload.output_session_id,
          files: [{
            id: (prepared.payload.files[0] as { id: string }).id,
            storage_session_id: (prepared.payload.files[0] as { storage_session_id: string }).storage_session_id,
            name: 'inputs/data.csv',
          }],
        },
      }),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      result: {
        session_id: 'sess_output',
        files: [{ id: 'file_123', storage_session_id: 'sess_input' }],
      },
    });

    const tokenOnlyRestored = await gatewayFetch('/internal/egress-grants/restore-result', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        egressGrantToken: prepared.egressGrantToken,
        result: {
          session_id: prepared.payload.output_session_id,
          files: [{
            id: (prepared.payload.files[0] as { id: string }).id,
            storage_session_id: (prepared.payload.files[0] as { storage_session_id: string }).storage_session_id,
            name: 'inputs/data.csv',
          }],
        },
      }),
    });
    expect(tokenOnlyRestored.status).toBe(200);
    expect(await tokenOnlyRestored.json()).toMatchObject({
      result: {
        session_id: 'sess_output',
        files: [{ id: 'file_123', storage_session_id: 'sess_input' }],
      },
    });

    const tokenOnlyRevoked = await gatewayFetch('/internal/egress-grants/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        egressGrantToken: prepared.egressGrantToken,
        reason: 'completed',
      }),
    });
    expect(tokenOnlyRevoked.status).toBe(204);

    const revoked = await gatewayFetch(`/internal/egress-grants/${prepared.grant_id}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({ reason: 'completed' }),
    });
    expect(revoked.status).toBe(204);
  });

  test('fails closed for gateway internal routes when internal auth is not configured', async () => {
    delete process.env.CODEAPI_INTERNAL_SERVICE_TOKEN;
    const create = await gatewayFetch('/internal/egress-grants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({ payload: payload(), claims: executionClaims() }),
    });
    expect(create.status).toBe(503);

    const ptcToken = await gatewayFetch('/internal/ptc-callback-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        executionId: 'exec_123',
        sessionId: 'sess_output',
        callbackToken: 'callback-secret',
        timeoutSeconds: 60,
        allowedToolNames: ['query'],
      }),
    });
    expect(ptcToken.status).toBe(503);
  });

  test('creates internal PTC callback tokens with tool allowlists', async () => {
    const created = await gatewayFetch('/internal/ptc-callback-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        executionId: 'exec_123',
        sessionId: 'tool_session',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: 30,
        allowedToolNames: ['query_clickhouse'],
      }),
    });
    expect(created.status).toBe(201);
    const tokenBody = await created.json() as { callbackToken: string; grant_id: string };
    expect(tokenBody.grant_id).toBeTruthy();

    upstreamResponse = Response.json({ success: true, result: 'ok' });
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: {} });
    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': tokenBody.callbackToken,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(header(upstreamCalls[0].init, 'X-Callback-Token')).toBe('raw-callback-token');
  });

  test('rejects malformed PTC callback token timeouts before minting', async () => {
    const invalid = await gatewayFetch('/internal/ptc-callback-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        executionId: 'exec_123',
        sessionId: 'tool_session',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: 'not-a-number',
      }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'timeoutSeconds must be a finite positive number' });

    const nullTimeout = await gatewayFetch('/internal/ptc-callback-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        executionId: 'exec_123',
        sessionId: 'tool_session',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: null,
      }),
    });
    expect(nullTimeout.status).toBe(400);
  });

  test('keeps liveness process-local while health and readiness fail closed on ledger outage', async () => {
    const redis = {
      ping: async () => {
        throw new Error('redis unavailable');
      },
    };
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    try {
      const live = await gatewayFetch('/live');
      const health = await gatewayFetch('/health');
      const ready = await gatewayFetch('/ready');

      expect(live.status).toBe(200);
      expect(health.status).toBe(503);
      expect(ready.status).toBe(503);
    } finally {
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('lists only scoped objects and injects internal credentials', async () => {
    upstreamResponse = Response.json([
      { id: 'file_123', name: 'inputs/data.csv', storage_session_id: 'sess_input' },
      { id: 'file_999', name: 'inputs/other.csv', storage_session_id: 'sess_input' },
      { id: 'dirkeep_1', name: 'inputs/.dirkeep', storage_session_id: 'sess_input' },
      { id: 'dirkeep_2', name: 'unrelated/.dirkeep', storage_session_id: 'sess_input' },
    ]);
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects?detail=normalized`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ id: string; storage_session_id: string; name: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('inputs/data.csv');
    expect(body[0].storage_session_id).toBe(readSession);
    expect(openEgressHandle(body[0].id, SECRET)).toMatchObject({ typ: 'object', object_id: 'file_123' });
    expect(body[1].name).toBe('inputs/.dirkeep');
    expect(openEgressHandle(body[1].id, SECRET)).toMatchObject({ typ: 'object', object_id: 'dirkeep_1' });
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_input/objects?detail=normalized');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
    expect(header(upstreamCalls[0].init, EGRESS_GRANT_HEADER)).toBeUndefined();
  });

  test('accepts legacy rollout grants and handles while ledger-required mode is enabled', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    try {
      const token = legacyGrantToken();
      const legacyGrant = openEgressGrant(token, SECRET);
      const readSession = legacySessionHandle({ dir: 'read', sessionId: 'sess_input' });
      upstreamResponse = Response.json([
        { id: 'file_123', name: 'inputs/data.csv', storage_session_id: 'sess_input' },
      ]);

      const listed = await gatewayFetch(`/sessions/${readSession}/objects?detail=normalized`, {
        headers: { [EGRESS_GRANT_HEADER]: token },
      });

      expect(listed.status).toBe(200);
      const body = await listed.json() as Array<{ id: string; storage_session_id: string; name: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].storage_session_id).toBe(readSession);
      expect(openEgressHandle(body[0].id, SECRET)).toMatchObject({
        typ: 'object',
        grant_id: legacyGrant.grant_id,
        object_id: 'file_123',
      });

      const record = await assertEgressGrantActive(legacyGrant);
      expect(record.request_count).toBe(1);
      expect(record.read_count).toBe(1);
      expect(record.max_output_files).toBe(50);
      expect(record.max_requests).toBe(1000);
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('restores token-only legacy grants and creates ledger state before returning handles', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    try {
      const token = legacyGrantToken();
      const legacyGrant = openEgressGrant(token, SECRET);
      const response = await gatewayFetch('/internal/egress-grants/restore-result', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN,
        },
        body: JSON.stringify({
          egressGrantToken: token,
          result: {
            session_id: legacySessionHandle({ dir: 'write', sessionId: 'sess_output' }),
            files: [{
              id: legacyObjectHandle({}),
              storage_session_id: legacySessionHandle({ dir: 'read', sessionId: 'sess_input' }),
              name: 'inputs/data.csv',
            }],
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          session_id: 'sess_output',
          files: [{ id: 'file_123', storage_session_id: 'sess_input' }],
        },
      });
      const record = await assertEgressGrantActive(legacyGrant);
      expect(record.grant_id).toBe(legacyGrant.grant_id);
      expect(record.exec_id).toBe('exec_123');
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('rejects grantless handles for non-legacy grants in ledger-required mode', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    try {
      const grant = claims();
      await createEgressLedger(grant);
      const readSession = legacySessionHandle({ dir: 'read', sessionId: 'sess_input' });
      const object = legacyObjectHandle({});

      const response = await gatewayFetch(`/sessions/${readSession}/objects/${object}`, {
        headers: grantHeader(grant),
      });

      expect(response.status).toBe(403);
      expect(upstreamCalls).toHaveLength(0);
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('keeps read allowlists exact when user uploads and prior outputs share a turn', async () => {
    const grant = claims({
      input_files: [
        { id: 'user_file', session_id: 'sess_user_uploads', name: 'uploads/source.csv' },
        { id: 'generated_file', session_id: 'sess_turn_1_output', name: 'analysis/summary.json' },
      ],
      read_sessions: ['sess_user_uploads', 'sess_turn_1_output'],
    });
    upstreamResponse = Response.json([
      { id: 'user_file', name: 'uploads/source.csv', storage_session_id: 'sess_user_uploads' },
      { id: 'cross_turn_leak', name: 'uploads/other.csv', storage_session_id: 'sess_user_uploads' },
      { id: 'dirkeep_uploads', name: 'uploads/.dirkeep', storage_session_id: 'sess_user_uploads' },
    ]);
    const uploadSession = sessionHandle({ dir: 'read', sessionId: 'sess_user_uploads' });

    const uploadList = await gatewayFetch(`/sessions/${uploadSession}/objects?detail=normalized`, {
      headers: grantHeader(grant),
    });

    expect(uploadList.status).toBe(200);
    const uploadBody = await uploadList.json() as Array<{ name: string }>;
    expect(uploadBody.map(file => file.name)).toEqual(['uploads/source.csv', 'uploads/.dirkeep']);

    upstreamResponse = Response.json([
      { id: 'generated_file', name: 'analysis/summary.json', storage_session_id: 'sess_turn_1_output' },
      { id: 'generated_other', name: 'analysis/private.json', storage_session_id: 'sess_turn_1_output' },
      { id: 'dirkeep_analysis', name: 'analysis/.dirkeep', storage_session_id: 'sess_turn_1_output' },
    ]);
    const priorOutputSession = sessionHandle({ dir: 'read', sessionId: 'sess_turn_1_output' });

    const priorOutputList = await gatewayFetch(`/sessions/${priorOutputSession}/objects?detail=normalized`, {
      headers: grantHeader(grant),
    });

    expect(priorOutputList.status).toBe(200);
    const priorOutputBody = await priorOutputList.json() as Array<{ name: string }>;
    expect(priorOutputBody.map(file => file.name)).toEqual(['analysis/summary.json', 'analysis/.dirkeep']);

    const leakObject = objectHandle({
      fileId: 'generated_other',
      sessionId: 'sess_turn_1_output',
      name: 'analysis/private.json',
    });
    const rejected = await gatewayFetch(`/sessions/${priorOutputSession}/objects/${leakObject}`, {
      headers: grantHeader(grant),
    });
    expect(rejected.status).toBe(403);
    expect(upstreamCalls.map(call => call.url)).toEqual([
      'http://file-server/sessions/sess_user_uploads/objects?detail=normalized',
      'http://file-server/sessions/sess_turn_1_output/objects?detail=normalized',
    ]);
  });

  test('rejects unsupported list query params before delegation', async () => {
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects?detail=raw`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('downloads scoped objects by unwrapping handles', async () => {
    upstreamResponse = new Response('file-body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': "attachment; filename*=UTF-8''file_123.csv",
      },
    });
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });
    const object = objectHandle({});

    const response = await gatewayFetch(`/sessions/${readSession}/objects/${object}`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('file-body');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_input/objects/file_123');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
  });

  test('preserves an authoritative upstream download filename', async () => {
    upstreamResponse = new Response('file-body', {
      status: 200,
      headers: {
        'Content-Disposition': "attachment; filename*=UTF-8''reports%2Fdata.csv",
      },
    });
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });
    const object = objectHandle({});

    const response = await gatewayFetch(`/sessions/${readSession}/objects/${object}`, {
      headers: grantHeader(),
    });

    expect(response.headers.get('content-disposition'))
      .toBe("attachment; filename*=UTF-8''reports%2Fdata.csv");
  });

  test('downloads required dirkeep markers without allowing unrelated markers', async () => {
    upstreamResponse = new Response('marker-body', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });
    const requiredMarker = objectHandle({ fileId: 'dirkeep_1', name: 'inputs/.dirkeep' });
    const unrelatedMarker = objectHandle({ fileId: 'dirkeep_2', name: 'unrelated/.dirkeep' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects/${requiredMarker}`, {
      headers: grantHeader(),
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_input/objects/dirkeep_1');

    const rejected = await gatewayFetch(`/sessions/${readSession}/objects/${unrelatedMarker}`, {
      headers: grantHeader(),
    });
    expect(rejected.status).toBe(403);
    expect(upstreamCalls).toHaveLength(1);
  });

  test('rejects read object handles whose name does not match the exact allowlist tuple', async () => {
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });
    const object = objectHandle({ name: 'inputs/renamed.csv' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects/${object}`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('enforces upload byte limits before delegation', async () => {
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const response = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(claims({ max_upload_bytes: 3 })),
        'Content-Type': 'text/plain',
        'Content-Length': '4',
        'X-Original-Filename': 'out.txt',
      },
      body: 'abcd',
    });

    expect(response.status).toBe(413);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('rejects invalid output filenames before delegation', async () => {
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const traversal = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': encodeURIComponent('../secret.txt'),
      },
      body: 'abc',
    });
    expect(traversal.status).toBe(400);

    const unsupported = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstv`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': '3',
        'X-Original-Filename': 'payload.exe',
      },
      body: 'abc',
    });
    expect(unsupported.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('allows supported extensionless output basenames before delegation', async () => {
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const dockerfile = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': 'Dockerfile',
      },
      body: 'abc',
    });
    expect(dockerfile.status).toBe(200);

    upstreamResponse = new Response('ok', { status: 200 });
    const jenkinsfile = await gatewayFetch(`/sessions/${writeSession}/objects/bcdefghijklmnopqrstuv`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': 'ci/Jenkinsfile',
      },
      body: 'abc',
    });
    expect(jenkinsfile.status).toBe(200);

    upstreamResponse = new Response('ok', { status: 200 });
    const vagrantfile = await gatewayFetch(`/sessions/${writeSession}/objects/cdefghijklmnopqrstuvw`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': 'infra/Vagrantfile',
      },
      body: 'abc',
    });
    expect(vagrantfile.status).toBe(200);
    expect(upstreamCalls).toHaveLength(3);
  });

  test('uploads scoped output files with injected internal credentials', async () => {
    upstreamResponse = Response.json({ id: 'abcdefghijklmnopqrstu' }, { status: 201 });
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const response = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': 'out.txt',
      },
      body: 'abc',
    });

    expect(response.status).toBe(201);
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_output/objects/abcdefghijklmnopqrstu');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
    expect(header(upstreamCalls[0].init, 'X-Original-Filename')).toBe('out.txt');
  });

  test('rolls back upload reservations when upstream PUT throws', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    const grant = claims({ max_output_files: 1, max_requests: 3 });
    await createEgressLedger(grant);
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });
    const fileId = 'abcdefghijklmnopqrstu';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init: init ?? {} });
      throw new Error('upstream connection reset');
    }) as unknown as typeof fetch;

    try {
      const failed = await gatewayFetch(`/sessions/${writeSession}/objects/${fileId}`, {
        method: 'PUT',
        headers: {
          ...grantHeader(grant),
          'Content-Type': 'text/plain',
          'Content-Length': '3',
          'X-Original-Filename': 'out.txt',
        },
        body: 'abc',
      });
      expect(failed.status).toBe(500);

      upstreamResponse = Response.json({ id: fileId }, { status: 201 });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        upstreamCalls.push({ url: String(input), init: init ?? {} });
        return upstreamResponse;
      }) as unknown as typeof fetch;

      const retried = await gatewayFetch(`/sessions/${writeSession}/objects/${fileId}`, {
        method: 'PUT',
        headers: {
          ...grantHeader(grant),
          'Content-Type': 'text/plain',
          'Content-Length': '3',
          'X-Original-Filename': 'out.txt',
        },
        body: 'abc',
      });

      expect(retried.status).toBe(201);
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('does not roll back ledger state when upload reservation is rejected', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true }, { status: 201 });
    }) as unknown as typeof fetch;

    const grant = claims({ max_output_files: 1, max_requests: 5 });
    await createEgressLedger(grant);
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    async function upload(fileId: string): Promise<number> {
      const response = await gatewayFetch(`/sessions/${writeSession}/objects/${fileId}`, {
        method: 'PUT',
        headers: {
          ...grantHeader(grant),
          'Content-Type': 'text/plain',
          'Content-Length': '3',
          'X-Original-Filename': `${fileId}.txt`,
        },
        body: 'abc',
      });
      return response.status;
    }

    try {
      expect(await upload('aaaaaaaaaaaaaaaaaaaaa')).toBe(201);
      expect(await upload('aaaaaaaaaaaaaaaaaaaaa')).toBe(403);
      expect(await upload('bbbbbbbbbbbbbbbbbbbbb')).toBe(403);
      expect(upstreamCalls).toHaveLength(1);
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('enforces output budgets per turn when grants reuse an output session', async () => {
    const redis = new RedisMock();
    env.EGRESS_LEDGER_REQUIRED = true;
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true }, { status: 201 });
    }) as unknown as typeof fetch;

    async function upload(grant: EgressGrantClaims, fileId: string): Promise<number> {
      const writeSession = sessionHandle({
        dir: 'write',
        sessionId: 'sess_shared_output',
        grantId: grant.grant_id,
      });
      const response = await gatewayFetch(`/sessions/${writeSession}/objects/${fileId}`, {
        method: 'PUT',
        headers: {
          ...grantHeader(grant),
          'Content-Type': 'text/plain',
          'Content-Length': '3',
          'X-Original-Filename': `${fileId}.txt`,
        },
        body: 'abc',
      });
      return response.status;
    }

    try {
      const firstTurn = claims({
        grant_id: 'grant_turn_1',
        output_session_id: 'sess_shared_output',
        max_output_files: 2,
        max_requests: 5,
      });
      await createEgressLedger(firstTurn);
      expect(await upload(firstTurn, 'aaaaaaaaaaaaaaaaaaaaa')).toBe(201);
      expect(await upload(firstTurn, 'bbbbbbbbbbbbbbbbbbbbb')).toBe(201);
      expect(await upload(firstTurn, 'ccccccccccccccccccccc')).toBe(403);

      const secondTurn = claims({
        grant_id: 'grant_turn_2',
        output_session_id: 'sess_shared_output',
        max_output_files: 1,
        max_requests: 5,
      });
      await createEgressLedger(secondTurn);
      expect(await upload(secondTurn, 'ddddddddddddddddddddd')).toBe(201);
      expect(await upload(secondTurn, 'eeeeeeeeeeeeeeeeeeeee')).toBe(403);
    } finally {
      await redis.disconnect();
      setEgressLedgerRedisForTest(null);
      env.EGRESS_LEDGER_REQUIRED = false;
    }
  });

  test('forwards PTC calls with unwrapped callback tokens', async () => {
    upstreamResponse = Response.json({ success: true, result: 'ok' });
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: { sql: 'SELECT 1' } });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(upstreamCalls[0].url).toBe('http://tool-call-server/tool-call');
    expect(header(upstreamCalls[0].init, 'X-Execution-ID')).toBe('exec_123');
    expect(header(upstreamCalls[0].init, 'X-Tool-Call-ID')).toBe('call_001');
    expect(header(upstreamCalls[0].init, 'X-Callback-Token')).toBe('raw-callback-token');
  });

  test('rejects PTC callbacks whose execution does not match the request', async () => {
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: {} });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_other',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('rejects PTC callbacks outside the token tool allowlist', async () => {
    const body = JSON.stringify({ tool_name: 'forbidden_tool', input: {} });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      allowedToolNames: ['query_clickhouse'],
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('rejects PTC callbacks when the token carries an explicit empty tool allowlist', async () => {
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: {} });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      allowedToolNames: [],
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('rejects malformed PTC JSON as a client error when tool allowlists are enforced', async () => {
    const body = '{';
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      allowedToolNames: ['query_clickhouse'],
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Malformed PTC tool-call JSON' });
    expect(upstreamCalls).toHaveLength(0);
  });
});
