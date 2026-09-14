import { createHash } from 'node:crypto';
import type IORedis from 'ioredis';
import type { AuthenticatedRequest } from './types';
import { getCredentialId } from './auth/principal';
import { getExecutionIdentity } from './execution-identity';

export const CODEAPI_PROGRAMMATIC_REQUEST_HEADER =
  'X-LibreChat-Code-Request-ID';
const REQUEST_PREFIX = 'codeapi:programmatic-cancellation:v1';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

interface CancellationTarget {
  queueName: string;
  jobId: string;
}

export type CancellationRequestResult =
  | { status: 'accepted'; target?: CancellationTarget }
  | { status: 'forbidden' };

function requestKey(requestId: string): string {
  return `${REQUEST_PREFIX}:${requestId}`;
}

export function normalizeProgrammaticRequestId(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function programmaticCancellationOwner(
  req: AuthenticatedRequest,
  userId: string,
): string {
  const identity = getExecutionIdentity(req, userId);
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.storageNamespace,
        identity.canonicalUserId,
        getCredentialId(req),
        identity.authContextHash ?? '',
      ]),
    )
    .digest('hex');
}

const RESERVE_SCRIPT = `
local key = KEYS[1]
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local existing = redis.call('HGET', key, 'owner')
if existing and existing ~= owner then return -1 end
if redis.call('HGET', key, 'reserved') == '1' then return -2 end
if not existing then
  redis.call('HSET', key, 'owner', owner, 'cancelled', '0')
end
redis.call('HSET', key, 'reserved', '1')
redis.call('EXPIRE', key, ttl)
return tonumber(redis.call('HGET', key, 'cancelled') or '0')
`;

const ATTACH_SCRIPT = `
local key = KEYS[1]
local owner = ARGV[1]
local queueName = ARGV[2]
local jobId = ARGV[3]
local ttl = tonumber(ARGV[4])
if redis.call('HGET', key, 'owner') ~= owner then return -1 end
redis.call('HSET', key, 'queueName', queueName, 'jobId', jobId)
redis.call('EXPIRE', key, ttl)
return tonumber(redis.call('HGET', key, 'cancelled') or '0')
`;

const CANCEL_SCRIPT = `
local key = KEYS[1]
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local existing = redis.call('HGET', key, 'owner')
if existing and existing ~= owner then return {-1} end
if not existing then redis.call('HSET', key, 'owner', owner) end
redis.call('HSET', key, 'cancelled', '1')
local queueName = redis.call('HGET', key, 'queueName')
local jobId = redis.call('HGET', key, 'jobId')
-- Once attached, never extend this mapping independently of the job decision.
-- Its original admission TTL already covers execution and late cancellation.
if queueName and jobId then return {1, queueName, jobId} end
redis.call('EXPIRE', key, ttl)
return {1}
`;

const RELEASE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  -- Keep the owner/target tombstone through its existing bounded TTL. A Stop
  -- racing response delivery must still reach the job's completion decision.
  return redis.call('HSET', KEYS[1], 'finished', '1')
end
return 0
`;

export async function reserveProgrammaticCancellation(args: {
  redis: IORedis;
  requestId: string;
  owner: string;
  ttlSeconds: number;
}): Promise<'active' | 'cancelled' | 'duplicate' | 'forbidden'> {
  const result = Number(
    await args.redis.eval(
      RESERVE_SCRIPT,
      1,
      requestKey(args.requestId),
      args.owner,
      Math.max(1, args.ttlSeconds),
    ),
  );
  if (result === -1) return 'forbidden';
  if (result === -2) return 'duplicate';
  return result === 1 ? 'cancelled' : 'active';
}

export async function attachProgrammaticCancellationTarget(args: {
  redis: IORedis;
  requestId: string;
  owner: string;
  target: CancellationTarget;
  ttlSeconds: number;
}): Promise<'active' | 'cancelled' | 'forbidden'> {
  const result = Number(
    await args.redis.eval(
      ATTACH_SCRIPT,
      1,
      requestKey(args.requestId),
      args.owner,
      args.target.queueName,
      args.target.jobId,
      Math.max(1, args.ttlSeconds),
    ),
  );
  if (result < 0) return 'forbidden';
  return result === 1 ? 'cancelled' : 'active';
}

export async function cancelProgrammaticRequest(args: {
  redis: IORedis;
  requestId: string;
  owner: string;
  ttlSeconds: number;
}): Promise<CancellationRequestResult> {
  const raw = await args.redis.eval(
    CANCEL_SCRIPT,
    1,
    requestKey(args.requestId),
    args.owner,
    Math.max(1, args.ttlSeconds),
  );
  const result = Array.isArray(raw) ? raw.map(String) : [];
  if (result[0] === '-1') return { status: 'forbidden' };
  if (result.length >= 3) {
    return {
      status: 'accepted',
      target: { queueName: result[1]!, jobId: result[2]! },
    };
  }
  return { status: 'accepted' };
}

export async function releaseProgrammaticCancellation(args: {
  redis: IORedis;
  requestId: string;
  owner: string;
}): Promise<void> {
  await args.redis.eval(
    RELEASE_SCRIPT,
    1,
    requestKey(args.requestId),
    args.owner,
  );
}

export const programmaticCancellationInternals = { requestKey };
