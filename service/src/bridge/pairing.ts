import {
  createHash,
  createPublicKey,
  randomBytes,
} from 'crypto';

import type Redis from 'ioredis';

import { verifyBridgeRequest } from '../../../packages/code/src/identity';

const PREFIX = 'codeapi:bridge:v1';
const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 15 * 60;
const PROOF_NONCE_TTL_SECONDS = 2 * 60;
const PROOF_CLOCK_SKEW_MS = 60_000;
const ROTATE_CREDENTIAL_SCRIPT = `
local activeDigest = redis.call('GET', KEYS[1])
local previous = redis.call('GET', KEYS[2])
if not activeDigest or not previous then
  return 0
end
if activeDigest ~= ARGV[1] and redis.call('GET', KEYS[4]) ~= ARGV[5] then
  return 0
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
return 1
`;
const ISSUE_PAIRING_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('DEL', previous)
end
redis.call('DEL', KEYS[3])
redis.call('SET', KEYS[1], KEYS[2], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;
const REDEEM_PAIRING_SCRIPT = `
local pairing = redis.call('GET', KEYS[1])
if not pairing then
  return nil
end
if redis.call('GET', KEYS[2]) ~= KEYS[1] then
  redis.call('DEL', KEYS[1])
  return nil
end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[2])
return pairing
`;
const INSTALL_REDEEMED_CREDENTIAL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
redis.call('DEL', KEYS[1])
return 1
`;

export type BridgePrincipalType = 'deployment' | 'tenant' | 'user' | 'role' | 'group';

export interface BridgeWorkerBinding {
  tenantId: string;
  principal: {
    type: BridgePrincipalType;
    id: string;
  };
}

interface StoredPairing {
  workerId: string;
  expiresAt: string;
  binding?: BridgeWorkerBinding;
}

interface StoredCredential {
  workerId: string;
  identityId: string;
  publicKey: string;
  expiresAt: string;
  binding?: BridgeWorkerBinding;
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

function credentialDigestKey(credentialDigest: string): string {
  return `${PREFIX}:credential:${credentialDigest}`;
}

function workerIdentityKey(workerId: string): string {
  return `${PREFIX}:identity:${workerId}`;
}

function workerStableIdentityKey(workerId: string): string {
  return `${PREFIX}:stable-identity:${workerId}`;
}

function workerPairingIndexKey(workerId: string): string {
  return `${PREFIX}:pairing-index:${workerId}`;
}

function workerRedemptionKey(workerId: string): string {
  return `${PREFIX}:redemption:${workerId}`;
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

  async issue(
    workerId: string,
    binding?: BridgeWorkerBinding,
  ): Promise<BridgePairing> {
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.pairingTtlSeconds * 1000,
    ).toISOString();
    const pairing: StoredPairing = { workerId, expiresAt, binding };
    const codeKey = pairingKey(code);
    await this.redis.eval(
      ISSUE_PAIRING_SCRIPT,
      3,
      workerPairingIndexKey(workerId),
      codeKey,
      workerRedemptionKey(workerId),
      JSON.stringify(pairing),
      String(this.pairingTtlSeconds),
    );
    return { workerId, code, expiresAt };
  }

  async redeem(args: {
    workerId: string;
    code: string;
    publicKey: string;
  }): Promise<BridgeWorkerCredential> {
    if (!validEd25519PublicKey(args.publicKey)) {
      throw new BridgePairingError(
        'PUBLIC_KEY_INVALID',
        'Worker public key must be an Ed25519 key',
      );
    }
    const codeKey = pairingKey(args.code);
    const redemptionId = randomBytes(18).toString('base64url');
    const raw = await this.redis.eval(
      REDEEM_PAIRING_SCRIPT,
      3,
      codeKey,
      workerPairingIndexKey(args.workerId),
      workerRedemptionKey(args.workerId),
      redemptionId,
      String(this.pairingTtlSeconds),
    );
    if (typeof raw !== 'string') {
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
    return await this.issueCredential(
      args.workerId,
      args.publicKey,
      undefined,
      undefined,
      pairing.binding,
      redemptionId,
    );
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
  }): Promise<{
    workerId: string;
    credentialId: string;
    activeCredentialId: string;
    identityId: string;
    binding?: BridgeWorkerBinding;
  }> {
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
    if (raw == null || activeDigest == null) {
      throw new BridgePairingError(
        'CREDENTIAL_INVALID',
        'Worker credential is invalid or expired',
      );
    }
    const stored = JSON.parse(raw) as StoredCredential;
    if (activeDigest !== credentialDigest) {
      const activeRaw = await this.redis.get(
        credentialDigestKey(activeDigest),
      );
      const active = activeRaw == null
        ? undefined
        : JSON.parse(activeRaw) as StoredCredential;
      if (active?.identityId !== stored.identityId) {
        throw new BridgePairingError(
          'CREDENTIAL_INVALID',
          'Worker credential is invalid or expired',
        );
      }
    }
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
    return {
      workerId: stored.workerId,
      credentialId: credentialDigest,
      activeCredentialId: activeDigest,
      identityId: stored.identityId,
      ...(stored.binding ? { binding: stored.binding } : {}),
    };
  }

  async revoke(workerId: string): Promise<void> {
    const identityKey = workerIdentityKey(workerId);
    const credentialDigest = await this.redis.get(identityKey);
    if (credentialDigest == null) return;
    await this.redis.del(
      identityKey,
      workerStableIdentityKey(workerId),
      credentialDigestKey(credentialDigest),
    );
  }

  async rotate(
    workerId: string,
    expectedCredentialId?: string,
  ): Promise<BridgeWorkerCredential> {
    const identityKey = workerIdentityKey(workerId);
    const previousDigest =
      expectedCredentialId ?? (await this.redis.get(identityKey));
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
      previous.identityId,
      previous.binding,
    );
  }

  private async issueCredential(
    workerId: string,
    publicKey: string,
    previousDigest?: string,
    identityId = randomBytes(18).toString('base64url'),
    binding?: BridgeWorkerBinding,
    redemptionId?: string,
  ): Promise<BridgeWorkerCredential> {
    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(
      Date.now() + this.credentialTtlSeconds * 1000,
    ).toISOString();
    const stored: StoredCredential = {
      workerId,
      identityId,
      publicKey,
      expiresAt,
      binding,
    };
    if (previousDigest !== undefined) {
      const rotated = await this.redis.eval(
        ROTATE_CREDENTIAL_SCRIPT,
        4,
        workerIdentityKey(workerId),
        credentialDigestKey(previousDigest),
        credentialDigestKey(credentialDigest),
        workerStableIdentityKey(workerId),
        previousDigest,
        credentialDigest,
        JSON.stringify(stored),
        String(this.credentialTtlSeconds),
        identityId,
      );
      if (rotated !== 1) {
        throw new BridgePairingError(
          'CREDENTIAL_INVALID',
          'Worker credential is invalid or expired',
        );
      }
      return { workerId, credential, expiresAt };
    }
    if (redemptionId == null) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing redemption was not fenced',
      );
    }
    const installed = await this.redis.eval(
      INSTALL_REDEEMED_CREDENTIAL_SCRIPT,
      4,
      workerRedemptionKey(workerId),
      credentialDigestKey(credentialDigest),
      workerIdentityKey(workerId),
      workerStableIdentityKey(workerId),
      redemptionId,
      credentialDigest,
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      identityId,
    );
    if (installed !== 1) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code was superseded before credential installation',
      );
    }
    return { workerId, credential, expiresAt };
  }
}
