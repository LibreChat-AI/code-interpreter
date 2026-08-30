import {
  createHash,
  createPublicKey,
  randomBytes,
} from 'crypto';

import type Redis from 'ioredis';

import { verifyBridgeRequest } from '../../../packages/code/src/identity';

const PREFIX = 'codeapi:bridge:v1';
const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 5 * 60;
const PROOF_NONCE_TTL_SECONDS = 2 * 60;
const PROOF_CLOCK_SKEW_MS = 60_000;

interface StoredPairing {
  workerId: string;
  expiresAt: string;
}

interface StoredCredential {
  workerId: string;
  publicKey: string;
  expiresAt: string;
}

export interface BridgePairing {
  workerId: string;
  code: string;
  expiresAt: string;
}

export interface BridgeWorkerCredential {
  workerId: string;
  credential: string;
  expiresAt: string;
}

export class BridgePairingError extends Error {
  constructor(
    public readonly code:
      | 'PAIRING_INVALID'
      | 'PUBLIC_KEY_INVALID'
      | 'CREDENTIAL_INVALID'
      | 'PROOF_INVALID'
      | 'PROOF_REPLAYED',
    message: string,
  ) {
    super(message);
    this.name = 'BridgePairingError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pairingKey(code: string): string {
  return `${PREFIX}:pairing:${digest(code)}`;
}

function credentialKey(credential: string): string {
  return credentialDigestKey(digest(credential));
}

function credentialDigestKey(credentialDigest: string): string {
  return `${PREFIX}:credential:${credentialDigest}`;
}

function workerIdentityKey(workerId: string): string {
  return `${PREFIX}:identity:${workerId}`;
}

function proofNonceKey(credential: string, nonce: string): string {
  return `${PREFIX}:proof:${digest(credential)}:${digest(nonce)}`;
}

function validEd25519PublicKey(publicKey: string): boolean {
  try {
    return createPublicKey(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export class RedisBridgePairingStore {
  constructor(
    private readonly redis: Redis,
    private readonly pairingTtlSeconds = DEFAULT_PAIRING_TTL_SECONDS,
    private readonly credentialTtlSeconds = DEFAULT_CREDENTIAL_TTL_SECONDS,
  ) {}

  async issue(workerId: string): Promise<BridgePairing> {
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.pairingTtlSeconds * 1000,
    ).toISOString();
    const pairing: StoredPairing = { workerId, expiresAt };
    await this.redis.set(
      pairingKey(code),
      JSON.stringify(pairing),
      'EX',
      this.pairingTtlSeconds,
    );
    return { workerId, code, expiresAt };
  }

  async redeem(args: {
    workerId: string;
    code: string;
    publicKey: string;
  }): Promise<BridgeWorkerCredential> {
    const raw = await this.redis.getdel(pairingKey(args.code));
    if (raw == null) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code is invalid or expired',
      );
    }
    const pairing = JSON.parse(raw) as StoredPairing;
    if (pairing.workerId !== args.workerId) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code does not authorize this worker',
      );
    }
    if (!validEd25519PublicKey(args.publicKey)) {
      throw new BridgePairingError(
        'PUBLIC_KEY_INVALID',
        'Worker public key must be an Ed25519 key',
      );
    }

    return await this.issueCredential(args.workerId, args.publicKey);
  }

  async authorize(args: {
    workerId: string;
    credential: string;
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    body: string;
    signature: string;
  }): Promise<{ workerId: string }> {
    const proofTime = Date.parse(args.timestamp);
    if (
      !Number.isFinite(proofTime) ||
      Math.abs(Date.now() - proofTime) > PROOF_CLOCK_SKEW_MS
    ) {
      throw new BridgePairingError(
        'PROOF_INVALID',
        'Worker request proof is outside the accepted clock window',
      );
    }
    const credentialDigest = digest(args.credential);
    const [raw, activeDigest] = await this.redis.mget(
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
    );
    if (raw == null || activeDigest !== credentialDigest) {
      throw new BridgePairingError(
        'CREDENTIAL_INVALID',
        'Worker credential is invalid or expired',
      );
    }
    const stored = JSON.parse(raw) as StoredCredential;
    if (stored.workerId !== args.workerId) {
      throw new BridgePairingError(
        'CREDENTIAL_INVALID',
        'Worker credential does not authorize this worker',
      );
    }
    if (!verifyBridgeRequest(stored.publicKey, args, args.signature)) {
      throw new BridgePairingError(
        'PROOF_INVALID',
        'Worker request proof is invalid',
      );
    }
    const accepted = await this.redis.set(
      proofNonceKey(args.credential, args.nonce),
      '1',
      'EX',
      PROOF_NONCE_TTL_SECONDS,
      'NX',
    );
    if (accepted !== 'OK') {
      throw new BridgePairingError(
        'PROOF_REPLAYED',
        'Worker request proof has already been used',
      );
    }
    return { workerId: stored.workerId };
  }

  async revoke(workerId: string): Promise<void> {
    const identityKey = workerIdentityKey(workerId);
    const credentialDigest = await this.redis.get(identityKey);
    if (credentialDigest == null) return;
    await this.redis.del(identityKey, credentialDigestKey(credentialDigest));
  }

  async rotate(workerId: string): Promise<BridgeWorkerCredential> {
    const identityKey = workerIdentityKey(workerId);
    const previousDigest = await this.redis.get(identityKey);
    const previousRaw =
      previousDigest == null
        ? null
        : await this.redis.get(credentialDigestKey(previousDigest));
    if (previousRaw == null || previousDigest == null) {
      throw new BridgePairingError(
        'CREDENTIAL_INVALID',
        'Worker credential is invalid or expired',
      );
    }
    const previous = JSON.parse(previousRaw) as StoredCredential;
    return await this.issueCredential(
      workerId,
      previous.publicKey,
      previousDigest,
    );
  }

  private async issueCredential(
    workerId: string,
    publicKey: string,
    previousDigest?: string,
  ): Promise<BridgeWorkerCredential> {
    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(
      Date.now() + this.credentialTtlSeconds * 1000,
    ).toISOString();
    const stored: StoredCredential = { workerId, publicKey, expiresAt };
    const transaction = this.redis.multi();
    transaction.set(
      credentialDigestKey(credentialDigest),
      JSON.stringify(stored),
      'EX',
      this.credentialTtlSeconds,
    );
    transaction.set(
      workerIdentityKey(workerId),
      credentialDigest,
      'EX',
      this.credentialTtlSeconds,
    );
    if (previousDigest !== undefined) {
      transaction.del(credentialDigestKey(previousDigest));
    }
    await transaction.exec();
    return { workerId, credential, expiresAt };
  }
}
