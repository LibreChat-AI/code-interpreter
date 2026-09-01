import { createBridgeIdentity } from './identity.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
} from './protocol.js';

import type { BridgeWorkerCredentialResponse } from './protocol.js';

export interface PairBridgeWorkerOptions {
  codeApiUrl: string;
  workerId: string;
  code: string;
  fetchImpl?: typeof fetch;
}

export interface PairedBridgeWorkerIdentity
  extends BridgeWorkerCredentialResponse {
  codeApiUrl: string;
  publicKey: string;
  privateKey: string;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(value: object): string | undefined {
  if ('error' in value && typeof value.error === 'string') return value.error;
  return undefined;
}

export async function pairBridgeWorker(
  options: PairBridgeWorkerOptions,
): Promise<PairedBridgeWorkerIdentity> {
  const codeApiUrl = normalizedBaseUrl(options.codeApiUrl);
  const identity = createBridgeIdentity();
  const response = await (options.fetchImpl ?? fetch)(
    `${codeApiUrl}/bridge/pairings/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: options.workerId,
        code: options.code,
        publicKey: identity.publicKey,
      }),
    },
  );
  const payload = (await response.json()) as object;
  if (!response.ok) {
    throw new BridgeProtocolError(
      errorMessage(payload) ?? `Bridge pairing failed with HTTP ${response.status}`,
      response.status,
    );
  }
  const credential = payload as BridgeWorkerCredentialResponse;
  if (
    credential.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    credential.workerId !== options.workerId ||
    typeof credential.credential !== 'string' ||
    credential.credential.length < 32 ||
    !Number.isFinite(Date.parse(credential.expiresAt))
  ) {
    throw new BridgeProtocolError('Code API returned an invalid worker credential');
  }
  return {
    ...credential,
    codeApiUrl,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  };
}
