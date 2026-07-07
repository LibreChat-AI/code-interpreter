import { existsSync, readFileSync } from 'fs';
import IORedis, { Cluster } from 'ioredis';
import type {
    Redis,
    RedisOptions,
    ClusterOptions,
    CommonRedisOptions,
} from 'ioredis';
import { redisKeepAliveOptions } from './redis-options';
import logger from './logger';

export type RedisClient = Redis | Cluster;

const MAX_CLUSTER_RECONNECT_ATTEMPTS = 5;

/**
 * Parse REDIS_HOST into an array of {host, port} startup nodes.
 * Accepts comma-separated entries in "host:port" or plain "host" format.
 * Falls back to REDIS_PORT (default 6379) when no port is embedded.
 */
export function parseRedisNodes(): Array<{ host: string; port: number }> {
    const defaultPort = Number(process.env.REDIS_PORT) || 6379;
    const raw = process.env.REDIS_HOST ?? 'redis';
    return raw.split(',').map(entry => {
        const trimmed = entry.trim();
        const colonIdx = trimmed.lastIndexOf(':');
        if (colonIdx > 0) {
            const potentialPort = Number(trimmed.slice(colonIdx + 1));
            if (Number.isInteger(potentialPort) && potentialPort > 0) {
                return {
                    host: trimmed.slice(0, colonIdx),
                    port: potentialPort,
                };
            }
        }
        return { host: trimmed, port: defaultPort };
    });
}

/**
 * Returns true when Redis Cluster mode is active.
 * Cluster mode is enabled when USE_REDIS_CLUSTER=true or REDIS_HOST contains
 * a comma-separated list of nodes.
 */
export function isClusterMode(): boolean {
    return (
        process.env.USE_REDIS_CLUSTER === 'true' ||
        (process.env.REDIS_HOST ?? '').includes(',')
    );
}

/**
 * Read and return the PEM-encoded CA certificate from the path given by the
 * REDIS_CA environment variable.  Returns null when the variable is unset or
 * the file cannot be read.
 */
function readCACert(): string | null {
    const caPath = process.env.REDIS_CA;
    if (!caPath) return null;
    try {
        if (!existsSync(caPath)) {
            logger.warn(`Redis CA certificate file not found: ${caPath}`);
            return null;
        }
        return readFileSync(caPath, 'utf8');
    } catch (error) {
        logger.error(`Failed to read Redis CA certificate: ${caPath}`, {
            error,
        });
        return null;
    }
}

/**
 * Build the TLS options for an ioredis connection:
 * - REDIS_CA points to a file → use that CA (certificate fully validated).
 * - REDIS_TLS=true without a CA → disable certificate validation (backward-compatible).
 * - Neither set → no TLS.
 */
export function buildTlsOptions(): Record<string, unknown> | undefined {
    const ca = readCACert();
    if (ca) return { ca };
    if (process.env.REDIS_TLS === 'true') return { rejectUnauthorized: false };
    return undefined;
}

/**
 * Returns the BullMQ `prefix` required in cluster mode so that all queue keys
 * land in the same hash slot.  Returns undefined in standalone mode (no prefix).
 */
export function bullmqPrefix(): string | undefined {
    return isClusterMode() ? '{codeapi}' : undefined;
}

type ConnectionOverrides = Partial<
    Pick<
        CommonRedisOptions,
        | 'maxRetriesPerRequest'
        | 'enableReadyCheck'
        | 'retryStrategy'
        | 'reconnectOnError'
        | 'disconnectTimeout'
    >
>;

/**
 * Create an ioredis client – standalone `Redis` or `Cluster` – based on the
 * current environment configuration.
 *
 * Callers supply per-client `overrides` (retry strategy, maxRetriesPerRequest,
 * enableReadyCheck, …) to preserve each component's existing connection semantics.
 *
 * In cluster mode the overrides are forwarded to `redisOptions` (applied
 * per-node).  The cluster-level reconnect loop is handled independently via
 * `clusterRetryStrategy`.
 */
export function createRedisConnection(
    overrides: ConnectionOverrides,
): RedisClient {
    const tls = buildTlsOptions() as RedisOptions['tls'];
    const dnsLookup: ClusterOptions['dnsLookup'] | undefined =
        process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true'
            ? (address, callback) => callback(null, address)
            : undefined;

    const baseOptions: RedisOptions = {
        password: process.env.REDIS_PASSWORD,
        connectTimeout: 10000,
        ...redisKeepAliveOptions(),
        ...(tls !== undefined ? { tls } : {}),
        ...(dnsLookup ? { dnsLookup } : {}),
        ...overrides,
    };

    if (isClusterMode()) {
        const nodes = parseRedisNodes();
        return new Cluster(nodes, {
            ...(dnsLookup ? { dnsLookup } : {}),
            redisOptions: baseOptions,
            clusterRetryStrategy(times) {
                if (times > MAX_CLUSTER_RECONNECT_ATTEMPTS) {
                    logger.error(
                        `Redis cluster giving up after ${times} reconnection attempts`,
                    );
                    return null;
                }
                const base = Math.min(2 ** times * 100, 3000);
                const jitter = Math.floor(Math.random() * Math.min(base, 1000));
                return Math.min(base + jitter, 3000);
            },
            enableOfflineQueue: true,
        });
    }

    const [{ host, port }] = parseRedisNodes();
    return new IORedis({ host, port, ...baseOptions });
}
