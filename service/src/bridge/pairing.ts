import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
} from 'crypto';

import type Redis from 'ioredis';

import {
  BROWSER_ENROLLMENT_MAX_TTL_MS,
  canonicalBrowserEnrollmentRedemption,
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentRedemption,
  isBrowserEnrollmentRedemptionContract,
  isBrowserEnrollmentStatusRequest,
  verifyBrowserEnrollmentRedemption,
} from '../../../packages/code/src/browser-enrollment-protocol';
import type {
  BrowserEnrollmentApproval,
  BrowserEnrollmentRedemption,
  BrowserEnrollmentRedemptionContract,
  BrowserEnrollmentStatusRequest,
} from '../../../packages/code/src/browser-enrollment-protocol';
import {
  verifyBridgeRecovery,
  verifyBridgeRecoveryStart,
  verifyBridgeRequest,
} from '../../../packages/code/src/identity';
import type {
  BridgeRecoveryProofInput,
  BridgeRecoveryStartProofInput,
} from '../../../packages/code/src/identity';

const PREFIX = 'codeapi:bridge:v1';
const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 15 * 60;
const PROOF_NONCE_TTL_SECONDS = 2 * 60;
const PROOF_CLOCK_SKEW_MS = 60_000;
const DEFAULT_CHALLENGE_TTL_SECONDS = 60;
const DEFAULT_CHALLENGES_PER_MINUTE = 12;
const DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE = 30;
const DEFAULT_UNTRUSTED_RECOVERY_REQUESTS_PER_MINUTE = 240;
const RECOVERY_START_NONCE_TTL_SECONDS = 3 * 60;
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
if ARGV[7] ~= '' and (generation or '0') ~= ARGV[9] then return 0 end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[5]) == KEYS[1] then
  redis.call('DEL', KEYS[5])
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
redis.call('SET', KEYS[6], ARGV[6], 'EX', ARGV[4])
if ARGV[7] ~= '' then
  if tonumber(ARGV[8]) > 0 then
    redis.call('SET', KEYS[7], ARGV[7], 'EX', ARGV[8])
  else
    redis.call('SET', KEYS[7], ARGV[7])
  end
  redis.call('SET', KEYS[8], ARGV[10])
else
  redis.call('DEL', KEYS[7], KEYS[8])
end
return 1
`;
const ISSUE_BROWSER_ENROLLMENT_SCRIPT = `
local now = redis.call('TIME')
local remaining = tonumber(ARGV[3]) - (tonumber(now[1]) * 1000.0 + math.floor(tonumber(now[2]) / 1000))
if remaining <= 0 or remaining > tonumber(ARGV[4]) then return 0 end
if (redis.call('GET', KEYS[5]) or '0') ~= '0' then return 0 end
local saved = redis.call('GET', KEYS[1])
local tombstone = redis.call('GET', KEYS[13])
if tombstone and (not saved or tombstone ~= ARGV[5]) then return 0 end
if saved then
  if saved ~= ARGV[1] or redis.call('GET', KEYS[4]) ~= KEYS[3] or redis.call('GET', KEYS[3]) ~= 'browser-enrollment' then return 0 end
  local enrollment = redis.call('GET', KEYS[8])
  if enrollment then
    if enrollment ~= redis.call('GET', KEYS[2]) then return 0 end
  else
    for i = 6, 12 do
      if i ~= 8 and redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
    end
  end
  redis.call('SETNX', KEYS[5], '0')
  return 1
end
for i = 4, 12 do
  if i ~= 5 and redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
end
redis.call('SETNX', KEYS[5], '0')
redis.call('SET', KEYS[13], ARGV[5])
redis.call('SET', KEYS[1], ARGV[1], 'PX', remaining)
redis.call('SET', KEYS[2], ARGV[2], 'PX', remaining)
redis.call('SET', KEYS[3], 'browser-enrollment', 'PX', remaining)
redis.call('SET', KEYS[4], KEYS[3], 'PX', remaining)
return 1
`;
const REDEEM_BROWSER_ENROLLMENT_SCRIPT = `
local now = redis.call('TIME')
local remaining = tonumber(ARGV[3]) - (tonumber(now[1]) * 1000.0 + math.floor(tonumber(now[2]) / 1000))
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] or
  redis.call('GET', KEYS[3]) ~= 'browser-enrollment' or redis.call('GET', KEYS[4]) ~= KEYS[3] or
  (redis.call('GET', KEYS[5]) or '0') ~= '0' then return nil end
local replay = redis.call('GET', KEYS[11])
if replay then
  if redis.call('GET', KEYS[9]) ~= ARGV[2] or redis.call('GET', KEYS[10]) ~= ARGV[9] then return nil end
  return replay
