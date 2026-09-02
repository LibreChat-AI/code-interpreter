type LimitOverrides = Record<string, Record<string, number> | undefined>;

function parseLimitOverrides(raw: string): LimitOverrides {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as LimitOverrides;
  } catch {
    return {};
  }
}

/**
 * Parses an integer env var, falling back to the default when the value is
 * missing, non-numeric, or below min. Prevents NaN from silently disabling
 * safety checks via comparisons that always return false.
 */
export function safeInt(raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

const egressGatewayUrl = process.env.EGRESS_GATEWAY_URL ?? '';
const requireExecutionManifest = (
  process.env.SANDBOX_REQUIRE_EGRESS_MANIFEST
  ?? (egressGatewayUrl ? 'true' : 'false')
) === 'true';
const sandboxStartedAtSeconds = Math.floor(Date.now() / 1000);

function cleanDirectory(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || '/';
}

export function legacyPackagesDirectory(raw: string | undefined): string | undefined {
  const trimmed = cleanDirectory(raw);
  if (!trimmed) return undefined;
  return trimmed.endsWith('/packages')
    ? trimmed
    : trimmed === '/' ? '/packages' : `${trimmed}/packages`;
}

export const config = {
  hardened_sandbox_mode: process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  log_level: process.env.SANDBOX_LOG_LEVEL ?? 'DEBUG',
  bind_address: `0.0.0.0:${process.env.PORT ?? 2000}`,
  packages_directory: cleanDirectory(process.env.SANDBOX_PACKAGES_DIRECTORY)
    ?? legacyPackagesDirectory(process.env.SANDBOX_DATA_DIRECTORY)
    ?? '/pkgs',
  disable_networking: (process.env.SANDBOX_DISABLE_NETWORKING ?? 'true') === 'true',
  use_cgroupv2: (process.env.SANDBOX_USE_CGROUPV2 ?? 'true') === 'true',
  allowed_local_network_port: Number(process.env.SANDBOX_ALLOWED_LOCAL_NETWORK_PORT ?? 0),
  output_max_size: safeInt(process.env.SANDBOX_OUTPUT_MAX_SIZE, 1024),
  max_process_count: Number(process.env.SANDBOX_MAX_PROCESS_COUNT ?? 64),
  max_open_files: Number(process.env.SANDBOX_MAX_OPEN_FILES ?? 2048),
  max_file_size: Number(process.env.SANDBOX_MAX_FILE_SIZE ?? 10000000),
  compile_timeout: Number(process.env.SANDBOX_COMPILE_TIMEOUT ?? 10000),
  run_timeout: Number(process.env.SANDBOX_RUN_TIMEOUT ?? 30000),
  compile_cpu_time: Number(process.env.SANDBOX_COMPILE_CPU_TIME ?? 10000),
  run_cpu_time: Number(process.env.SANDBOX_RUN_CPU_TIME ?? 30000),
  compile_memory_limit: Number(process.env.SANDBOX_COMPILE_MEMORY_LIMIT ?? -1),
  run_memory_limit: Number(process.env.SANDBOX_RUN_MEMORY_LIMIT ?? -1),
  max_concurrent_jobs: safeInt(process.env.SANDBOX_MAX_CONCURRENT_JOBS, 8),
  per_job_uids: (process.env.SANDBOX_PER_JOB_UIDS ?? 'true') === 'true',
  /* Image-level enable for persistent session workspaces (stateful sessions).
   * Only the Lambda MicroVM runner target sets this true; the K8s
   * sandbox-runner image leaves it false so it is structurally incapable of
   * session mode. An enabled runner additionally binds each request to a
   * workspace through the authenticated X-Runtime-Session-Id header. */
  session_workspace_enabled: (process.env.SANDBOX_SESSION_WORKSPACE_ENABLED ?? 'false') === 'true',
  job_uid_base: safeInt(process.env.SANDBOX_JOB_UID_BASE, 200000),
  job_gid_base: safeInt(process.env.SANDBOX_JOB_GID_BASE, 200000),
  job_uid_count: safeInt(
    process.env.SANDBOX_JOB_UID_COUNT,
    safeInt(process.env.SANDBOX_MAX_CONCURRENT_JOBS, 8),
  ),
  workspace_reaper_max_age_seconds: safeInt(process.env.SANDBOX_WORKSPACE_REAPER_MAX_AGE_SECONDS, 3600),
  rlimit_as: Number(process.env.SANDBOX_RLIMIT_AS ?? 16384),
  rlimit_fsize: Number(process.env.SANDBOX_RLIMIT_FSIZE ?? 100),
  nsjail_path: process.env.NSJAIL_PATH ?? '/usr/sbin/nsjail',
  nsjail_config: process.env.NSJAIL_CONFIG ?? '/sandbox_api/config/sandbox.cfg',
  execute_body_limit: process.env.SANDBOX_EXECUTE_BODY_LIMIT ?? '50mb',
  /* Independent runner-side ceiling for streamed checkpoint restores. The
   * control plane enforces the same default, but the receiver must not trust a
   * caller-supplied Content-Length or upstream enforcement. */
  checkpoint_max_bytes: safeInt(
    process.env.SANDBOX_CHECKPOINT_MAX_BYTES,
    512 * 1024 * 1024,
  ),
  /* Ceiling for the pushed input cache (session-inputs.ts). Eviction is
   * always safe — a miss simply re-pushes on the next probe — so this is a
   * disk guard, not a correctness knob. */
  input_cache_max_bytes: safeInt(
    process.env.SANDBOX_INPUT_CACHE_MAX_BYTES,
    512 * 1024 * 1024,
  ),
  /* Bound both validation cost and per-request priming fan-out. The cache's
   * unique-object cap is not enough because one object may be requested at
   * many destinations. */
  max_input_files: safeInt(process.env.SANDBOX_MAX_INPUT_FILES, 256),
  prime_concurrency: safeInt(process.env.SANDBOX_PRIME_CONCURRENCY, 8),
  egress_gateway_url: egressGatewayUrl,
  file_relay_token: process.env.SANDBOX_FILE_RELAY_TOKEN ?? '',
  file_server_url: process.env.FILE_SERVER_URL ?? '',
  max_nesting_depth: safeInt(process.env.SANDBOX_MAX_NESTING_DEPTH, 10),
  max_path_length: safeInt(process.env.SANDBOX_MAX_PATH_LENGTH, 256),
  max_output_files: safeInt(process.env.SANDBOX_MAX_OUTPUT_FILES, 50),
  require_execution_manifest: requireExecutionManifest,
  execution_manifest_body_hash_required_after_seconds: sandboxStartedAtSeconds + safeInt(
    process.env.SANDBOX_EXECUTION_MANIFEST_BODY_HASH_LEGACY_GRACE_SECONDS,
    600,
    0,
  ),
  tool_call_socket_legacy_claim_grace_until_seconds: sandboxStartedAtSeconds + safeInt(
    process.env.SANDBOX_TOOL_CALL_SOCKET_LEGACY_CLAIM_GRACE_SECONDS,
    3600,
    0,
  ),
  execution_manifest_public_key: process.env.SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY ?? '',
  // Legacy HMAC verifier fallback for rolling upgrades only. Cloud split-runner
  // deployments should mount SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY instead so a
  // compromised runner cannot mint valid manifests.
  execution_manifest_secret: process.env.SANDBOX_EXECUTION_MANIFEST_SECRET
    ?? process.env.CODEAPI_EXECUTION_MANIFEST_SECRET
    ?? '',
  /* Cap on simultaneous PUTs to file_server during a single job's upload
   * phase. Each PUT streams from disk and holds an open fd + an HTTP
   * connection slot; without a cap a job at `max_output_files` would fan
   * out 50 connections at once, which is fine in isolation but piles up
   * across concurrent jobs. 8 is enough to saturate typical disk/network
   * throughput without exhausting the host's open-fd budget or the
   * file-server's per-session minio object-put concurrency. */
  upload_concurrency: safeInt(process.env.SANDBOX_UPLOAD_CONCURRENCY, 8),
  limit_overrides: parseLimitOverrides(process.env.SANDBOX_LIMIT_OVERRIDES ?? '{}'),
};
