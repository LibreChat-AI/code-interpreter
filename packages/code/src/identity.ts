import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export interface BridgeIdentity {
  publicKey: string;
  privateKey: string;
}

export interface BridgeRequestProofInput {
  credential: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}

export function createBridgeIdentity(): BridgeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function canonicalBridgeRequest(input: BridgeRequestProofInput): string {
  const bodyDigest = createHash('sha256').update(input.body).digest('hex');
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyDigest,
    input.credential,
  ].join('\n');
}

export function signBridgeRequest(
  privateKey: string,
  input: BridgeRequestProofInput,
): string {
  return sign(null, Buffer.from(canonicalBridgeRequest(input)), privateKey).toString(
    'base64url',
  );
}

export function verifyBridgeRequest(
  publicKey: string,
  input: BridgeRequestProofInput,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalBridgeRequest(input)),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
