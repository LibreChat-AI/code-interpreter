import { randomBytes } from 'node:crypto';

import { signBridgeRecovery, signBridgeRecoveryStart } from './identity.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  bridgeWorkerPath,
} from './protocol.js';
import type {
  BridgeRecoveryChallengeResponse,
  BridgeWorkerCredentialResponse,
} from './protocol.js';

interface RecoverWorkerCredentialOptions {
  codeApiUrl: string;
  workerId: string;
  privateKey: string;
  validThroughMs: number;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}

const MAX_RESPONSE_BYTES = 8192;
const MAX_CHALLENGE_LIFETIME_MS = 6 * 60_000;

async function responsePayload(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new BridgeProtocolError(
      'Code API returned an empty machine recovery response',
      502,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new BridgeProtocolError(
          'Code API machine recovery response exceeds 8 KiB',
          502,
        );
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      throw new BridgeProtocolError(
        'Code API returned an invalid machine recovery response',
        502,
      );
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function recoveryRequest(
  url: string,
  body: object,
  options: RecoverWorkerCredentialOptions,
): Promise<unknown> {
  options.signal.throwIfAborted();
  const response = await options.fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    // Older/disabled servers may return HTML. Do not echo untrusted response text.
    let payload: unknown;
    try {
      payload = await responsePayload(response);
    } catch {
      /* Status is sufficient. */
    }
    options.signal.throwIfAborted();
    if (response.status === 404 || response.status === 405) {
      throw new BridgeProtocolError(
        'Machine credential expired or is unavailable. This Code API does not support enabled machine recovery; enable durable enrollment or approve a new pairing in LibreChat.',
        401,
        'RECOVERY_UNAVAILABLE',
      );
    }
    const code =
      record(payload) &&
      typeof payload.code === 'string' &&
      [
        'ENROLLMENT_INVALID',
        'PROOF_INVALID',
        'PROOF_REPLAYED',
        'CHALLENGE_INVALID',
        'RECOVERY_RATE_LIMITED',
      ].includes(payload.code)
        ? payload.code
        : undefined;
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    throw new BridgeProtocolError(
      code === 'ENROLLMENT_INVALID'
        ? 'Machine enrollment is unavailable or revoked. Approve a new pairing in LibreChat; recovery cannot restore revoked access.'
        : `Machine credential recovery failed with HTTP ${response.status}${retryable ? '; reconnect will retry' : '; check enrollment and approve a new pairing in LibreChat if needed'}`,
      retryable ? response.status : response.status === 403 ? 403 : 401,
      code,
    );
  }
  const payload = await responsePayload(response);
  options.signal.throwIfAborted();
  return payload;
}

/** Recover only existing enrollment. Never pair, replace a key, or reset workspace state. */
export async function recoverWorkerCredential(
  options: RecoverWorkerCredentialOptions,
): Promise<BridgeWorkerCredentialResponse> {
  options.signal.throwIfAborted();
  const server = new URL(options.codeApiUrl);
  if (
    server.protocol !== 'https:' ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.origin.length > 256
  ) {
    throw new BridgeProtocolError(
      'Automatic machine recovery requires the enrolled Code API HTTPS origin; use the existing pairing flow for this endpoint.',
      401,
      'RECOVERY_UNAVAILABLE',
    );
  }
  const url = `${options.codeApiUrl.replace(/\/+$/, '')}${bridgeWorkerPath(options.workerId)}/credentials`;
  const start = {
    operation: 'credential.challenge' as const,
    serverId: server.origin,
    workerId: options.workerId,
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
  };
  const payload = await recoveryRequest(
    `${url}/challenge`,
    {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ...start,
      signature: signBridgeRecoveryStart(options.privateKey, start),
    },
    options,
  );
  if (
    !record(payload) ||
    payload.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    payload.operation !== 'credential.recover' ||
    payload.serverId !== server.origin ||
    payload.workerId !== options.workerId ||
    typeof payload.enrollmentGeneration !== 'string' ||
    !/^[A-Za-z0-9_-]{24}$/.test(payload.enrollmentGeneration) ||
    typeof payload.challenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.challenge) ||
    typeof payload.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.expiresAt)) ||
    Date.parse(payload.expiresAt) <= Date.now() ||
    Date.parse(payload.expiresAt) > Date.now() + MAX_CHALLENGE_LIFETIME_MS
  ) {
    throw new BridgeProtocolError(
      'Code API returned an invalid machine recovery challenge',
      502,
    );
  }
  // Sign only the validated recovery operation, never arbitrary server-supplied fields.
  const challenge: BridgeRecoveryChallengeResponse = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'credential.recover',
    serverId: server.origin,
    workerId: options.workerId,
    enrollmentGeneration: payload.enrollmentGeneration,
    challenge: payload.challenge,
    expiresAt: payload.expiresAt,
  };
  const credential = await recoveryRequest(
    `${url}/recover`,
    {
      ...challenge,
      signature: signBridgeRecovery(options.privateKey, challenge),
    },
    options,
  );
  if (
    !record(credential) ||
    credential.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    credential.workerId !== options.workerId ||
    typeof credential.credential !== 'string' ||
    credential.credential.length < 32 ||
    credential.credential.length > 4096 ||
    typeof credential.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(credential.expiresAt)) ||
    Date.parse(credential.expiresAt) <= options.validThroughMs
  ) {
    throw new BridgeProtocolError(
      'Code API returned an invalid recovered worker credential',
      502,
    );
  }
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: options.workerId,
    credential: credential.credential,
    expiresAt: credential.expiresAt,
  };
}
