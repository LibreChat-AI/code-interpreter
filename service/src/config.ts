import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';
import type * as t from './types';
import { Languages } from './enum';
import {
  resolveExecutionProfile,
  resolveExecutionProfileSource,
} from './execution-profile';

export const languageConfig: Record<Languages | string, t.LanguageConfig | undefined> = {
  [Languages.bash]: { language: 'bash', version: '5.2.0', fileName: 'script.sh' },
  [Languages.js]: { language: 'bun-js', version: '1.3.14', fileName: 'index.js' },
  [Languages.node]: { language: 'node', version: '24.15.0', fileName: 'index.js' },
  [Languages.py]: { language: 'python', version: '3.14.4', fileName: 'main.py' },
  [Languages.ts]: { language: 'bun-ts', version: '1.3.14', fileName: 'main.ts' },
};

const languageAliases: Record<string, Languages> = {
  // Python
  python: Languages.py,
  py: Languages.py,

  // JavaScript (Bun)
  javascript: Languages.js,
  js: Languages.js,
  'bun-js': Languages.js,
  bun: Languages.js,

  // JavaScript (Node.js)
  node: Languages.node,
  nodejs: Languages.node,
  'node-js': Languages.node,
  'node-javascript': Languages.node,

  // TypeScript (Bun)
  typescript: Languages.ts,
  ts: Languages.ts,
  'bun-ts': Languages.ts,
  'bun-typescript': Languages.ts,

  // Bash
  bash: Languages.bash,
  sh: Languages.bash,
};

export function resolveLanguage(lang: string): Languages | undefined {
  return languageAliases[lang.toLowerCase()];
}