end
if remaining <= 0 or ARGV[11] ~= '1' then return nil end
for i = 7, 14 do
  if i ~= 11 and redis.call('EXISTS', KEYS[i]) == 1 then return nil end
end
redis.call('SET', KEYS[6], ARGV[4], 'EX', ARGV[5])
redis.call('SET', KEYS[7], ARGV[6], 'EX', ARGV[5])
redis.call('SET', KEYS[8], ARGV[7], 'EX', ARGV[5])
if tonumber(ARGV[8]) > 0 then
  redis.call('SET', KEYS[9], ARGV[2], 'EX', ARGV[8])
else
  redis.call('SET', KEYS[9], ARGV[2])
end
redis.call('SET', KEYS[10], ARGV[9])
redis.call('SET', KEYS[11], ARGV[10], 'EX', ARGV[5])
for i = 1, 4 do redis.call('EXPIRE', KEYS[i], ARGV[5]) end
return ARGV[10]
`;
const ROTATE_CREDENTIAL_SCRIPT = `
if ARGV[6] ~= '' then
  if redis.call('GET', KEYS[5]) ~= ARGV[6] or (redis.call('GET', KEYS[6]) or '0') ~= ARGV[7] or redis.call('GET', KEYS[7]) ~= ARGV[8] then
    return 0
  end
elseif redis.call('EXISTS', KEYS[7]) == 1 then
  return 0
end
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
redis.call('DEL', KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8])
if activeIncarnation then
  redis.call('SET', ARGV[2] .. activeIncarnation .. ':fenced', '1')
