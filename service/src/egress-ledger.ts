import IORedis from 'ioredis';
import type { CommonRedisOptions } from 'ioredis';
import type * as tls from 'tls';
import { env } from './config';
import type { EgressGrantClaims } from './egress-grant';
import { EgressGrantError } from './egress-grant';
import logger from './logger';
import { redisKeepAliveOptions } from './redis-options';
import { EGRESS_LEDGER_SCRIPT } from './egress-ledger-script';

type LedgerStatus = 'active' | 'revoked';

export interface EgressLedgerRecord {
  grant_id: string;
  exec_id: string;
  status: LedgerStatus;
  exp: number;
  revoked_at?: number;
  revoke_reason?: string;
  input_files: EgressGrantClaims['input_files'];
  read_sessions: string[];
  output_session_id: string;
  max_upload_bytes: number;
  max_output_files: number;
  max_requests: number;
  request_count: number;
  read_count: number;
  upload_count: number;
  tool_call_count: number;
  uploaded_bytes: number;
  output_file_ids: string[];
}

/** A lost reply is ambiguous: never replay a possibly applied mutation.
 * maxRetries=0 also rejects the pending promise on disconnect instead of leaving
 * it unresolved when ioredis discards its unfulfilled-command queue. */
export const EGRESS_LEDGER_REDIS_RETRY_OPTIONS = {
  autoResendUnfulfilledCommands: false,
  maxRetriesPerRequest: 0,
} as const;

let redis: IORedis | null = null;
const scriptClients = new WeakSet<IORedis>();
export function setEgressLedgerRedisForTest(client: IORedis | null): void {
  redis = client;
}

function ledgerKey(grantId: string): string {
  return `codeapi:egress:grant:${grantId}`;
}

function ttlSeconds(exp: number): number {
  return Math.max(1, exp - Math.floor(Date.now() / 1000) + env.EGRESS_LEDGER_TTL_GRACE_SECONDS);
}

function redisConnection(): IORedis {
  if (redis) return redis;
  const retryStrategy: CommonRedisOptions['retryStrategy'] = times => {
    if (times > 5) return null;
    return 2000;
  };
  redis = new IORedis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    ...EGRESS_LEDGER_REDIS_RETRY_OPTIONS,
    retryStrategy,
    enableReadyCheck: true,
    connectTimeout: 10000,
    ...redisKeepAliveOptions(),
    tls: process.env.REDIS_TLS === 'true'
      ? { rejectUnauthorized: false } as tls.ConnectionOptions
      : undefined,
    ...(env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP
      ? { dnsLookup: (address: string, callback: (err: Error | null, addr: string) => void): void => callback(null, address) }
      : {}),
  });
  redis.on('error', error => logger.error('Egress ledger Redis error', { error }));
  return redis;
}

export async function pingEgressLedger(): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  await redisConnection().ping();
}

function recordFromGrant(grant: EgressGrantClaims): EgressLedgerRecord {
  return {
    grant_id: grant.grant_id,
    exec_id: grant.exec_id,
    status: 'active',
    exp: grant.exp,
    input_files: grant.input_files,
    read_sessions: grant.read_sessions,
    output_session_id: grant.output_session_id,
    max_upload_bytes: grant.max_upload_bytes,
    max_output_files: grant.max_output_files,
    max_requests: grant.max_requests,
    request_count: 0,
    read_count: 0,
    upload_count: 0,
    tool_call_count: 0,
    uploaded_bytes: 0,
    output_file_ids: [],
  };
}

async function executeLedger(
  operation: string,
  grantId: string,
  executionId = '',
  extra: Array<string | number> = [],
): Promise<string | undefined> {
  const client = redisConnection() as IORedis & {
    executeEgressLedger: (...args: Array<string | number>) => Promise<string[]>;
  };
  if (!scriptClients.has(client)) {
    client.defineCommand('executeEgressLedger', { numberOfKeys: 1, lua: EGRESS_LEDGER_SCRIPT });
    scriptClients.add(client);
  }
  const result = await client.executeEgressLedger(
    ledgerKey(grantId), operation, executionId,
    Math.floor(Date.now() / 1000), ...extra,
  ) as string[];
  if (result[0] === 'error') {
    throw new EgressGrantError(result[1] as EgressGrantError['reason'], result[2]);
  }
  return result[1];
}

export async function createEgressLedger(grant: EgressGrantClaims): Promise<void> {
  if (!grant.grant_id) throw new EgressGrantError('malformed', 'Egress grant id is required');
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  await executeLedger('create', grant.grant_id, grant.exec_id, [
    JSON.stringify(recordFromGrant(grant)), env.EGRESS_LEDGER_COMPACT ? 'compact' : 'legacy', ttlSeconds(grant.exp),
  ]);
}

/** Admission is idempotent: neither replay nor rolling deployment resets budgets or revocation. */
export const ensureEgressLedger = createEgressLedger;

/** Authorization hot path deliberately does not return the potentially large input policy. */
export async function checkEgressGrantActive(grant: Pick<EgressGrantClaims, 'grant_id' | 'exec_id'>): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  await executeLedger('check', grant.grant_id, grant.exec_id);
}

export async function assertEgressGrantActive(grant: EgressGrantClaims): Promise<EgressLedgerRecord> {
  if (!env.EGRESS_LEDGER_REQUIRED) return recordFromGrant(grant);
  const record = JSON.parse((await executeLedger('snapshot', grant.grant_id, grant.exec_id))!) as EgressLedgerRecord;
  // Redis cjson represents empty Lua arrays as objects.
  if (!Array.isArray(record.output_file_ids)) record.output_file_ids = [];
  if (!Array.isArray(record.input_files)) record.input_files = [];
  if (!Array.isArray(record.read_sessions)) record.read_sessions = [];
  return record;
}

export async function recordEgressRead(grant: EgressGrantClaims): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  await executeLedger('read', grant.grant_id, grant.exec_id, ['', 0]);
}

export async function reserveEgressUpload(args: { grant: EgressGrantClaims; fileId: string; bytes: number }): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  if (!Number.isSafeInteger(args.bytes) || args.bytes < 0) throw new EgressGrantError('scope_mismatch', 'Invalid upload byte count');
  await executeLedger('reserve', args.grant.grant_id, args.grant.exec_id, [args.fileId, args.bytes, env.EGRESS_GATEWAY_MAX_FILE_BYTES]);
}

export async function releaseEgressUpload(args: { grant: EgressGrantClaims; fileId: string; bytes: number }): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  if (!Number.isSafeInteger(args.bytes) || args.bytes < 0) throw new EgressGrantError('scope_mismatch', 'Invalid upload byte count');
  await executeLedger('release', args.grant.grant_id, args.grant.exec_id, [args.fileId, args.bytes]);
}

export async function recordEgressToolCall(grantId: string | undefined, executionId: string): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED || !grantId) return;
  await executeLedger('tool', grantId, executionId, ['', 0]);
}

export async function revokeEgressLedger(grantId: string, reason: string): Promise<void> {
  if (!env.EGRESS_LEDGER_REQUIRED) return;
  await executeLedger('revoke', grantId, '', [reason]);
}
