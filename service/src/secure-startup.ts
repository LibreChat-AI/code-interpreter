import {
  checkpointPipelineBudgetMs,
  env,
  lambdaMicrovmNumericConfigError,
} from './config';
import { INTERNAL_SERVICE_TOKEN_ENV } from './internal-service-auth';
import { isValidBridgeWorkerId } from '../../packages/code/src/protocol';

export class SecureStartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureStartupConfigError';
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function requireValue(name: string, value: string | undefined): void {
  if (!nonEmpty(value)) {
    throw new SecureStartupConfigError(`${name} is required in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

function requireStrongSecret(name: string, value: string | undefined, minBytes = 32): void {
  requireValue(name, value);
  if (Buffer.byteLength(value ?? '', 'utf8') < minBytes) {
    throw new SecureStartupConfigError(`${name} must be at least ${minBytes} bytes in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

function rejectValue(name: string, value: string | undefined): void {
  if (nonEmpty(value)) {
    throw new SecureStartupConfigError(`${name} must not be configured in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

function requireSafeWholeNumber(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new SecureStartupConfigError(
      `${name} must be a whole number of at least ${min}`,
    );
  }
}

const AWS_MANAGED_INTERNET_EGRESS_SUFFIX =
  ':aws:network-connector:aws-network-connector:INTERNET_EGRESS';

export function validateApiHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_EGRESS_GRANT_SECRET', process.env.CODEAPI_EGRESS_GRANT_SECRET);
  requireValue('EGRESS_GATEWAY_URL', env.EGRESS_GATEWAY_URL);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
}

/** Validate bridge credentials in every process that exposes bridge routes. */
export function validateApiBridgePolicy(): void {
  if (env.SANDBOX_BACKEND !== 'remote-bridge') return;
  requireSafeWholeNumber('JOB_TIMEOUT', env.JOB_TIMEOUT, 1);
  requireValue('CODEAPI_BRIDGE_WORKER_ID', env.BRIDGE_WORKER_ID);
  if (!isValidBridgeWorkerId(env.BRIDGE_WORKER_ID ?? '')) {
    throw new SecureStartupConfigError(
      'CODEAPI_BRIDGE_WORKER_ID must match the bridge worker ID format',
    );
  }
  if (env.BRIDGE_TOKEN !== env.BRIDGE_TOKEN.trim()) {
    throw new SecureStartupConfigError(
      'CODEAPI_BRIDGE_TOKEN must not contain surrounding whitespace',
    );
  }
  if (env.HARDENED_SANDBOX_MODE) {
    requireStrongSecret('CODEAPI_BRIDGE_TOKEN', env.BRIDGE_TOKEN);
  } else {
    requireValue('CODEAPI_BRIDGE_TOKEN', env.BRIDGE_TOKEN);
  }
  if (env.PTC_MODE === 'blocking') {
    throw new SecureStartupConfigError(
      'PTC replay is the only supported PTC mode for the remote-bridge backend (unset PTC_MODE=blocking)',
    );
  }
}

export function validateWorkerHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_EGRESS_GRANT_SECRET', process.env.CODEAPI_EGRESS_GRANT_SECRET);
  rejectValue('CODEAPI_EXECUTION_MANIFEST_SECRET', process.env.CODEAPI_EXECUTION_MANIFEST_SECRET);
  rejectValue('CODEAPI_SYNTHETIC_ACCESS_TOKEN', process.env.CODEAPI_SYNTHETIC_ACCESS_TOKEN);
  requireValue('EGRESS_GATEWAY_URL', env.EGRESS_GATEWAY_URL);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
  requireValue('CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY', env.EXECUTION_MANIFEST_PRIVATE_KEY);
}

/**
 * Make the endpoint identity trustworthy. Callers route by execution profile,
 * so accepting a contradictory backend/session tuple would silently send work
 * to the wrong infrastructure and could lose workspace continuity.
 */
export function validateExecutionProfilePolicy(options: {
  requireBackendMatch?: boolean;
} = {}): void {
  const requireBackendMatch = options.requireBackendMatch ?? true;
  if (env.EXECUTION_PROFILE === 'default') {
    const compatibleBackend = env.SANDBOX_BACKEND === 'http'
      || (
        env.EXECUTION_PROFILE_SOURCE === 'inferred'
        && env.SANDBOX_BACKEND === 'lambda-microvm'
      );
    if (
      env.RUNTIME_SESSION_MODE !== 'stateless'
      || (requireBackendMatch && !compatibleBackend)
    ) {
      throw new SecureStartupConfigError(
        'CODEAPI_EXECUTION_PROFILE=default requires '
          + (requireBackendMatch ? 'CODEAPI_SANDBOX_BACKEND=http and ' : '')
          + 'CODEAPI_RUNTIME_SESSION_MODE=stateless',
      );
    }
    return;
  }

  if (
    env.RUNTIME_SESSION_MODE === 'stateless'
    || (
      requireBackendMatch
      && env.SANDBOX_BACKEND !== 'lambda-microvm'
      && env.SANDBOX_BACKEND !== 'remote-bridge'
    )
  ) {
    throw new SecureStartupConfigError(
      'CODEAPI_EXECUTION_PROFILE=stateful requires '
        + (requireBackendMatch ? 'CODEAPI_SANDBOX_BACKEND=lambda-microvm or remote-bridge and ' : '')
        + 'CODEAPI_RUNTIME_SESSION_MODE=affinity or strict',
    );
  }
}

/**
 * Backend-selection policy. Unlike the hardened-mode validators, this runs
 * unconditionally: a misconfigured backend must never half-start.
 */
export function validateSandboxBackendPolicy(): void {
  if (env.RUNTIME_SESSION_MODE !== 'stateless' && env.SANDBOX_BACKEND === 'http') {
    throw new SecureStartupConfigError(
      `CODEAPI_RUNTIME_SESSION_MODE=${env.RUNTIME_SESSION_MODE} requires `
        + 'the lambda-microvm or remote-bridge backend; use stateless mode with the http backend',
    );
  }
  if (env.SANDBOX_BACKEND === 'remote-bridge') {
    validateApiBridgePolicy();
    return;
  }
  if (env.SANDBOX_BACKEND !== 'lambda-microvm') return;

  const numericConfigError = lambdaMicrovmNumericConfigError(env);
  if (numericConfigError !== undefined) {
    throw new SecureStartupConfigError(numericConfigError);
  }
  requireSafeWholeNumber('JOB_TIMEOUT', env.JOB_TIMEOUT, 1);
  requireSafeWholeNumber(
    'CODEAPI_RUNTIME_SESSION_LOCK_WAIT_MS',
    env.RUNTIME_SESSION_LOCK_WAIT_MS,
    0,
  );
  requireSafeWholeNumber('CODEAPI_CHECKPOINT_MAX_BYTES', env.CHECKPOINT_MAX_BYTES, 1);
  requireSafeWholeNumber('CODEAPI_CHECKPOINT_TIMEOUT_MS', env.CHECKPOINT_TIMEOUT_MS, 1);
  if (env.PTC_MODE === 'blocking') {
    throw new SecureStartupConfigError(
      'PTC replay is the only supported PTC mode for the lambda-microvm backend (unset PTC_MODE=blocking)',
    );
  }
  if (env.LAMBDA_MICROVM_IMAGE_ARN.trim().length === 0) {
    throw new SecureStartupConfigError('LAMBDA_MICROVM_IMAGE_ARN is required for the lambda-microvm backend');
  }
  if (
    env.RUNTIME_SESSION_MODE !== 'stateless'
    && !nonEmpty(env.LAMBDA_MICROVM_IMAGE_VERSION)
  ) {
    throw new SecureStartupConfigError(
      'LAMBDA_MICROVM_IMAGE_VERSION must be pinned for stateful runtime sessions',
    );
  }
  if (env.HARDENED_SANDBOX_MODE && (env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS?.length ?? 0) === 0) {
    throw new SecureStartupConfigError(
      'LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS is required in CODEAPI_HARDENED_SANDBOX_MODE (MicroVMs default to public egress)',
    );
  }
  if (
    env.HARDENED_SANDBOX_MODE
    && (env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS?.some(
      (arn) => arn.trim().endsWith(AWS_MANAGED_INTERNET_EGRESS_SUFFIX),
    ) ?? false)
  ) {
    throw new SecureStartupConfigError(
      'AWS-managed INTERNET_EGRESS is forbidden in CODEAPI_HARDENED_SANDBOX_MODE; use only a VPC egress connector restricted to the gateway',
    );
  }
  if (env.LAMBDA_MICROVM_ALLOW_SHELL && (env.HARDENED_SANDBOX_MODE || process.env.NODE_ENV === 'production')) {
    throw new SecureStartupConfigError(
      'LAMBDA_MICROVM_ALLOW_SHELL must not be enabled in production or hardened mode',
    );
  }
  /* Checkpoints without object storage configured: MinioCheckpointStore silently
   * falls back to localhost:9000/test-bucket, so warm reuse works
   * but every checkpoint + restore fails against the dummy store and workspace
   * state is lost on the first relaunch. Fail fast instead (mirrors the factory
   * gate that constructs the store). Credentials may be a complete static
   * MINIO pair or the workload's IAM role/web-identity provider. */
  if (env.SESSION_CHECKPOINTS && env.RUNTIME_SESSION_MODE !== 'stateless') {
    const checkpointBudgetMs = checkpointPipelineBudgetMs(
      env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
      env.CHECKPOINT_TIMEOUT_MS,
    );
    if (env.JOB_TIMEOUT <= checkpointBudgetMs) {
      throw new SecureStartupConfigError(
        `JOB_TIMEOUT must exceed the full session checkpoint reserve (${checkpointBudgetMs}ms): `
          + 'one shared LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS token budget '
          + '+ two CODEAPI_CHECKPOINT_TIMEOUT_MS + two capped object metadata '
          + 'operations + six bounded registry operations',
      );
    }
    const missing = ['MINIO_ENDPOINT'].filter(
      (name) => !nonEmpty(process.env[name]),
    );
    const hasAccessKey = nonEmpty(process.env.MINIO_ACCESS_KEY);
    const hasSecretKey = nonEmpty(process.env.MINIO_SECRET_KEY);
    if (hasAccessKey !== hasSecretKey) {
      missing.push(hasAccessKey ? 'MINIO_SECRET_KEY' : 'MINIO_ACCESS_KEY');
    }
    if (!nonEmpty(process.env.CODEAPI_CHECKPOINT_BUCKET) && !nonEmpty(process.env.MINIO_BUCKET)) {
      missing.push('CODEAPI_CHECKPOINT_BUCKET (or MINIO_BUCKET)');
    }
    if (missing.length > 0) {
      throw new SecureStartupConfigError(
        'Session checkpoints are enabled but object storage is not configured: '
          + `${missing.join(', ')}. Set them or disable CODEAPI_SESSION_CHECKPOINTS.`,
      );
    }
  }
}

export function validateEgressGatewayHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_SYNTHETIC_ACCESS_TOKEN', process.env.CODEAPI_SYNTHETIC_ACCESS_TOKEN);
  requireStrongSecret('CODEAPI_EGRESS_GRANT_SECRET', env.EGRESS_GRANT_SECRET);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
  requireValue('EGRESS_GATEWAY_FILE_SERVER_URL', env.EGRESS_GATEWAY_FILE_SERVER_URL);
  requireValue('EGRESS_GATEWAY_TOOL_CALL_SERVER_URL', env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL);
  requireValue('REDIS_HOST', process.env.REDIS_HOST);
  if (!env.EGRESS_LEDGER_REQUIRED) {
    throw new SecureStartupConfigError('CODEAPI_EGRESS_LEDGER_REQUIRED must be true in CODEAPI_HARDENED_SANDBOX_MODE');
  }
}