end
return 1
`;
const CREATE_RECOVERY_CHALLENGE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or (redis.call('GET', KEYS[4]) or '0') ~= ARGV[4] or redis.call('GET', KEYS[5]) ~= ARGV[6] then
  return 0
end
if redis.call('EXISTS', KEYS[6]) == 1 then return -2 end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 60) end
if count > tonumber(ARGV[2]) then return -1 end
if not redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[5], 'NX') then return 0 end
redis.call('SET', KEYS[6], '1', 'EX', ARGV[7])
return 1
`;
const LIMIT_RECOVERY_ATTEMPTS_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if count > tonumber(ARGV[1]) then return 0 end
return 1
`;
const COMPLETE_RECOVERY_CHALLENGE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] or (redis.call('GET', KEYS[6]) or '0') ~= ARGV[3] or redis.call('GET', KEYS[7]) ~= ARGV[8] then
  return 0
end
local stableIdentity = redis.call('GET', KEYS[5])
if stableIdentity and stableIdentity ~= ARGV[4] then return 0 end
local count = redis.call('INCR', KEYS[8])
if count == 1 then redis.call('EXPIRE', KEYS[8], 60) end
if count > tonumber(ARGV[9]) then return -1 end
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[6])
redis.call('SET', KEYS[4], ARGV[7], 'EX', ARGV[6])
redis.call('SET', KEYS[5], ARGV[4], 'EX', ARGV[6])
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
  /** Present only for credentials backed by durable machine enrollment. */
  enrollmentGeneration?: string;
}

interface StoredEnrollment {
  workerId: string;
  serverId: string;
  identityId: string;
  generation: string;
  pairingGeneration: number;
  publicKey: string;
  binding?: BridgeWorkerBinding;
  browserEnrollment?: BrowserEnrollmentRedemptionContract;
}

export interface BridgeRecoveryOptions {
  /** Stable HTTPS origin of this Code API deployment, identical on every replica. */
  serverId: string;
  /** Zero (the default) keeps enrollment until explicit revocation. */
  enrollmentTtlSeconds?: number;
  challengeTtlSeconds?: number;
  maxChallengesPerMinute?: number;
  maxAttemptsPerMinute?: number;
  /** Shared per-connection-peer cap, separate from machine-signed budgets. */
  maxUntrustedRequestsPerMinute?: number;
}

export type BridgeRecoveryChallenge = BridgeRecoveryProofInput;

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
      | 'PROOF_REPLAYED'
      | 'ENROLLMENT_INVALID'
      | 'CHALLENGE_INVALID'
      | 'RECOVERY_RATE_LIMITED',
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

function browserEnrollmentKey(instance: string, attemptId: string): string {
  return `${PREFIX}:browser-enrollment:${digest(JSON.stringify([instance, attemptId]))}`;
}

function canonicalApproval(approval: BrowserEnrollmentApproval): string {
  return JSON.stringify({
    protocolVersion: 1,
    operation: approval.operation,
    serverId: approval.serverId,
    instance: approval.instance,
    attemptId: approval.attemptId,
    requestHash: approval.requestHash,
    workerId: approval.workerId,
    expiresAt: approval.expiresAt,
    publicKey: approval.publicKey,
    binding: {
      tenantId: approval.binding.tenantId,
      principal: { type: approval.binding.principal.type, id: approval.binding.principal.id },
    },
  });
}

function enrollmentReplayKey(adminToken: string, serverId: string): Buffer {
  if (!adminToken) throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment requires an administrator token');
  return createHash('sha256').update('librechat-code:browser-enrollment-replay:v1\0')
    .update(serverId).update('\0').update(adminToken).digest();
}

function encryptEnrollmentReplay(credential: BridgeWorkerCredential, approval: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(approval));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function decryptEnrollmentReplay(ciphertext: string, approval: string, key: Buffer): BridgeWorkerCredential {
  try {
    const bytes = Buffer.from(ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(approval));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as BridgeWorkerCredential;
  } catch {
    throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment replay is unavailable');
  }
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

function workerEnrollmentKey(workerId: string): string {
  return `${PREFIX}:enrollment:${workerId}`;
}

function workerEnrollmentRequiredKey(workerId: string): string {
  return `${PREFIX}:enrollment-required:${workerId}`;
}

function recoveryChallengeKey(challenge: string): string {
  return `${PREFIX}:recovery:challenge:${digest(challenge)}`;
}

function recoveryStartNonceKey(workerId: string, nonce: string): string {
  return `${PREFIX}:recovery:nonce:${workerId}:${digest(nonce)}`;
}

function recoveryChallengeAttemptKey(challenge: string): string {
  return `${PREFIX}:recovery:attempt:${digest(challenge)}`;
}

function untrustedRecoveryRateKey(peer: string, operation: 'challenge' | 'recover'): string {
  // Never partition by a caller-supplied worker ID or an untrusted forwarded IP.
  return `${PREFIX}:recovery:untrusted:${operation}:${digest(peer)}`;
}

function recoveryRateKey(
  workerId: string,
  enrollmentGeneration: string,
  operation: 'start' | 'complete',
): string {
  return `${PREFIX}:recovery:rate:${operation}:${workerId}:${enrollmentGeneration}`;
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
    private readonly redis: Redis,
    private readonly pairingTtlSeconds = DEFAULT_PAIRING_TTL_SECONDS,
    private readonly credentialTtlSeconds = DEFAULT_CREDENTIAL_TTL_SECONDS,
    private readonly legacyScanClaimTtlMs = LEGACY_SCAN_CLAIM_TTL_MS,
    private readonly rollbackEpoch =
    process.env.CODEAPI_BRIDGE_PAIRING_ROLLBACK_EPOCH?.trim() ?? '',
    private readonly recovery?: BridgeRecoveryOptions,
  ) {
    if (recovery == null) return;
    let server: URL;
    try {
      server = new URL(recovery.serverId);
    } catch {
      throw new Error('Bridge recovery requires a stable HTTPS server origin');
    }
    if (
      server.protocol !== 'https:' ||
      server.username !== '' ||
      server.password !== '' ||
      server.pathname !== '/' ||
      server.search !== '' ||
      server.hash !== '' ||
      server.origin !== recovery.serverId
    ) {
      throw new Error('Bridge recovery requires a stable HTTPS server origin');
    }
    for (const [value, max] of [
      [recovery.enrollmentTtlSeconds ?? 0, 10 * 365 * 24 * 3600],
      [recovery.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS, 300],
      [recovery.maxChallengesPerMinute ?? DEFAULT_CHALLENGES_PER_MINUTE, 120],
      [recovery.maxAttemptsPerMinute ?? DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE, 120],
      [recovery.maxUntrustedRequestsPerMinute ?? DEFAULT_UNTRUSTED_RECOVERY_REQUESTS_PER_MINUTE, 1200],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        throw new RangeError('Invalid bridge recovery lifetime or rate limit');
      }
    }
    if (
      (recovery.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS) === 0 ||
      (recovery.maxChallengesPerMinute ?? DEFAULT_CHALLENGES_PER_MINUTE) === 0 ||
      (recovery.maxAttemptsPerMinute ?? DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE) === 0 ||
      (recovery.maxUntrustedRequestsPerMinute ?? DEFAULT_UNTRUSTED_RECOVERY_REQUESTS_PER_MINUTE) === 0
    ) {
      throw new RangeError('Bridge recovery challenge lifetime and rate limits must be positive');
    }
  }

  get recoveryEnabled(): boolean {
    return this.recovery != null;
  }

  get recoveryServerId(): string | undefined {
    return this.recovery?.serverId;
  }

  async limitBrowserEnrollmentPeer(peer: string): Promise<void> {
    if (this.recovery == null) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment is disabled');
    }
    const allowed = await this.redis.eval(
      LIMIT_RECOVERY_ATTEMPTS_SCRIPT,
      1,
      `${PREFIX}:browser-enrollment:peer:${digest(peer)}`,
      String(this.recovery.maxUntrustedRequestsPerMinute ?? DEFAULT_UNTRUSTED_RECOVERY_REQUESTS_PER_MINUTE),
    );
    if (allowed !== 1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many browser enrollment requests from this peer');
    }
  }

  async issueBrowserEnrollment(approval: BrowserEnrollmentApproval): Promise<BrowserEnrollmentApproval> {
    if (!isBrowserEnrollmentApproval(approval) || this.recovery == null || approval.serverId !== this.recovery.serverId ||
      Date.parse(approval.expiresAt) <= Date.now() || Date.parse(approval.expiresAt) - Date.now() > BROWSER_ENROLLMENT_MAX_TTL_MS) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Invalid browser enrollment approval');
    }
    await this.removeLegacyPairings(approval.workerId);
    const approvalRaw = canonicalApproval(approval);
    const normalized = JSON.parse(approvalRaw) as BrowserEnrollmentApproval;
    const enrollment: StoredEnrollment = {
      workerId: approval.workerId,
      serverId: approval.serverId,
      identityId: randomBytes(18).toString('base64url'),
      generation: randomBytes(18).toString('base64url'),
      pairingGeneration: 0,
      browserEnrollment: {
        operation: approval.operation,
        serverId: approval.serverId,
        instance: approval.instance,
        attemptId: approval.attemptId,
        requestHash: approval.requestHash,
        workerId: approval.workerId,
        expiresAt: approval.expiresAt,
      },
      publicKey: approval.publicKey,
      binding: normalized.binding,
    };
    const key = browserEnrollmentKey(approval.instance, approval.attemptId);
    const workerPrefix = `${PREFIX}:worker:${encodeURIComponent(approval.workerId)}`;
    // The manual-pairing index points at a separate fence, never the immutable
    // approval. Manual issue/revoke consumes that fence without erasing the tombstone.
    const accepted = await this.redis.eval(
      ISSUE_BROWSER_ENROLLMENT_SCRIPT,
      13,
      key,
      `${key}:enrollment`,
      `${key}:fence`,
      workerPairingIndexKey(approval.workerId),
      workerPairingGenerationKey(approval.workerId),
      workerIdentityKey(approval.workerId),
      workerStableIdentityKey(approval.workerId),
      workerEnrollmentKey(approval.workerId),
      workerEnrollmentRequiredKey(approval.workerId),
      workerPrefix,
      `${workerPrefix}:incarnation`,
      `${workerPrefix}:registration-generation`,
      `${key}:tombstone`,
      approvalRaw,
      JSON.stringify(enrollment),
      String(Date.parse(approval.expiresAt)),
      String(BROWSER_ENROLLMENT_MAX_TTL_MS),
      `${digest(approvalRaw)}:${digest(canonicalBrowserEnrollmentRedemption(approval))}`,
    );
    if (accepted !== 1) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment is expired, revoked, superseded, or conflicts with an existing worker');
    }
    return normalized;
  }

  async browserEnrollmentStatus(proof: BrowserEnrollmentStatusRequest): Promise<{
    protocolVersion: 1;
    status: 'pending' | 'completed' | 'revoked';
    workerId: string;
  }> {
    if (!isBrowserEnrollmentStatusRequest(proof) || this.recovery == null || proof.serverId !== this.recovery.serverId) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Invalid browser enrollment status request');
    }
    const key = browserEnrollmentKey(proof.instance, proof.attemptId);
    const [raw, generation, requiredGeneration, approvalRaw, tombstone, fence, indexed, planned] = await this.redis.mget(
      workerEnrollmentKey(proof.workerId),
      workerPairingGenerationKey(proof.workerId),
      workerEnrollmentRequiredKey(proof.workerId),
      key,
      `${key}:tombstone`,
      `${key}:fence`,
      workerPairingIndexKey(proof.workerId),
      `${key}:enrollment`,
    );
    const contract = canonicalBrowserEnrollmentRedemption(proof);
    try {
      const enrollment = this.checkedEnrollment(proof.workerId, raw, generation, requiredGeneration);
      if (isBrowserEnrollmentRedemptionContract(enrollment.browserEnrollment) &&
        canonicalBrowserEnrollmentRedemption(enrollment.browserEnrollment) === contract) {
        return { protocolVersion: 1, status: 'completed', workerId: proof.workerId };
      }
    } catch (error) {
      if (!(error instanceof BridgePairingError)) throw error;
    }
    if (tombstone?.split(':')[1] !== digest(contract)) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment does not match a known contract');
    }
    let pending = false;
    try {
      const approval = JSON.parse(approvalRaw ?? 'null') as unknown;
      pending = (generation ?? '0') === '0' && raw == null && requiredGeneration == null && planned != null &&
        isBrowserEnrollmentApproval(approval) && canonicalBrowserEnrollmentRedemption(approval) === contract &&
        Date.parse(approval.expiresAt) > Date.now() && fence === 'browser-enrollment' && indexed === `${key}:fence`;
    } catch {
      pending = false;
    }
    return { protocolVersion: 1, status: pending ? 'pending' : 'revoked', workerId: proof.workerId };
  }

  async redeemBrowserEnrollment(
    proof: BrowserEnrollmentRedemption,
    adminToken: string,
  ): Promise<BridgeWorkerCredential> {
    if (!isBrowserEnrollmentRedemption(proof) || this.recovery == null || proof.serverId !== this.recovery.serverId) {
      throw new BridgePairingError('PROOF_INVALID', 'Invalid browser enrollment proof');
    }
    const replayKey = enrollmentReplayKey(adminToken, proof.serverId);
    const key = browserEnrollmentKey(proof.instance, proof.attemptId);
    const attempts = await this.redis.eval(
      LIMIT_RECOVERY_ATTEMPTS_SCRIPT,
      1,
      `${key}:attempts`,
      String(this.recovery.maxAttemptsPerMinute ?? DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE),
    );
    if (attempts !== 1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many browser enrollment attempts');
    }
    const [raw, enrollmentRaw] = await this.redis.mget(key, `${key}:enrollment`);
    let approval: BrowserEnrollmentApproval;
    let enrollment: StoredEnrollment;
    try {
      approval = JSON.parse(raw ?? 'null') as BrowserEnrollmentApproval;
      enrollment = JSON.parse(enrollmentRaw ?? 'null') as StoredEnrollment;
      if (!isBrowserEnrollmentApproval(approval) || canonicalBrowserEnrollmentRedemption(approval) !== canonicalBrowserEnrollmentRedemption(proof) ||
        enrollment?.workerId !== approval.workerId || enrollment.serverId !== approval.serverId ||
        enrollment.publicKey !== approval.publicKey || enrollment.pairingGeneration !== 0 ||
        enrollment.browserEnrollment == null || canonicalBrowserEnrollmentRedemption(enrollment.browserEnrollment) !== canonicalBrowserEnrollmentRedemption(proof) ||
        JSON.stringify(enrollment.binding) !== JSON.stringify(approval.binding) ||
        !/^[A-Za-z0-9_-]{24}$/.test(enrollment.identityId) || !/^[A-Za-z0-9_-]{24}$/.test(enrollment.generation)) {
        throw new Error('Invalid approval');
      }
    } catch {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment is unavailable or does not match its approval');
    }
    if (!verifyBrowserEnrollmentRedemption(approval.publicKey, proof, proof.signature)) {
      throw new BridgePairingError('PROOF_INVALID', 'Browser enrollment requires the approved machine key');
    }
    const credential: BridgeWorkerCredential = {
      workerId: approval.workerId,
      credential: randomBytes(32).toString('base64url'),
      expiresAt: new Date(Date.now() + this.credentialTtlSeconds * 1000).toISOString(),
    };
    const credentialDigest = digest(credential.credential);
    const stored: StoredCredential = {
      workerId: approval.workerId,
      identityId: enrollment.identityId,
      publicKey: approval.publicKey,
      expiresAt: credential.expiresAt,
      binding: approval.binding,
      enrollmentGeneration: enrollment.generation,
    };
    const workerPrefix = `${PREFIX}:worker:${encodeURIComponent(approval.workerId)}`;
    const encrypted = await this.redis.eval(
      REDEEM_BROWSER_ENROLLMENT_SCRIPT,
      14,
      key,
      `${key}:enrollment`,
      `${key}:fence`,
      workerPairingIndexKey(approval.workerId),
      workerPairingGenerationKey(approval.workerId),
      credentialDigestKey(credentialDigest),
      workerIdentityKey(approval.workerId),
      workerStableIdentityKey(approval.workerId),
      workerEnrollmentKey(approval.workerId),
      workerEnrollmentRequiredKey(approval.workerId),
      `${key}:result`,
      workerPrefix,
      `${workerPrefix}:incarnation`,
      `${workerPrefix}:registration-generation`,
      raw!,
      enrollmentRaw!,
      String(Date.parse(approval.expiresAt)),
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      credentialDigest,
      enrollment.identityId,
      String(this.recovery.enrollmentTtlSeconds ?? 0),
      enrollment.generation,
      encryptEnrollmentReplay(credential, raw!, replayKey),
      Date.parse(proof.expiresAt) > Date.now() ? '1' : '0',
    );
    if (typeof encrypted !== 'string') {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Browser enrollment is expired, revoked, or superseded');
    }
    return decryptEnrollmentReplay(encrypted, raw!, replayKey);
  }

  async limitUntrustedRecovery(
    peer: string,
    operation: 'challenge' | 'recover',
  ): Promise<void> {
    if (this.recovery == null) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Machine recovery is disabled');
    }
    const allowed = await this.redis.eval(
      LIMIT_RECOVERY_ATTEMPTS_SCRIPT,
      1,
      untrustedRecoveryRateKey(peer, operation),
      String(this.recovery.maxUntrustedRequestsPerMinute ?? DEFAULT_UNTRUSTED_RECOVERY_REQUESTS_PER_MINUTE),
    );
    if (allowed !== 1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many recovery requests from this peer');
    }
  }

  private checkedEnrollment(
    workerId: string,
    raw: string | null,
    pairingGeneration: string | null,
    requiredGeneration: string | null,
  ): StoredEnrollment {
    let parsed: unknown;
    try {
      parsed = raw == null ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const enrollment = (
      typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)
        ? parsed
        : {}
    ) as Partial<StoredEnrollment>;
    if (
      this.recovery == null ||
      enrollment.workerId !== workerId ||
      enrollment.serverId !== this.recovery.serverId ||
      typeof enrollment.identityId !== 'string' ||
      !/^[A-Za-z0-9_-]{24}$/.test(enrollment.identityId) ||
      typeof enrollment.generation !== 'string' ||
      !/^[A-Za-z0-9_-]{24}$/.test(enrollment.generation) ||
      enrollment.generation !== requiredGeneration ||
      typeof enrollment.publicKey !== 'string' ||
      !validEd25519PublicKey(enrollment.publicKey) ||
      !Number.isSafeInteger(enrollment.pairingGeneration) ||
      String(enrollment.pairingGeneration) !== (pairingGeneration ?? '0')
    ) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Machine enrollment is unavailable or revoked');
    }
    return enrollment as StoredEnrollment;
  }

  private checkEnrolledCredential(
    credential: StoredCredential,
    enrollment: StoredEnrollment,
  ): void {
    if (
      credential.workerId !== enrollment.workerId ||
      credential.identityId !== enrollment.identityId ||
      credential.publicKey !== enrollment.publicKey ||
      credential.enrollmentGeneration !== enrollment.generation ||
      JSON.stringify(credential.binding ?? null) !== JSON.stringify(enrollment.binding ?? null)
    ) {
      throw new BridgePairingError('CREDENTIAL_INVALID', 'Worker credential does not match its machine enrollment');
    }
  }

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
    const pairingGeneration = pairing.generation ?? Number(
      (await this.redis.get(workerPairingGenerationKey(args.workerId))) ?? '0',
    );
    const enrollment: StoredEnrollment | undefined = this.recovery == null
      ? undefined
      : {
        workerId: args.workerId,
        serverId: this.recovery.serverId,
        identityId,
        generation: randomBytes(18).toString('base64url'),
        pairingGeneration,
        publicKey: args.publicKey,
        binding: pairing.binding,
      };
    const stored: StoredCredential = {
      workerId: args.workerId,
      identityId,
      publicKey: args.publicKey,
      expiresAt,
      binding: pairing.binding,
      ...(enrollment == null ? {} : { enrollmentGeneration: enrollment.generation }),
    };
    const accepted = await this.redis.eval(
      REDEEM_PAIRING_SCRIPT,
      8,
      codeKey,
      workerPairingGenerationKey(pairing.workerId),
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
      workerPairingIndexKey(args.workerId),
      workerStableIdentityKey(args.workerId),
      workerEnrollmentKey(args.workerId),
      workerEnrollmentRequiredKey(args.workerId),
      raw,
      pairing.generation == null ? '' : String(pairing.generation),
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      credentialDigest,
      identityId,
      enrollment == null ? '' : JSON.stringify(enrollment),
      String(this.recovery?.enrollmentTtlSeconds ?? 0),
      String(pairingGeneration),
      enrollment?.generation ?? '',
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
    const [raw, activeDigest, pairingGeneration, enrollmentRaw, requiredGeneration] = await this.redis.mget(
      credentialDigestKey(credentialDigest),
      workerIdentityKey(args.workerId),
      workerPairingGenerationKey(args.workerId),
      workerEnrollmentKey(args.workerId),
      workerEnrollmentRequiredKey(args.workerId),
    );
    if (raw == null || activeDigest == null) {
      throw new BridgePairingError(
        'CREDENTIAL_INVALID',
        'Worker credential is invalid or expired',
      );
    }
    const stored = JSON.parse(raw) as StoredCredential;
    if (stored.enrollmentGeneration != null || requiredGeneration != null || enrollmentRaw != null) {
      this.checkEnrolledCredential(
        stored,
        this.checkedEnrollment(args.workerId, enrollmentRaw, pairingGeneration, requiredGeneration),
      );
    }
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

  async createRecoveryChallenge(
    workerId: string,
    request: BridgeRecoveryStartProofInput,
    signature: string,
  ): Promise<BridgeRecoveryChallenge> {
    if (this.recovery == null) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Machine recovery is disabled');
    }
    const [raw, pairingGeneration, requiredGeneration] = await this.redis.mget(
      workerEnrollmentKey(workerId),
      workerPairingGenerationKey(workerId),
      workerEnrollmentRequiredKey(workerId),
    );
    const enrollment = this.checkedEnrollment(workerId, raw, pairingGeneration, requiredGeneration);
    const proofTime = Date.parse(request.timestamp);
    if (
      String(request.operation) !== 'credential.challenge' ||
      request.serverId !== enrollment.serverId ||
      request.workerId !== workerId ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.nonce) ||
      !Number.isFinite(proofTime) ||
      Math.abs(Date.now() - proofTime) > PROOF_CLOCK_SKEW_MS ||
      !verifyBridgeRecoveryStart(enrollment.publicKey, request, signature)
    ) {
      throw new BridgePairingError('PROOF_INVALID', 'Machine recovery challenge proof is invalid');
    }
    const challenge: BridgeRecoveryChallenge = {
      operation: 'credential.recover',
      serverId: enrollment.serverId,
      workerId,
      enrollmentGeneration: enrollment.generation,
      challenge: randomBytes(32).toString('base64url'),
      expiresAt: new Date(
        Date.now() + (this.recovery.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS) * 1000,
      ).toISOString(),
    };
    const created = await this.redis.eval(
      CREATE_RECOVERY_CHALLENGE_SCRIPT,
      6,
      workerEnrollmentKey(workerId),
      recoveryRateKey(workerId, enrollment.generation, 'start'),
      recoveryChallengeKey(challenge.challenge),
      workerPairingGenerationKey(workerId),
      workerEnrollmentRequiredKey(workerId),
      recoveryStartNonceKey(workerId, request.nonce),
      raw!,
      String(this.recovery.maxChallengesPerMinute ?? DEFAULT_CHALLENGES_PER_MINUTE),
      JSON.stringify(challenge),
      String(enrollment.pairingGeneration),
      String(this.recovery.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS),
      enrollment.generation,
      String(RECOVERY_START_NONCE_TTL_SECONDS),
    );
    if (created === -2) {
      throw new BridgePairingError('PROOF_REPLAYED', 'Machine recovery challenge proof was already used');
    }
    if (created === -1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many machine recovery challenges');
    }
    if (created !== 1) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Machine enrollment is unavailable or revoked');
    }
    return challenge;
  }

  async recoverCredential(
    workerId: string,
    proof: BridgeRecoveryChallenge,
    signature: string,
  ): Promise<BridgeWorkerCredential> {
    if (this.recovery == null) {
      throw new BridgePairingError('ENROLLMENT_INVALID', 'Machine recovery is disabled');
    }
    const challengeKey = recoveryChallengeKey(proof.challenge);
    const [enrollmentRaw, challengeRaw, pairingGeneration, requiredGeneration] = await this.redis.mget(
      workerEnrollmentKey(workerId),
      challengeKey,
      workerPairingGenerationKey(workerId),
      workerEnrollmentRequiredKey(workerId),
    );
    const enrollment = this.checkedEnrollment(
      workerId, enrollmentRaw, pairingGeneration, requiredGeneration,
    );
    let parsed: unknown;
    try {
      parsed = challengeRaw == null ? undefined : JSON.parse(challengeRaw);
    } catch {
      parsed = undefined;
    }
    const saved = (
      typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)
        ? parsed
        : {}
    ) as Partial<BridgeRecoveryChallenge>;
    if (
      saved.operation !== 'credential.recover' ||
      saved.serverId !== enrollment.serverId ||
      saved.workerId !== workerId ||
      saved.enrollmentGeneration !== enrollment.generation ||
      saved.challenge !== proof.challenge ||
      saved.expiresAt !== proof.expiresAt ||
      String(proof.operation) !== saved.operation ||
      saved.serverId !== proof.serverId ||
      saved.workerId !== proof.workerId ||
      saved.enrollmentGeneration !== proof.enrollmentGeneration ||
      typeof saved.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(saved.expiresAt)) ||
      Date.parse(saved.expiresAt) <= Date.now()
    ) {
      throw new BridgePairingError('CHALLENGE_INVALID', 'Machine recovery challenge is invalid or expired');
    }
    // Invalid signatures can only exhaust the high-entropy challenge they know,
    // never the enrolled worker's shared quota. The worker-wide counter is
    // charged inside completion, after the key proof and replay checks.
    const attempts = await this.redis.eval(
      LIMIT_RECOVERY_ATTEMPTS_SCRIPT,
      1,
      recoveryChallengeAttemptKey(proof.challenge),
      String(this.recovery.maxAttemptsPerMinute ?? DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE),
    );
    if (attempts !== 1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many machine recovery attempts');
    }
    if (!verifyBridgeRecovery(enrollment.publicKey, saved as BridgeRecoveryChallenge, signature)) {
      throw new BridgePairingError('PROOF_INVALID', 'Machine recovery signature is invalid');
    }

    const credential = randomBytes(32).toString('base64url');
    const credentialDigest = digest(credential);
    const expiresAt = new Date(Date.now() + this.credentialTtlSeconds * 1000).toISOString();
    const stored: StoredCredential = {
      workerId,
      identityId: enrollment.identityId,
      publicKey: enrollment.publicKey,
      expiresAt,
      binding: enrollment.binding,
      enrollmentGeneration: enrollment.generation,
    };
    // The same Redis decision consumes the proof and issues the credential.
    // A revoke or replacement on another replica wins by invalidating the
    // enrollment/generation comparison, with no window to recreate trust.
    const issued = await this.redis.eval(
      COMPLETE_RECOVERY_CHALLENGE_SCRIPT,
      8,
      workerEnrollmentKey(workerId),
      challengeKey,
      credentialDigestKey(credentialDigest),
      workerIdentityKey(workerId),
      workerStableIdentityKey(workerId),
      workerPairingGenerationKey(workerId),
      workerEnrollmentRequiredKey(workerId),
      recoveryRateKey(workerId, enrollment.generation, 'complete'),
      enrollmentRaw!,
      challengeRaw!,
      String(enrollment.pairingGeneration),
      enrollment.identityId,
      JSON.stringify(stored),
      String(this.credentialTtlSeconds),
      credentialDigest,
      enrollment.generation,
      String(this.recovery.maxAttemptsPerMinute ?? DEFAULT_RECOVERY_ATTEMPTS_PER_MINUTE),
    );
    if (issued === -1) {
      throw new BridgePairingError('RECOVERY_RATE_LIMITED', 'Too many machine recoveries');
    }
    if (issued !== 1) {
      throw new BridgePairingError('CHALLENGE_INVALID', 'Machine recovery challenge is invalid or expired');
    }
    return { workerId, credential, expiresAt };
  }

  async revoke(workerId: string): Promise<void> {
    await this.removeLegacyPairings(workerId);
    // Fence redemption and consume the currently indexed code atomically. An
    // issue that linearized before this script is always removed; an issue
    // that linearizes afterward installs a distinct generation and code.
    await this.redis.eval(
      REVOKE_PAIRING_SCRIPT,
      8,
      workerPairingIndexKey(workerId),
      workerPairingGenerationKey(workerId),
      workerIdentityKey(workerId),
      workerStableIdentityKey(workerId),
      `${PREFIX}:worker:${encodeURIComponent(workerId)}`,
      `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation`,
      `${PREFIX}:worker:${encodeURIComponent(workerId)}:ready`,
      workerEnrollmentKey(workerId),
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
    let enrollment: StoredEnrollment | undefined;
    let enrollmentRaw: string | null = null;
    const [raw, generation, requiredGeneration] = await this.redis.mget(
      workerEnrollmentKey(workerId),
      workerPairingGenerationKey(workerId),
      workerEnrollmentRequiredKey(workerId),
    );
    if (previous.enrollmentGeneration != null || requiredGeneration != null || raw != null) {
      enrollment = this.checkedEnrollment(workerId, raw, generation, requiredGeneration);
      this.checkEnrolledCredential(previous, enrollment);
      enrollmentRaw = raw;
    }
    return await this.issueCredential(
      workerId,
      previous.publicKey,
      previousDigest,
      previous.binding,
      previous.identityId ?? null,
      enrollment,
      enrollmentRaw,
    );
  }

  private async issueCredential(
    workerId: string,
    publicKey: string,
    previousDigest?: string,
    binding?: BridgeWorkerBinding,
    identityId?: string | null,
    enrollment?: StoredEnrollment,
    enrollmentRaw?: string | null,
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
      ...(enrollment == null ? {} : { enrollmentGeneration: enrollment.generation }),
    };
    if (previousDigest !== undefined) {
      const rotated = await this.redis.eval(
        ROTATE_CREDENTIAL_SCRIPT,
        7,
        workerIdentityKey(workerId),
        credentialDigestKey(previousDigest),
        credentialDigestKey(credentialDigest),
        workerStableIdentityKey(workerId),
        workerEnrollmentKey(workerId),
        workerPairingGenerationKey(workerId),
        workerEnrollmentRequiredKey(workerId),
        previousDigest,
        credentialDigest,
        JSON.stringify(stored),
        String(this.credentialTtlSeconds),
        stableIdentityId ?? '',
        enrollmentRaw ?? '',
        String(enrollment?.pairingGeneration ?? ''),
        enrollment?.generation ?? '',
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
