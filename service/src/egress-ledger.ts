import IORedis from 'ioredis';
import type { CommonRedisOptions } from 'ioredis';
import type * as tls from 'tls';
import { env } from './config';
import type { EgressGrantClaims } from './egress-grant';
import { EgressGrantError } from './egress-grant';
import logger from './logger';
import { redisKeepAliveOptions } from './redis-options';

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

let redis: IORedis | null = null;
const LEDGER_MUTATION_ATTEMPTS = 32;
const LEDGER_MUTATION_POOL_SIZE = Math.max(
    1,
    Number(process.env.CODEAPI_EGRESS_LEDGER_MUTATION_CONNECTIONS) || 32,
);

type MutationConnectionWaiter = {
    resolve: (client: IORedis) => void;
    reject: (error: Error) => void;
};

const mutationConnections = new Set<IORedis>();
let idleMutationConnections: IORedis[] = [];
let mutationConnectionWaiters: MutationConnectionWaiter[] = [];

export function setEgressLedgerRedisForTest(client: IORedis | null): void {
    resetMutationConnections();
    redis = client;
}

function ledgerKey(grantId: string): string {
    return `codeapi:egress:grant:${grantId}`;
}

function ttlSeconds(exp: number): number {
    return Math.max(
        1,
        exp -
            Math.floor(Date.now() / 1000) +
            env.EGRESS_LEDGER_TTL_GRACE_SECONDS,
    );
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
        maxRetriesPerRequest: 1,
        retryStrategy,
        enableReadyCheck: true,
        connectTimeout: 10000,
        ...redisKeepAliveOptions(),
        tls:
            process.env.REDIS_TLS === 'true'
                ? ({ rejectUnauthorized: false } as tls.ConnectionOptions)
                : undefined,
        ...(env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP
            ? {
                  dnsLookup: (
                      address: string,
                      callback: (err: Error | null, addr: string) => void,
                  ): void => callback(null, address),
              }
            : {}),
    });
    redis.on('error', error =>
        logger.error('Egress ledger Redis error', { error }),
    );
    return redis;
}

function resetMutationConnections(): void {
    const resetError = new Error('Egress ledger Redis connection reset');
    for (const waiter of mutationConnectionWaiters) {
        waiter.reject(resetError);
    }
    mutationConnectionWaiters = [];
    idleMutationConnections = [];
    for (const client of mutationConnections) {
        client.disconnect();
    }
    mutationConnections.clear();
}

async function dedicatedMutationConnection(): Promise<IORedis> {
    while (idleMutationConnections.length > 0) {
        const client = idleMutationConnections.pop()!;
        if (client.status !== 'end') {
            return client;
        }
        mutationConnections.delete(client);
    }

    if (mutationConnections.size < LEDGER_MUTATION_POOL_SIZE) {
        return createMutationConnection();
    }

    return new Promise((resolve, reject) => {
        mutationConnectionWaiters.push({ resolve, reject });
    });
}

function createMutationConnection(): IORedis {
    const client = redisConnection().duplicate();
    mutationConnections.add(client);
    client.on('error', error =>
        logger.error('Egress ledger mutation Redis error', { error }),
    );
    return client;
}

function releaseMutationConnection(client: IORedis): void {
    if (!mutationConnections.has(client) || client.status === 'end') {
        mutationConnections.delete(client);
        const waiter = mutationConnectionWaiters.shift();
        if (waiter) {
            try {
                waiter.resolve(createMutationConnection());
            } catch (error) {
                waiter.reject(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }
        return;
    }

    const waiter = mutationConnectionWaiters.shift();
    if (waiter) {
        waiter.resolve(client);
        return;
    }

    idleMutationConnections.push(client);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

export async function createEgressLedger(
    grant: EgressGrantClaims,
): Promise<void> {
    if (!grant.grant_id) {
        throw new EgressGrantError('malformed', 'Egress grant id is required');
    }
    if (!env.EGRESS_LEDGER_REQUIRED) return;
    await redisConnection().set(
        ledgerKey(grant.grant_id),
        JSON.stringify(recordFromGrant(grant)),
        'EX',
        ttlSeconds(grant.exp),
    );
}

export async function ensureEgressLedger(
    grant: EgressGrantClaims,
): Promise<void> {
    if (!grant.grant_id) {
        throw new EgressGrantError('malformed', 'Egress grant id is required');
    }
    if (!env.EGRESS_LEDGER_REQUIRED) return;
    await redisConnection().set(
        ledgerKey(grant.grant_id),
        JSON.stringify(recordFromGrant(grant)),
        'EX',
        ttlSeconds(grant.exp),
        'NX',
    );
}

async function loadRecord(grantId: string): Promise<EgressLedgerRecord> {
    const raw = await redisConnection().get(ledgerKey(grantId));
    if (!raw) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress grant ledger record is missing',
        );
    }
    return JSON.parse(raw) as EgressLedgerRecord;
}

function assertActive(
    record: EgressLedgerRecord,
    grant: Pick<EgressGrantClaims, 'grant_id' | 'exec_id'>,
): void {
    if (
        record.grant_id !== grant.grant_id ||
        record.exec_id !== grant.exec_id
    ) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress grant ledger record does not match token',
        );
    }
    if (record.status !== 'active') {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress grant has been revoked',
        );
    }
    if (record.exp <= Math.floor(Date.now() / 1000)) {
        throw new EgressGrantError('expired', 'Egress grant is expired');
    }
}

