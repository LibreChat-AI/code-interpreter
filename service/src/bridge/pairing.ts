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
const ISSUE_PAIRING_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('DEL', previous)
end
redis.call('SET', KEYS[1], KEYS[3], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
return 1
`;
const REDEEM_PAIRING_SCRIPT = `
local pairing = redis.call('GET', KEYS[1])
if pairing ~= ARGV[1] then
  return 0
end
local generation = redis.call('GET', KEYS[2])
if ARGV[2] == '' then
  if generation then
    redis.call('DEL', KEYS[1])
    return 0
  end
elseif generation ~= ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[5]) == KEYS[1] then
  redis.call('DEL', KEYS[5])
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
return 1
`;
const ROTATE_CREDENTIAL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('EXISTS', KEYS[2]) ~= 1 then
  return 0
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('DEL', KEYS[2])
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
  generation?: string;
  binding?: BridgeWorkerBinding;
}

interface StoredCredential {
  workerId: string;
  /** Stable across refreshes; replaced only when the worker is paired again. */
  identityId?: string;
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

function workerPairingIndexKey(workerId: string): string {
  return `${PREFIX}:pairing-index:${workerId}`;
}

function workerPairingGenerationKey(workerId: string): string {
  return `${PREFIX}:pairing-generation:${workerId}`;
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
    const generation = randomBytes(24).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.pairingTtlSeconds * 1000,
    ).toISOString();
    const pairing: StoredPairing = {
      workerId,
      expiresAt,
      generation,
      binding,
    };
    const codeKey = pairingKey(code);
    await this.redis.eval(
      ISSUE_PAIRING_SCRIPT,
      3,
      workerPairingIndexKey(workerId),
      workerPairingGenerationKey(workerId),
      codeKey,
      generation,
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
    const codeKey = pairingKey(args.code);
    const raw = await this.redis.get(codeKey);
    if (raw == null) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code is invalid or expired',
      );
    }
    const pairing = JSON.parse(raw) as StoredPairing;
    if (pairing.workerId !== args.workerId) {
      await this.redis.del(codeKey);
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code does not authorize this worker',
      );
    }
    if (!validEd25519PublicKey(args.publicKey)) {
      await this.redis.del(codeKey);
      throw new BridgePairingError(
        'PUBLIC_KEY_INVALID',
        'Worker public key must be an Ed25519 key',
      );
    }

    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(
      Date.now() + this.credentialTtlSeconds * 1000,
    ).toISOString();
    const stored: StoredCredential = {
      workerId: args.workerId,
      publicKey: args.publicKey,
      expiresAt,
      binding: pairing.binding,
    };
    const accepted = await this.redis.eval(
      REDEEM_PAIRING_SCRIPT,
      5,
      codeKey,
      workerPairingGenerationKey(pairing.workerId),
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
      workerPairingIndexKey(args.workerId),
      raw,
      pairing.generation ?? '',
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      credentialDigest,
    );
    if (accepted !== 1) {
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code is invalid or expired',
      );
    }
    return { workerId: args.workerId, credential, expiresAt };
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
    identityId?: string;
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
    return {
      workerId: stored.workerId,
      credentialId: credentialDigest,
      ...(stored.identityId != null ? { identityId: stored.identityId } : {}),
      ...(stored.binding ? { binding: stored.binding } : {}),
    };
  }

  async revoke(workerId: string): Promise<void> {
    // Rotate the pending generation before touching active credentials so an
    // unredeemed code cannot race lifecycle deletion and create a new worker.
    await this.redis.set(
      workerPairingGenerationKey(workerId),
      randomBytes(24).toString('base64url'),
      'EX',
      this.pairingTtlSeconds,
    );
    await this.removeLegacyPairings(workerId);
    const identityKey = workerIdentityKey(workerId);
    const credentialDigest = await this.redis.get(identityKey);
    if (credentialDigest == null) return;
    await this.redis.del(identityKey, credentialDigestKey(credentialDigest));
  }

  private async removeLegacyPairings(workerId: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${PREFIX}:pairing:*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length === 0) continue;
      const values = await this.redis.mget(...keys);
      const matching = keys.filter((_key, index) => {
        const raw = values[index];
        if (raw == null) return false;
        try {
          return (JSON.parse(raw) as Partial<StoredPairing>).workerId === workerId;
        } catch {
          return false;
        }
      });
      if (matching.length > 0) await this.redis.del(...matching);
    } while (cursor !== '0');
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
      previous.binding,
      previous.identityId ?? null,
    );
  }

  private async issueCredential(
    workerId: string,
    publicKey: string,
    previousDigest?: string,
    binding?: BridgeWorkerBinding,
    identityId?: string | null,
  ): Promise<BridgeWorkerCredential> {
    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(
      Date.now() + this.credentialTtlSeconds * 1000,
    ).toISOString();
    const stableIdentityId =
      identityId === undefined
        ? randomBytes(18).toString('base64url')
        : identityId ?? undefined;
    const stored: StoredCredential = {
      workerId,
      ...(stableIdentityId != null ? { identityId: stableIdentityId } : {}),
      publicKey,
      expiresAt,
      binding,
    };
    if (previousDigest !== undefined) {
      const rotated = await this.redis.eval(
        ROTATE_CREDENTIAL_SCRIPT,
        3,
        workerIdentityKey(workerId),
        credentialDigestKey(previousDigest),
        credentialDigestKey(credentialDigest),
        previousDigest,
        credentialDigest,
        JSON.stringify(stored),
        String(this.credentialTtlSeconds),
      );
      if (rotated !== 1) {
        throw new BridgePairingError(
          'CREDENTIAL_INVALID',
          'Worker credential is invalid or expired',
        );
      }
    } else {
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
      await transaction.exec();
    }
    return { workerId, credential, expiresAt };
  }
}
