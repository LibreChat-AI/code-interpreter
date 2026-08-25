import IORedis from 'ioredis';
import type * as tls from 'tls';
import { isValidId } from '../src/utils';
import { redisKeepAliveOptions } from '../src/redis-options';

/**
 * One-time recovery for session ownership keys that expired before the
 * associated files were removed.
 *
 * Build the input from a trusted source that provides the exact session id and
 * expected session key pairs. Keep recovery manifests outside this repository
 * because session keys can contain tenant and user identifiers.
 *
 * Pipe newline-delimited JSON to this script. Run it without `--apply` first:
 *
 *   {"type":"source","environment":"example","region":"region-1","namespace":"codeapi","query_start_utc":"2026-01-01T00:00:00Z","query_end_utc":"2026-01-02T00:00:00Z"}
 *   {"session_id":"<21-character id>","expected_session_key":"<expected key>"}
 *
 * The apply path uses SET NX and never replaces an existing owner.
 */

const DEFAULT_SESSION_CACHE_TTL_SECONDS = 86400;
const MAX_RECOVERY_CONTEXT_LENGTH = 128;
const MAX_RECOVERY_SESSION_KEY_LENGTH = 512;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

export interface RecoverySource {
  type: 'source';
  environment: string;
  region: string;
  namespace: string;
  query_start_utc: string;
  query_end_utc: string;
}

export interface RecoveryRecord {
  session_id: string;
  expected_session_key: string;
}

export interface RecoveryStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
}

export interface RecoverySummary {
  input: number;
  missing: number;
  restored: number;
  matching: number;
  conflicts: number;
}

export class RecoveryInterruptedError extends Error {
  readonly summary: RecoverySummary;

  constructor(error: unknown, summary: RecoverySummary) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'RecoveryInterruptedError';
    this.summary = { ...summary };
  }
}

interface RecoveryScope {
  environment: string;
  region: string;
  namespace: string;
}

interface Options extends RecoveryScope {
  apply: boolean;
  inputPath?: string;
  ttlSeconds: number;
}

function usage(): string {
  return `Usage: bun run /app/.build-migrations/rehydrate-session-cache.js [options]

Restores missing Redis session ownership keys so retained files can be cleaned
up normally. Input is JSONL on stdin by default. The first record must be a
source header whose environment, region, and namespace match the configured
recovery scope.

Options:
  --apply                 Write missing keys. Without this flag, only inspect.
  --input <path>          Read JSONL from a file instead of stdin.
  --environment <value>   Expected source environment. Defaults to
                          SESSION_RECOVERY_ENVIRONMENT.
  --region <value>        Expected source region. Defaults to
                          SESSION_RECOVERY_REGION.
  --namespace <value>     Expected source namespace. Defaults to
                          SESSION_RECOVERY_NAMESPACE.
  --ttl-seconds <number>  Redis TTL for restored keys. Defaults to
                          SESSION_CACHE_TTL or ${DEFAULT_SESSION_CACHE_TTL_SECONDS}.
  --help                  Show this help.

Keep recovery manifests outside the repository because expected_session_key
values can contain tenant and user identifiers. Add --apply only after
reviewing the dry-run summary.

Exit codes:
  0  Completed without conflicts (dry-run missing keys are expected).
  1  Invalid input, configuration error, or interrupted Redis operation.
  2  Apply left a key missing or found an ownership conflict.`;
}

