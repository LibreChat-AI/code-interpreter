import {
  createHash,
  createPublicKey,
  randomBytes,
} from 'crypto';

import type { RedisClient } from '../redis-connection';

import { verifyBridgeRequest } from '../../../packages/code/src/identity';

const PREFIX = 'codeapi:bridge:v1';
const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 15 * 60;
const PROOF_NONCE_TTL_SECONDS = 2 * 60;
const PROOF_CLOCK_SKEW_MS = 60_000;
const LEGACY_SCAN_CLAIM_TTL_MS = 5_000;
const LEGACY_SCAN_POLL_INTERVAL_MS = 25;
const LEGACY_SCAN_PENDING = 'pending';
const LEGACY_SCAN_COMPLETE = 'done';
const ISSUE_PAIRING_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('DEL', previous)
end
redis.call('SET', KEYS[1], KEYS[2], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;
const REDEEM_PAIRING_SCRIPT = `
local pairing = redis.call('GET', KEYS[1])
if pairing ~= ARGV[1] then
  return 0
end
local generation = redis.call('GET', KEYS[2])
if ARGV[2] == '' then
  if generation and redis.call('GET', KEYS[5]) ~= KEYS[1] then
    redis.call('DEL', KEYS[1])
    return 0
  end
elseif (generation or '0') ~= ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[5]) == KEYS[1] then
  redis.call('DEL', KEYS[5])
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
redis.call('SET', KEYS[6], ARGV[6], 'EX', ARGV[4])
return 1
`;
const ROTATE_CREDENTIAL_SCRIPT = `
local activeDigest = redis.call('GET', KEYS[1])
local previous = redis.call('GET', KEYS[2])
if not activeDigest or not previous then
  return 0
end
if activeDigest ~= ARGV[1] then
  if ARGV[5] == '' or redis.call('GET', KEYS[4]) ~= ARGV[5] then
    return 0
  end
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
if ARGV[5] ~= '' then
  redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
else
  redis.call('DEL', KEYS[4])
end
return 1
`;
const REVOKE_PAIRING_SCRIPT = `
local indexed = redis.call('GET', KEYS[1])
local credential = redis.call('GET', KEYS[3])
local activeIncarnation = redis.call('GET', KEYS[6])
redis.call('INCR', KEYS[2])
if indexed then
  redis.call('DEL', indexed)
end
if credential then
  redis.call('DEL', KEYS[3])
  redis.call('DEL', ARGV[1] .. credential)
end
redis.call('DEL', KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[6])
if activeIncarnation then
  redis.call('SET', ARGV[2] .. activeIncarnation .. ':fenced', '1')
end
return 1
`;
const RELEASE_LEGACY_SCAN_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const NORMALIZE_LEGACY_SCAN_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`;
const RENEW_LEGACY_SCAN_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const COMPLETE_LEGACY_SCAN_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[2]) == ARGV[1] then
  local remaining = tonumber(ARGV[3])
  if ARGV[4] == '1' then
    redis.call('SET', KEYS[1], ARGV[2])
  elseif remaining > 0 then
    redis.call('SET', KEYS[1], ARGV[2], 'PX', remaining)
  else
    redis.call('DEL', KEYS[1])
  end
  redis.call('DEL', KEYS[2])
  return 1
end
return 0
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
  generation?: number;
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

function workerStableIdentityKey(workerId: string): string {
  return `${PREFIX}:stable-identity:${workerId}`;
}

function workerPairingGenerationKey(workerId: string): string {
  return `${PREFIX}:pairing-generation:${workerId}`;
}

function workerPairingIndexKey(workerId: string): string {
  return `${PREFIX}:pairing-index:${workerId}`;
}

function legacyPairingScanDeadlineKey(): string {
  return `${PREFIX}:migration:legacy-pairing-scan-until`;
}

function legacyPairingWorkerScanKey(
  workerId: string,
  rollbackEpoch?: string,
): string {
  const epoch = rollbackEpoch?.trim();
  const epochSuffix = epoch ? `:${digest(epoch)}` : '';
  return `${PREFIX}:migration:legacy-pairing-scanned:${workerId}${epochSuffix}`;
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
    private readonly redis: RedisClient,
    private readonly pairingTtlSeconds = DEFAULT_PAIRING_TTL_SECONDS,
    private readonly credentialTtlSeconds = DEFAULT_CREDENTIAL_TTL_SECONDS,
    private readonly legacyScanClaimTtlMs = LEGACY_SCAN_CLAIM_TTL_MS,
    private readonly rollbackEpoch =
      process.env.CODEAPI_BRIDGE_PAIRING_ROLLBACK_EPOCH?.trim() ?? '',
  ) {}

  async issue(
    workerId: string,
    binding?: BridgeWorkerBinding,
  ): Promise<BridgePairing> {
    // Pre-index binaries cannot remove a superseded code themselves. During
    // the one pairing-TTL migration window, find and delete those records so
    // rolling back cannot make a replaced code valid again.
    await this.removeLegacyPairings(workerId);
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.pairingTtlSeconds * 1000,
    ).toISOString();
    const generation = Number(
      (await this.redis.get(workerPairingGenerationKey(workerId))) ?? '0',
    );
    const pairing: StoredPairing = { workerId, expiresAt, generation, binding };
    const codeKey = pairingKey(code);
    await this.redis.eval(
      ISSUE_PAIRING_SCRIPT,
      2,
      workerPairingIndexKey(workerId),
      codeKey,
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
      throw new BridgePairingError(
        'PUBLIC_KEY_INVALID',
        'Worker public key must be an Ed25519 key',
      );
    }
    // Validate the supplied code before it can trigger a shared-keyspace scan.
    // A rollback epoch means any generation-less code may have survived a
    // legacy revoke, so clean the authenticated worker and reject that code.
    if (
      pairing.generation == null &&
      this.rollbackEpoch.trim().length > 0
    ) {
      await this.removeLegacyPairings(args.workerId);
      throw new BridgePairingError(
        'PAIRING_INVALID',
        'Pairing code is invalid or expired',
      );
    }

    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(
      Date.now() + this.credentialTtlSeconds * 1000,
    ).toISOString();
    const identityId = randomBytes(18).toString('base64url');
    const stored: StoredCredential = {
      workerId: args.workerId,
      identityId,
      publicKey: args.publicKey,
      expiresAt,
      binding: pairing.binding,
    };
    const accepted = await this.redis.eval(
      REDEEM_PAIRING_SCRIPT,
      6,
      codeKey,
      workerPairingGenerationKey(pairing.workerId),
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
      workerPairingIndexKey(args.workerId),
      workerStableIdentityKey(args.workerId),
      raw,
      pairing.generation == null ? '' : String(pairing.generation),
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      credentialDigest,
      identityId,
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
    activeCredentialId: string;
    identityId?: string;
    pairingGeneration: number;
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
    const [raw, activeDigest, pairingGeneration] = await this.redis.mget(
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
      workerPairingGenerationKey(args.workerId),
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
      if (
        stored.identityId == null ||
        active?.identityId == null ||
        stored.identityId !== active.identityId
      ) {
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
      ...(stored.identityId != null ? { identityId: stored.identityId } : {}),
      pairingGeneration: Number(pairingGeneration ?? '0'),
      ...(stored.binding ? { binding: stored.binding } : {}),
    };
  }

  async revoke(workerId: string): Promise<void> {
    await this.removeLegacyPairings(workerId);
    // Fence redemption and consume the currently indexed code atomically. An
    // issue that linearized before this script is always removed; an issue
    // that linearizes afterward installs a distinct generation and code.
    await this.redis.eval(
      REVOKE_PAIRING_SCRIPT,
      6,
      workerPairingIndexKey(workerId),
      workerPairingGenerationKey(workerId),
      workerIdentityKey(workerId),
      workerStableIdentityKey(workerId),
      `${PREFIX}:worker:${encodeURIComponent(workerId)}`,
      `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation`,
      `${PREFIX}:credential:`,
      `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:`,
    );
  }

  private async removeLegacyPairings(workerId: string): Promise<void> {
    const deadlineKey = legacyPairingScanDeadlineKey();
    const now = Date.now();
    const migrationWindowMs = this.pairingTtlSeconds * 1000;
    const proposedDeadline = now + migrationWindowMs;
    let rawDeadline = await this.redis.get(deadlineKey);
    if (rawDeadline == null) {
      const initialized = await this.redis.set(
        deadlineKey,
        String(proposedDeadline),
        'NX',
      );
      rawDeadline = initialized === 'OK'
        ? String(proposedDeadline)
        : await this.redis.get(deadlineKey);
    } else if ((await this.redis.pttl(deadlineKey)) > 0) {
      // Markers from the preceding build expired and reopened forever. Keep
      // their original deadline, but make it durable so normal idle periods
      // cannot start another migration window.
      await this.redis.persist(deadlineKey);
    }

    const indexedKey = await this.redis.get(workerPairingIndexKey(workerId));
    const indexedRaw = indexedKey == null ? null : await this.redis.get(indexedKey);
    let rollbackDetected = false;
    if (indexedRaw != null) {
      try {
        rollbackDetected = (JSON.parse(indexedRaw) as StoredPairing).generation == null;
      } catch {
        rollbackDetected = false;
      }
    }

    const deadline = Number(rawDeadline);
    const stateKey = legacyPairingWorkerScanKey(workerId, this.rollbackEpoch);
    const rollbackEpochDetected = this.rollbackEpoch.trim().length > 0;
    while (true) {
      const state = await this.redis.get(stateKey);
      if (state === LEGACY_SCAN_COMPLETE && !rollbackDetected) return;
      if (state === LEGACY_SCAN_PENDING) break;
      if (state == null) {
        if (
          !rollbackDetected &&
          !rollbackEpochDetected &&
          (!Number.isFinite(deadline) || Date.now() > deadline)
        ) {
          return;
        }
        const initialized = await this.redis.set(
          stateKey,
          LEGACY_SCAN_PENDING,
          'NX',
        );
        if (initialized === 'OK') break;
        continue;
      }
      // Predecessor builds stored an unqualified random token before scanning.
      // It cannot prove whether that scan completed, so normalize it to a
      // durable retry requirement instead of treating it as success.
      const normalized = await this.redis.eval(
        NORMALIZE_LEGACY_SCAN_STATE_SCRIPT,
        1,
        stateKey,
        state,
        LEGACY_SCAN_PENDING,
      );
      if (normalized === 1) break;
    }

    const claimKey = `${stateKey}:claim`;
    let scanClaim: { key: string; token: string } | undefined;
    while (scanClaim == null) {
      const state = await this.redis.get(stateKey);
      if (state === LEGACY_SCAN_COMPLETE || state == null) return;
      const token = `claim:${randomBytes(24).toString('base64url')}`;
      const claimed = await this.redis.set(
        claimKey,
        token,
        'PX',
        Math.max(1, this.legacyScanClaimTtlMs),
        'NX',
      );
      if (claimed === 'OK') {
        scanClaim = { key: claimKey, token };
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LEGACY_SCAN_POLL_INTERVAL_MS),
      );
    }

    let renewalError: unknown;
    let renewal = Promise.resolve();
    let renewalInFlight = false;
    const renewClaim = async (): Promise<void> => {
      const renewed = await this.redis.eval(
        RENEW_LEGACY_SCAN_CLAIM_SCRIPT,
        1,
        scanClaim.key,
        scanClaim.token,
        String(Math.max(1, this.legacyScanClaimTtlMs)),
      );
      if (renewed !== 1) {
        throw new Error('Legacy pairing cleanup claim was lost');
      }
    };
    const renewalTimer = setInterval(() => {
      if (renewalInFlight || renewalError != null) return;
      renewalInFlight = true;
      renewal = renewClaim()
        .catch((error: unknown) => {
          renewalError = error;
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, Math.max(1, Math.floor(this.legacyScanClaimTtlMs / 3)));
    renewalTimer.unref?.();

    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${PREFIX}:pairing:*`,
          'COUNT',
          100,
        );
        if (renewalError != null) throw renewalError;
        cursor = nextCursor;
        if (keys.length === 0) continue;
        const values = await this.redis.mget(...keys);
        const matching = keys.filter((_key, index) => {
          const raw = values[index];
          if (raw == null) return false;
          try {
            const pairing = JSON.parse(raw) as Partial<StoredPairing>;
            return pairing.workerId === workerId && pairing.generation == null;
          } catch {
            return false;
          }
        });
        if (matching.length > 0) await this.redis.del(...matching);
      } while (cursor !== '0');
      clearInterval(renewalTimer);
      await renewal;
      if (renewalError != null) throw renewalError;
      await renewClaim();
      const completed = await this.redis.eval(
        COMPLETE_LEGACY_SCAN_CLAIM_SCRIPT,
        2,
        stateKey,
        scanClaim.key,
        scanClaim.token,
        LEGACY_SCAN_COMPLETE,
        String(deadline - Date.now()),
        rollbackEpochDetected ? '1' : '0',
      );
      if (completed !== 1) {
        await this.removeLegacyPairings(workerId);
      }
    } catch (error) {
      clearInterval(renewalTimer);
      await renewal;
      await this.redis.eval(
        RELEASE_LEGACY_SCAN_CLAIM_SCRIPT,
        1,
        scanClaim.key,
        scanClaim.token,
      );
      throw error;
    }
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
        4,
        workerIdentityKey(workerId),
        credentialDigestKey(previousDigest),
        credentialDigestKey(credentialDigest),
        workerStableIdentityKey(workerId),
        previousDigest,
        credentialDigest,
        JSON.stringify(stored),
        String(this.credentialTtlSeconds),
        stableIdentityId ?? '',
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
      if (stableIdentityId != null) {
        transaction.set(
          workerStableIdentityKey(workerId),
          stableIdentityId,
          'EX',
          this.credentialTtlSeconds,
        );
      } else {
        transaction.del(workerStableIdentityKey(workerId));
      }
      await transaction.exec();
    }
    return { workerId, credential, expiresAt };
  }
}