async function mutateRecord(
    grant: EgressGrantClaims,
    mutate: (record: EgressLedgerRecord) => void,
): Promise<EgressLedgerRecord> {
    if (!env.EGRESS_LEDGER_REQUIRED) {
        return recordFromGrant(grant);
    }
    const client = await dedicatedMutationConnection();
    const key = ledgerKey(grant.grant_id);
    try {
        for (let i = 0; i < LEDGER_MUTATION_ATTEMPTS; i++) {
            await client.watch(key);
            let record: EgressLedgerRecord;
            try {
                const raw = await client.get(key);
                if (!raw) {
                    throw new EgressGrantError(
                        'scope_mismatch',
                        'Egress grant ledger record is missing',
                    );
                }
                record = JSON.parse(raw) as EgressLedgerRecord;
                assertActive(record, grant);
                mutate(record);
                if (record.request_count > record.max_requests) {
                    throw new EgressGrantError(
                        'scope_mismatch',
                        'Egress grant request budget exceeded',
                    );
                }
            } catch (error) {
                await client.unwatch().catch(unwatchError => {
                    logger.warn(
                        'Failed to clear egress ledger WATCH after rejected mutation',
                        { error: unwatchError },
                    );
                });
                throw error;
            }
            const result = await client
                .multi()
                .set(key, JSON.stringify(record), 'EX', ttlSeconds(record.exp))
                .exec();
            if (result) return record;
            if (i < LEDGER_MUTATION_ATTEMPTS - 1) {
                await sleep(Math.min(25, i + 1));
            }
        }
    } finally {
        await client.unwatch().catch(error => {
            logger.warn(
                'Failed to clear egress ledger WATCH before returning mutation connection',
                { error },
            );
        });
        releaseMutationConnection(client);
    }
    throw new EgressGrantError(
        'scope_mismatch',
        'Egress grant ledger update conflicted',
    );
}

export async function assertEgressGrantActive(
    grant: EgressGrantClaims,
): Promise<EgressLedgerRecord> {
    if (!env.EGRESS_LEDGER_REQUIRED) return recordFromGrant(grant);
    const record = await loadRecord(grant.grant_id);
    assertActive(record, grant);
    return record;
}

export async function recordEgressRead(
    grant: EgressGrantClaims,
): Promise<void> {
    await mutateRecord(grant, record => {
        record.request_count += 1;
        record.read_count += 1;
    });
}

export async function reserveEgressUpload(args: {
    grant: EgressGrantClaims;
    fileId: string;
    bytes: number;
}): Promise<void> {
    await mutateRecord(args.grant, record => {
        if (
            args.bytes >
            Math.min(record.max_upload_bytes, env.EGRESS_GATEWAY_MAX_FILE_BYTES)
        ) {
            throw new EgressGrantError(
                'scope_mismatch',
                'Upload exceeds per-file egress byte limit',
            );
        }
        if (record.output_file_ids.includes(args.fileId)) {
            throw new EgressGrantError(
                'scope_mismatch',
                'Output file id has already been used for this grant',
            );
        }
        if (record.output_file_ids.length >= record.max_output_files) {
            throw new EgressGrantError(
                'scope_mismatch',
                'Output file count budget exceeded',
            );
        }
        const aggregateLimit =
            Math.min(
                record.max_upload_bytes,
                env.EGRESS_GATEWAY_MAX_FILE_BYTES,
            ) * record.max_output_files;
        if (record.uploaded_bytes + args.bytes > aggregateLimit) {
            throw new EgressGrantError(
                'scope_mismatch',
                'Aggregate upload byte budget exceeded',
            );
        }
        record.request_count += 1;
        record.upload_count += 1;
        record.uploaded_bytes += args.bytes;
        record.output_file_ids.push(args.fileId);
    });
}

export async function releaseEgressUpload(args: {
    grant: EgressGrantClaims;
    fileId: string;
    bytes: number;
}): Promise<void> {
    if (!env.EGRESS_LEDGER_REQUIRED) return;
    await mutateRecord(args.grant, record => {
        record.uploaded_bytes = Math.max(0, record.uploaded_bytes - args.bytes);
        record.upload_count = Math.max(0, record.upload_count - 1);
        record.request_count = Math.max(0, record.request_count - 1);
        record.output_file_ids = record.output_file_ids.filter(
            id => id !== args.fileId,
        );
    });
}

export async function recordEgressToolCall(
    grantId: string | undefined,
    executionId: string,
): Promise<void> {
    if (!env.EGRESS_LEDGER_REQUIRED || !grantId) return;
    const grant = {
        grant_id: grantId,
        exec_id: executionId,
    } as EgressGrantClaims;
    await mutateRecord(grant, record => {
        record.request_count += 1;
        record.tool_call_count += 1;
    });
}

export async function revokeEgressLedger(
    grantId: string,
    reason: string,
): Promise<void> {
    if (!env.EGRESS_LEDGER_REQUIRED) return;
    const key = ledgerKey(grantId);
    const raw = await redisConnection().get(key);
    if (!raw) return;
    const record = JSON.parse(raw) as EgressLedgerRecord;
    record.status = 'revoked';
    record.revoked_at = Math.floor(Date.now() / 1000);
    record.revoke_reason = reason;
    await redisConnection().set(
        key,
        JSON.stringify(record),
        'EX',
        ttlSeconds(record.exp),
    );
}