const defaultJobTimeoutMs = Number(process.env.JOB_TIMEOUT) || 300000;
const defaultMaxFileSize = Number(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;
const defaultExecutionManifestTtlSeconds = Math.min(Math.ceil((defaultJobTimeoutMs + 60000) / 1000), 600);
const EGRESS_GRANT_GRACE_MS = 10 * 60 * 1000;
/** Object-store listing and marker writes are metadata operations, not
 * checkpoint transfers. Bound each tightly so the post-exec checkpoint
 * reserve does not consume a full transfer timeout for a tiny request. */
export const CHECKPOINT_METADATA_TIMEOUT_CAP_MS = 5_000;
/** Hard caller-side deadline for one direct runtime-session registry command.
 * Keep this beside the checkpoint budget calculation so the optional
 * post-exec pipeline and the registry implementation share one value without
 * making config import the Redis-backed registry module. */
export const RUNTIME_SESSION_REDIS_COMMAND_TIMEOUT_MS = 5_000;

/** Registry operations on the successful post-exec checkpoint path:
 * outer settled read, checkpoint read, sequence allocation, pointer CAS,
 * post-store reread, and final record CAS. */
const POST_EXEC_CHECKPOINT_REGISTRY_COMMANDS = 6;

/** Worst-case time reserved after a successful session execute for the
 * checkpoint pipeline:
 *   shared token-mint budget + guest pull + object listing + object upload +
 *   marker + every sequential runtime-session registry command.
 * The two large transfers receive the configured transfer timeout; the two
 * metadata operations receive the smaller metadata cap. */
export function checkpointPipelineBudgetMs(
  launchTimeoutMs: number,
  checkpointTimeoutMs: number,
): number {
  const metadataTimeoutMs = Math.min(
    checkpointTimeoutMs,
    CHECKPOINT_METADATA_TIMEOUT_CAP_MS,
  );
  return launchTimeoutMs
    + 2 * checkpointTimeoutMs
    + 2 * metadataTimeoutMs
    + POST_EXEC_CHECKPOINT_REGISTRY_COMMANDS
      * RUNTIME_SESSION_REDIS_COMMAND_TIMEOUT_MS;
}

/** BullMQ's `timestamp` is the enqueue time. Anchor the worker deadline to it
 * so queueing consumes the same caller-visible JOB_TIMEOUT budget instead of
 * granting a second full timeout after a delayed job finally starts. */
export function jobDeadlineAtMs(
  enqueuedAtMs: number | undefined,
  timeoutMs: number,
  nowMs: number = Date.now(),
): number {
  return Number.isFinite(enqueuedAtMs) && (enqueuedAtMs as number) > 0
    ? (enqueuedAtMs as number) + timeoutMs
    : nowMs + timeoutMs;
}

/** The worker stops user work at JOB_TIMEOUT, then may still need to terminate
 * a MicroVM, revoke an egress grant, release locks, and publish the BullMQ
 * failure. Keep HTTP waiters alive for those bounded cleanup legs so they
 * receive the typed failure instead of racing BullMQ's own wait timeout. */
export const WORKER_COMPLETION_OVERHEAD_MS = 5_000;

export function jobCompletionWaitTimeoutMs(
  jobTimeoutMs: number,
  backendCleanupTimeoutMs: number,
  egressRevokeTimeoutMs: number,
): number {
  return jobTimeoutMs
    + backendCleanupTimeoutMs
    + egressRevokeTimeoutMs
    + WORKER_COMPLETION_OVERHEAD_MS;
}

export function parseArnList(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

export interface LambdaMicrovmNumericConfig {
  LAMBDA_MICROVM_PORT: number;
  LAMBDA_MICROVM_MAX_DURATION_SECONDS: number;
  LAMBDA_MICROVM_IDLE_SECONDS: number;
  LAMBDA_MICROVM_SUSPEND_SECONDS: number;
  LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: number;
  LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: number;
  LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: number;
  LAMBDA_MICROVM_LAUNCH_TPS: number;
  LAMBDA_MICROVM_TOKEN_TPS: number;
}

type LambdaMicrovmNumericEnv = Record<string, string | undefined>;

interface IntegerRange {
  min: number;
  max?: number;
}

const lambdaMicrovmNumericRanges: Record<keyof LambdaMicrovmNumericConfig, IntegerRange> = {
  LAMBDA_MICROVM_PORT: { min: 1, max: 65_535 },
  LAMBDA_MICROVM_MAX_DURATION_SECONDS: { min: 1, max: 28_800 },
  LAMBDA_MICROVM_IDLE_SECONDS: { min: 60, max: 28_800 },
  LAMBDA_MICROVM_SUSPEND_SECONDS: { min: 0, max: 28_800 },
  /* Keep proxy credentials shorter than the AWS 60-minute maximum. */
  LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: { min: 1, max: 900 },
  LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: { min: 1 },
  LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: { min: 1 },
  LAMBDA_MICROVM_LAUNCH_TPS: { min: 1 },
  LAMBDA_MICROVM_TOKEN_TPS: { min: 1 },
};

const lambdaMicrovmNumericDefaults: LambdaMicrovmNumericConfig = {
  LAMBDA_MICROVM_PORT: 8080,
  LAMBDA_MICROVM_MAX_DURATION_SECONDS: 28_800,
  /* 30min keeps a session's VM fully RUNNING (RAM + page cache live, ~0.3s
   * follow-ups) across a realistic conversation gap before it suspends;
   * 5min proved too aggressive — heavy libraries (chdb ~400MB) pay a
   * 30-120s lazy rootfs re-read whenever the cache is lost. */
  LAMBDA_MICROVM_IDLE_SECONDS: 1_800,
  LAMBDA_MICROVM_SUSPEND_SECONDS: 1_800,
  LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: 300,
  LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: 60_000,
  LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: 5_000,
  LAMBDA_MICROVM_LAUNCH_TPS: 4,
  LAMBDA_MICROVM_TOKEN_TPS: 8,
};

/** Parse configured values without `||` so an intentional zero survives long
 * enough for the range validator to accept it where AWS does (suspend duration)
 * and reject it everywhere else. */
export function resolveLambdaMicrovmNumericConfig(
  source: LambdaMicrovmNumericEnv,
): LambdaMicrovmNumericConfig {
  const read = (name: keyof LambdaMicrovmNumericConfig): number => {
    const raw = source[name];
    return raw == null || raw.trim() === '' ? lambdaMicrovmNumericDefaults[name] : Number(raw);
  };
  return {
    LAMBDA_MICROVM_PORT: read('LAMBDA_MICROVM_PORT'),
    LAMBDA_MICROVM_MAX_DURATION_SECONDS: read('LAMBDA_MICROVM_MAX_DURATION_SECONDS'),
    LAMBDA_MICROVM_IDLE_SECONDS: read('LAMBDA_MICROVM_IDLE_SECONDS'),
    LAMBDA_MICROVM_SUSPEND_SECONDS: read('LAMBDA_MICROVM_SUSPEND_SECONDS'),
    LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: read('LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS'),
    LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: read('LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS'),
    LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: read('LAMBDA_MICROVM_HEALTH_TIMEOUT_MS'),
    LAMBDA_MICROVM_LAUNCH_TPS: read('LAMBDA_MICROVM_LAUNCH_TPS'),
    LAMBDA_MICROVM_TOKEN_TPS: read('LAMBDA_MICROVM_TOKEN_TPS'),
  };
}

/** Returns the first invalid Lambda numeric setting for fail-fast startup. */
export function lambdaMicrovmNumericConfigError(
  config: LambdaMicrovmNumericConfig,
): string | undefined {
  for (const name of Object.keys(lambdaMicrovmNumericRanges) as Array<keyof LambdaMicrovmNumericConfig>) {
    const value = config[name];
    const { min, max } = lambdaMicrovmNumericRanges[name];
    if (!Number.isSafeInteger(value) || value < min || (max != null && value > max)) {
      const range = max == null ? `at least ${min}` : `between ${min} and ${max}`;
      return `${name} must be a whole number ${range}`;
    }
  }
  return undefined;
}

export function resolvePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Math.floor(Number(raw));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

export function resolveEgressGrantTtlSeconds(rawTtlSeconds: string | undefined, jobTimeoutMs: number): number {
  const defaultTtlSeconds = Math.max(1, Math.ceil((jobTimeoutMs + EGRESS_GRANT_GRACE_MS) / 1000));
  if (rawTtlSeconds == null || rawTtlSeconds.trim() === '') {
    return defaultTtlSeconds;
  }

  const configuredTtlSeconds = Number(rawTtlSeconds);
  if (!Number.isFinite(configuredTtlSeconds) || configuredTtlSeconds <= 0) {
    return defaultTtlSeconds;
  }

  return Math.max(1, Math.ceil(configuredTtlSeconds));
}

const lambdaMicrovmNumericConfig = resolveLambdaMicrovmNumericConfig(process.env);

function configuredNumber(raw: string | undefined, fallback: number): number {
  return raw == null || raw.trim() === '' ? fallback : Number(raw);
}

function configuredChoice<T extends string>(
  raw: string | undefined,
  name: string,
  fallback: T,
  allowed: readonly T[],
): T {
  if (raw == null) return fallback;
  if (allowed.includes(raw as T)) return raw as T;
  throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
}

export function resolveSandboxBackend(
  raw: string | undefined,
): 'http' | 'lambda-microvm' | 'remote-bridge' {
  return configuredChoice(
    raw,
    'CODEAPI_SANDBOX_BACKEND',
    'http',
    ['http', 'lambda-microvm', 'remote-bridge'],
  );
}

export function resolveRuntimeSessionMode(
  raw: string | undefined,
): 'stateless' | 'affinity' | 'strict' {
  return configuredChoice(
    raw,
    'CODEAPI_RUNTIME_SESSION_MODE',
    'stateless',
    ['stateless', 'affinity', 'strict'],
  );
}

export function resolveBridgeAuthMode(
  raw: string | undefined,
): 'static' | 'paired' {
  return configuredChoice(
    raw,
    'CODEAPI_BRIDGE_AUTH_MODE',
    'static',
    ['static', 'paired'],
  );
}

const sandboxBackend = resolveSandboxBackend(process.env.CODEAPI_SANDBOX_BACKEND);
const runtimeSessionMode = resolveRuntimeSessionMode(process.env.CODEAPI_RUNTIME_SESSION_MODE);
const bridgeAuthMode = resolveBridgeAuthMode(process.env.CODEAPI_BRIDGE_AUTH_MODE);

export const env = {
  PORT: process.env.SERVICE_PORT ?? 3112,
  LOCAL_MODE: process.env.LOCAL_MODE === 'true',
  HARDENED_SANDBOX_MODE: process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  INSTANCE_ID: process.env.INSTANCE_ID ?? nanoid(),
  HTTP_JSON_LIMIT: process.env.CODEAPI_HTTP_JSON_LIMIT ?? '50mb',
  SANDBOX_ENDPOINT: process.env.SANDBOX_ENDPOINT ?? 'http://localhost:2000/api/v2',
  EGRESS_GATEWAY_URL: process.env.EGRESS_GATEWAY_URL ?? '',
  FILE_SERVER_URL: process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  TOOL_CALL_SERVER_URL: process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_PORT: Number(process.env.EGRESS_GATEWAY_PORT) || 3190,
  EGRESS_GATEWAY_FILE_SERVER_URL: process.env.EGRESS_GATEWAY_FILE_SERVER_URL ?? process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  EGRESS_GATEWAY_TOOL_CALL_SERVER_URL: process.env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL ?? process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES) || 1024 * 1024,
  // Per-entry / aggregate caps for PTC tool results persisted in `tool_history:` (see replay-state.ts).
  PTC_MAX_TOOL_RESULT_BYTES: resolvePositiveIntEnv(process.env.PTC_MAX_TOOL_RESULT_BYTES, 5_000_000),
  PTC_MAX_TOOL_HISTORY_TOTAL_BYTES: resolvePositiveIntEnv(process.env.PTC_MAX_TOOL_HISTORY_TOTAL_BYTES, 40_000_000),
  EGRESS_GATEWAY_MAX_FILE_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_FILE_BYTES ?? process.env.SANDBOX_MAX_FILE_SIZE) || 10_000_000,
  EGRESS_GATEWAY_MAX_PATH_LENGTH: Number(process.env.EGRESS_GATEWAY_MAX_PATH_LENGTH ?? process.env.SANDBOX_MAX_PATH_LENGTH) || 256,
  EGRESS_GATEWAY_MAX_NESTING_DEPTH: Number(process.env.EGRESS_GATEWAY_MAX_NESTING_DEPTH ?? process.env.SANDBOX_MAX_NESTING_DEPTH) || 10,
  EGRESS_GATEWAY_REQUEST_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS) || 30_000,
  EGRESS_GATEWAY_REVOKE_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS) || 5_000,
  EGRESS_LEDGER_REQUIRED: process.env.CODEAPI_EGRESS_LEDGER_REQUIRED === 'true' || process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  EGRESS_LEDGER_TTL_GRACE_SECONDS: Number(process.env.CODEAPI_EGRESS_LEDGER_TTL_GRACE_SECONDS) || 300,
  EGRESS_GRANT_SECRET: process.env.CODEAPI_EGRESS_GRANT_SECRET ?? '',
  EGRESS_GRANT_TTL_SECONDS: resolveEgressGrantTtlSeconds(process.env.EGRESS_GRANT_TTL_SECONDS, defaultJobTimeoutMs),
  PYTHON_CONCURRENCY: Number(process.env.PYTHON_CONCURRENCY) || 1,
  OTHER_CONCURRENCY: Number(process.env.OTHER_CONCURRENCY) || 8,
  JOB_WINDOW: Number(process.env.JOB_WINDOW) || 1000,
  MAX_UPLOAD_CHECKS: Number(process.env.MAX_UPLOAD_CHECKS) || 14,
  MAX_UPLOAD_WAIT: Number(process.env.MAX_UPLOAD_WAIT) || 500,
  MAX_FILE_SIZE: defaultMaxFileSize,
  JOB_TIMEOUT: defaultJobTimeoutMs, // 5 minutes (increased for complex matplotlib rendering)
  // Execution Rate Limits
  EXEC_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW) || 30 * 1000, // 30 seconds
  EXEC_MAX_REQUESTS: Number(process.env.MAX_REQUESTS) || 20, // execution requests per window
  // Upload Rate Limits
  UPLOAD_LIMIT_WINDOW: Number(process.env.UPLOAD_LIMIT_WINDOW) || 5 * 60 * 1000, // 5 minutes
  UPLOAD_MAX_REQUESTS: Number(process.env.UPLOAD_MAX_REQUESTS) || 30, // 30 uploads per 5 minutes
  // Download Rate Limits
  DOWNLOAD_LIMIT_WINDOW: Number(process.env.DOWNLOAD_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  DOWNLOAD_MAX_REQUESTS: Number(process.env.DOWNLOAD_MAX_REQUESTS) || 60, // 60 downloads per minute
  // Files List Rate Limits
  FETCH_LIMIT_WINDOW: Number(process.env.FETCH_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  FETCH_MAX_REQUESTS: Number(process.env.FETCH_MAX_REQUESTS) || 120, // 120 requests per minute
  // Redis Key Cache Config
  SESSION_CACHE_TTL: Number(process.env.SESSION_CACHE_TTL) || 86400,
  /** TTL for the durable `session-owner:<session_id>` record that backs
   *  deletion after `SESSION_CACHE_TTL` has lapsed (see
   *  `session-ownership.ts`). Sized to outlive a client's retention
   *  window — LibreChat sweeps expired files at 30 days by default, and a
   *  shorter value here reinstates the leak it exists to close. Clamped
   *  so it can never be tighter than the cache TTL. */
  SESSION_OWNER_TTL: Math.max(
    Number(process.env.SESSION_OWNER_TTL) || 90 * 86400,
    Number(process.env.SESSION_CACHE_TTL) || 86400,
  ),
  /** Strict tenant isolation. When true, sessionKey resolution fails closed
   *  (500) on requests whose auth context lacks `tenantId`, instead of
   *  silently falling back to the `'legacy'` tenant prefix. Default OFF in
   *  code so single-tenant deploys without an auth tenancy concept keep
   *  working; multi-tenant deploys MUST set this to `true` before any tenant
   *  is multi-homed, otherwise a missing tenantId would silently bucket
   *  cross-tenant requests under the same `'legacy'` prefix. */
  TENANT_ISOLATION_STRICT: process.env.CODEAPI_TENANT_ISOLATION_STRICT === 'true',
  // Signed execution manifests. Prefer private/public key mode for split-runner
  // deployments so sandbox-runner receives only a verifier, not a signing secret.
  EXECUTION_MANIFEST_PRIVATE_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY ?? '',
  EXECUTION_MANIFEST_PUBLIC_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY ?? '',
  // Legacy HMAC fallback for non-split deployments. Do not mount into sandbox-runner.
  EXECUTION_MANIFEST_SECRET: process.env.CODEAPI_EXECUTION_MANIFEST_SECRET ?? '',
  EXECUTION_MANIFEST_TTL_SECONDS: Math.min(
    Number(process.env.EXECUTION_MANIFEST_TTL_SECONDS) || defaultExecutionManifestTtlSeconds,
    600,
  ),
  EXECUTION_MANIFEST_MAX_UPLOAD_BYTES: Number(process.env.EXECUTION_MANIFEST_MAX_UPLOAD_BYTES) || defaultMaxFileSize,
  EXECUTION_MANIFEST_MAX_OUTPUT_FILES: Number(process.env.EXECUTION_MANIFEST_MAX_OUTPUT_FILES) || 50,
  EXECUTION_MANIFEST_MAX_REQUESTS: Number(process.env.EXECUTION_MANIFEST_MAX_REQUESTS) || 1000,
  // Redis - Alternative DNS Lookup for AWS ElastiCache TLS connections
  REDIS_USE_ALTERNATIVE_DNS_LOOKUP: process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true',
  /**
   * Programmatic Tool Calling execution model.
   * - `replay` (default): Temporal-style replay. Sandbox exits between round-trips;
   *   tool results are persisted in Redis and replayed into a fresh sandbox on each
   *   continuation until the code either completes or surfaces new tool calls.
   *   Safe to scale horizontally since all state lives in Redis.
   * - `blocking`: legacy path. Sandbox process stays alive across tool round-trips
   *   via a long-polling HTTP callback through the Tool Call Server. Retained as
   *   an explicit opt-in during rollout; scheduled for removal in a follow-up.
   */
  PTC_MODE: (process.env.PTC_MODE === 'blocking' ? 'blocking' : 'replay') as 'replay' | 'blocking',
  PTC_DEBUG: process.env.PTC_DEBUG === 'true',
  /**
   * Sandbox execution backend.
   * - `http` (default): POST signed execute requests to SANDBOX_ENDPOINT
   *   (current Kubernetes/libkrun sandbox-runner).
   * - `lambda-microvm`: AWS Lambda MicroVM backend.
   * - `remote-bridge`: dispatch to an outbound-connected @librechat/code worker.
   */
  SANDBOX_BACKEND: sandboxBackend,
  /** Permit trusted callers to route each execution to a paired worker ID. */
  BRIDGE_DYNAMIC_WORKERS: process.env.CODEAPI_BRIDGE_DYNAMIC_WORKERS === 'true',
  /** Outbound worker selected by the remote-bridge backend. */
  BRIDGE_WORKER_ID: process.env.CODEAPI_BRIDGE_WORKER_ID ?? '',
  /** Static compatibility auth or short-lived proof-of-possession credentials. */
  BRIDGE_AUTH_MODE: bridgeAuthMode,
  /** Enrollment and lease credential shared only with the configured worker. */
  BRIDGE_TOKEN: process.env.CODEAPI_BRIDGE_TOKEN ?? '',
  /**
   * Runtime session affinity for stateful sandbox backends.
   * - `stateless` (default): no runtime sessions; `runtime_session_hint` ignored.
   * - `affinity`: stateful session reuse; contention surfaces as HTTP 409
   *   rather than silently losing workspace state in a stateless execution.
   * - `strict`: same serialized session semantics, and a session hint is
   *   required instead of degrading requests without one to stateless.
   */
  RUNTIME_SESSION_MODE: runtimeSessionMode,
  /**
   * Deployment identity used by trusted callers to route each agent to the
   * intended execution stack. `default` is HTTP/stateless; `stateful` is
   * Lambda MicroVM with session affinity. The startup policy rejects mixed
   * tuples so an endpoint cannot claim one profile while running the other.
   */
  EXECUTION_PROFILE: resolveExecutionProfile(
    process.env.CODEAPI_EXECUTION_PROFILE,
    runtimeSessionMode,
  ),
  EXECUTION_PROFILE_SOURCE: resolveExecutionProfileSource(
    process.env.CODEAPI_EXECUTION_PROFILE,
  ),
  RUNTIME_SESSION_LOCK_WAIT_MS: configuredNumber(
    process.env.CODEAPI_RUNTIME_SESSION_LOCK_WAIT_MS,
    15_000,
  ),
  // Lambda MicroVM backend. Connector lists are comma-separated ARNs.
  LAMBDA_MICROVM_IMAGE_ARN: process.env.LAMBDA_MICROVM_IMAGE_ARN ?? '',
  LAMBDA_MICROVM_IMAGE_VERSION: process.env.LAMBDA_MICROVM_IMAGE_VERSION || undefined,
  LAMBDA_MICROVM_EXECUTION_ROLE_ARN: process.env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN || undefined,
  /* Runtime VM stdout reaches CloudWatch only when RunMicrovm sends a logging
   * config AND an executionRoleArn is set — pairs with the role above. */
  LAMBDA_MICROVM_LOG_GROUP: process.env.LAMBDA_MICROVM_LOG_GROUP || undefined,
  LAMBDA_MICROVM_REGION: process.env.LAMBDA_MICROVM_REGION || undefined,
  LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS: parseArnList(process.env.LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS),
  LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS: parseArnList(process.env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS),
  ...lambdaMicrovmNumericConfig,
  /* CreateMicrovmAuthToken is minted per execute + per checkpoint; share a
   * fleet-wide budget so concurrent warm-session executes queue instead of
   * bursting past the AWS TPS limit. */
  LAMBDA_MICROVM_ALLOW_SHELL: process.env.LAMBDA_MICROVM_ALLOW_SHELL === 'true',
  /* Session workspace checkpoints (effective only in affinity/strict modes).
   * On by default so VM expiry/eviction recovery is automatic; the byte cap
   * bounds tar size pulled from the VM and stored to S3. */
  SESSION_CHECKPOINTS: process.env.CODEAPI_SESSION_CHECKPOINTS !== 'false',
  CHECKPOINT_MAX_BYTES: configuredNumber(
    process.env.CODEAPI_CHECKPOINT_MAX_BYTES,
    512 * 1024 * 1024,
  ),
  CHECKPOINT_TIMEOUT_MS: configuredNumber(process.env.CODEAPI_CHECKPOINT_TIMEOUT_MS, 60_000),
  CHECKPOINT_PREFIX: process.env.CODEAPI_CHECKPOINT_PREFIX ?? 'rtsx-checkpoints/',
  /** Dedicated Lambda MicroVM resident-server fleet. This remains an explicit
   * stateful-stack capability; the ordinary/default HTTP profile never starts
   * or preserves application processes. */
  HOSTED_APPS_ENABLED: process.env.CODEAPI_HOSTED_APPS_ENABLED === 'true',
  HOSTED_APP_IMAGE_ARN: process.env.LAMBDA_MICROVM_APP_IMAGE_ARN ?? '',
  HOSTED_APP_IMAGE_VERSION: process.env.LAMBDA_MICROVM_APP_IMAGE_VERSION || undefined,
  /* These values are part of the pinned app-host image contract. RunMicrovm
   * cannot inject environment variables into the image, so exposing overrides
   * here would only make the control plane call ports the runner never opened. */
  HOSTED_APP_CONTROL_PORT: 8080 as number,
  HOSTED_APP_PREVIEW_PORT: 3000 as number,
  HOSTED_APP_MAX_DURATION_SECONDS: configuredNumber(
    process.env.LAMBDA_MICROVM_APP_MAX_DURATION_SECONDS,
    28_800,
  ),
  HOSTED_APP_IDLE_SECONDS: configuredNumber(
    process.env.LAMBDA_MICROVM_APP_IDLE_SECONDS,
    300,
  ),
  HOSTED_APP_SUSPEND_SECONDS: configuredNumber(
    process.env.LAMBDA_MICROVM_APP_SUSPEND_SECONDS,
    900,
  ),
  HOSTED_APP_START_TIMEOUT_MS: 30_000 as number,
  HOSTED_APP_CREDENTIAL_KEY: process.env.CODEAPI_HOSTED_APP_CREDENTIAL_KEY ?? '',
  HOSTED_APP_PREVIEW_ORIGIN: process.env.CODEAPI_HOSTED_APP_PREVIEW_ORIGIN ?? '',
  HOSTED_APP_PREVIEW_SIGNING_KEY:
    process.env.CODEAPI_HOSTED_APP_PREVIEW_SIGNING_KEY ?? '',
};

const default_run_memory_limit = 256 * 1024 * 1024;

type PlanLimit = {
  run_memory_limit?: number;
  max_file_size?: number;
};

type PlanLimits = {
  default: Required<PlanLimit>;
} & {
  [key: string]: PlanLimit | undefined;
};

/**
 * The plan catalog is deployment config, not code: CODEAPI_PLAN_LIMITS is a
 * JSON object keyed by the `plan_id` JWT claim. Unknown or absent plan ids
 * fall back to the default tier, which is the only entry defined in code.
 */
export function parsePlanLimits(raw: string | undefined): Record<string, PlanLimit> {
  if (raw == null || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CODEAPI_PLAN_LIMITS is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CODEAPI_PLAN_LIMITS must be a JSON object keyed by plan id');
  }
  return parsed as Record<string, PlanLimit>;
}

export const planLimits: PlanLimits = {
  ...parsePlanLimits(process.env.CODEAPI_PLAN_LIMITS),
  default: {
    run_memory_limit: Number(process.env.SANDBOX_RUN_MEMORY_LIMIT) || default_run_memory_limit,
    max_file_size: env.MAX_FILE_SIZE,
  },
};