function parsePositiveInteger(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseRecoveryContext(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (value == null || value === '') {
    throw new Error(`${name} is required`);
  }
  if (
    value.length > MAX_RECOVERY_CONTEXT_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
  ) {
    throw new Error(
      `${name} must be ${MAX_RECOVERY_CONTEXT_LENGTH} or fewer safe characters`,
    );
  }
  return value;
}

function optionValue(args: string[], index: number, name: string): string {
  if (index + 1 >= args.length) {
    throw new Error(`${name} requires a value`);
  }
  const value = args[index + 1];
  if (value === '' || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseOptions(args: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const configuredTtl = env.SESSION_CACHE_TTL?.trim();
  let ttlSeconds = configuredTtl != null && configuredTtl !== ''
    ? parsePositiveInteger(configuredTtl, 'SESSION_CACHE_TTL')
    : DEFAULT_SESSION_CACHE_TTL_SECONDS;
  let environment = env.SESSION_RECOVERY_ENVIRONMENT;
  let region = env.SESSION_RECOVERY_REGION;
  let namespace = env.SESSION_RECOVERY_NAMESPACE;
  let apply = false;
  let inputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
    case '--apply':
      apply = true;
      break;
    case '--input':
      inputPath = optionValue(args, index, '--input');
      index += 1;
      break;
    case '--environment':
      environment = optionValue(args, index, '--environment');
      index += 1;
      break;
    case '--region':
      region = optionValue(args, index, '--region');
      index += 1;
      break;
    case '--namespace':
      namespace = optionValue(args, index, '--namespace');
      index += 1;
      break;
    case '--ttl-seconds':
      ttlSeconds = parsePositiveInteger(
        optionValue(args, index, '--ttl-seconds'),
        '--ttl-seconds',
      );
      index += 1;
      break;
    case '--help':
      break;
    default:
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    apply,
    inputPath,
    environment: parseRecoveryContext(environment, 'Recovery environment'),
    region: parseRecoveryContext(region, 'Recovery region'),
    namespace: parseRecoveryContext(namespace, 'Recovery namespace'),
    ttlSeconds,
  };
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseRecoverySource(value: unknown, expected: RecoveryScope): RecoverySource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The first input record must be a recovery source header');
  }
  const source = value as Record<string, unknown>;
  let environment: string;
  let region: string;
  let namespace: string;
  try {
    environment = parseRecoveryContext(
      typeof source.environment === 'string' ? source.environment : undefined,
      'Source environment',
    );
    region = parseRecoveryContext(
      typeof source.region === 'string' ? source.region : undefined,
      'Source region',
    );
    namespace = parseRecoveryContext(
      typeof source.namespace === 'string' ? source.namespace : undefined,
      'Source namespace',
    );
  } catch {
    throw new Error('Recovery source contains invalid environment, region, or namespace');
  }
  if (
    source.type !== 'source'
    || environment !== expected.environment
    || region !== expected.region
    || namespace !== expected.namespace
    || !isUtcTimestamp(source.query_start_utc)
    || !isUtcTimestamp(source.query_end_utc)
  ) {
    throw new Error(
      `Recovery source must match ${expected.environment}/${expected.region}/${expected.namespace}`,
    );
  }
  if (Date.parse(source.query_start_utc) >= Date.parse(source.query_end_utc)) {
    throw new Error('Recovery source query_start_utc must be before query_end_utc');
  }
  return {
    type: 'source',
    environment,
    region,
    namespace,
    query_start_utc: source.query_start_utc,
    query_end_utc: source.query_end_utc,
  };
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.session_id === 'string'
    && isValidId(record.session_id)
    && typeof record.expected_session_key === 'string'
    && record.expected_session_key.length <= MAX_RECOVERY_SESSION_KEY_LENGTH
    && /^[A-Za-z0-9_.:-]+$/.test(record.expected_session_key);
}

export function parseRecoveryManifest(
  input: string,
  expected: RecoveryScope,
): { source: RecoverySource; records: RecoveryRecord[] } {
  const bySessionId = new Map<string, RecoveryRecord>();
  const lines = input.split(/\r?\n/);
  let source: RecoverySource | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Input line ${index + 1} is not valid JSON`);
    }
    if (!source) {
      source = parseRecoverySource(value, expected);
      continue;
    }
    if (!isRecoveryRecord(value)) {
      throw new Error(
        `Input line ${index + 1} must contain a valid session_id and expected_session_key`,
      );
    }

    const previous = bySessionId.get(value.session_id);
    if (previous && previous.expected_session_key !== value.expected_session_key) {
      throw new Error(`Input contains conflicting owners for session ${value.session_id}`);
    }
    bySessionId.set(value.session_id, value);
  }

  if (bySessionId.size === 0) {
    throw new Error('Input contains no recovery records');
  }
  if (!source) {
    throw new Error('Input contains no recovery source header');
  }
  return { source, records: [...bySessionId.values()] };
}

export async function recoverSessionCache(
  records: RecoveryRecord[],
  store: RecoveryStore,
  options: Pick<Options, 'apply' | 'ttlSeconds'>,
): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    input: records.length,
    missing: 0,
    restored: 0,
    matching: 0,
    conflicts: 0,
  };

  for (const record of records) {
    try {
      const redisKey = `session:${record.session_id}`;
      const current = await store.get(redisKey);
      if (current === record.expected_session_key) {
        summary.matching += 1;
        continue;
      }
      if (current !== null) {
        summary.conflicts += 1;
        // eslint-disable-next-line no-console
        console.error(`Conflict: ${record.session_id} already has a different owner`);
        continue;
      }

      if (!options.apply) {
        summary.missing += 1;
        continue;
      }

      const result = await store.set(
        redisKey,
        record.expected_session_key,
        'EX',
        options.ttlSeconds,
        'NX',
      );
      if (result === 'OK') {
        summary.restored += 1;
        continue;
      }

      const racedValue = await store.get(redisKey);
      if (racedValue === record.expected_session_key) {
        summary.matching += 1;
      } else if (racedValue === null) {
        summary.missing += 1;
        // eslint-disable-next-line no-console
        console.error(`Missing: ${record.session_id} disappeared during recovery`);
      } else {
        summary.conflicts += 1;
        // eslint-disable-next-line no-console
        console.error(`Conflict: ${record.session_id} changed during recovery`);
      }
    } catch (error) {
      throw new RecoveryInterruptedError(error, summary);
    }
  }

  return summary;
}

function redisRetryStrategy(times: number): number | null {
  return times > MAX_RECONNECT_ATTEMPTS ? null : RECONNECT_DELAY_MS;
}

function createRedisClient(): IORedis {
  const options = {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 1,
    retryStrategy: redisRetryStrategy,
    enableReadyCheck: true,
    connectTimeout: 10000,
    disconnectTimeout: 2000,
    ...redisKeepAliveOptions(),
    tls: process.env.REDIS_TLS === 'true'
      ? { rejectUnauthorized: false } as tls.ConnectionOptions
      : undefined,
    ...(process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true'
      ? {
        dnsLookup: (
          address: string,
          callback: (err: Error | null, addr: string) => void,
        ): void => callback(null, address),
      }
      : {}),
  };
  return new IORedis(options);
}

async function readInput(inputPath?: string): Promise<string> {
  if (inputPath != null && inputPath !== '') {
    return Bun.file(inputPath).text();
  }
  if (process.stdin.isTTY === true) {
    throw new Error('No manifest input: pipe JSONL on stdin or use --input <path>');
  }
  return Bun.stdin.text();
}

function recoveryOutput(
  options: Options,
  source: RecoverySource,
  summary: RecoverySummary,
): Record<string, string | number> {
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    environment: source.environment,
    region: source.region,
    namespace: source.namespace,
    ttlSeconds: options.ttlSeconds,
    ...summary,
  };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return 0;
  }

  let client: IORedis | undefined;
  let options: Options | undefined;
  let source: RecoverySource | undefined;
  try {
    options = parseOptions(args);
    const manifest = parseRecoveryManifest(await readInput(options.inputPath), options);
    source = manifest.source;
    client = createRedisClient();
    const summary = await recoverSessionCache(manifest.records, client, options);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(recoveryOutput(options, source, summary)));
    const incompleteApply = options.apply && summary.missing > 0;
    return summary.conflicts === 0 && !incompleteApply ? 0 : 2;
  } catch (error) {
    if (
      error instanceof RecoveryInterruptedError
      && options != null
      && source != null
    ) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(recoveryOutput(options, source, error.summary)));
    }
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (client != null) {
      await client.quit().catch(() => client?.disconnect());
    }
  }
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
