import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { validateRuntimeSessionHint } from '../runtime-session/id';

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4_096;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_BYTES = 4_096;
const MAX_ENV_BYTES = 32 * 1_024;
const MAX_PATH_LENGTH = 256;
const MAX_PATH_DEPTH = 10;
/* Mirror the app-host runner's root-launch filter. Rejecting here makes the
 * immutable control-plane spec match what the runner actually applies. */
const RESERVED_ENV_KEYS = new Set([
  'OPENBLAS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OMP_NUM_THREADS',
  'SANDBOX_LANGUAGE',
  'HOME',
  'PATH',
  'TOOL_CALL_SOCKET',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONEXECUTABLE',
  'PYTHONIOENCODING',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'IFS',
  'SHELLOPTS',
  'BASHOPTS',
  'GLIBC_TUNABLES',
  'PTC_HISTORY_PATH',
  'PORT',
  'HOST',
]);
const RESERVED_ENV_PREFIXES = ['LD_', 'DYLD_', 'PTC_'];

export interface ResidentHostedAppSpec {
  adapter: 'resident';
  app_id: string;
  revision: string;
  language: string;
  version: string;
  entrypoint: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export interface HostedAppStartRequest extends Omit<ResidentHostedAppSpec, 'adapter' | 'cwd' | 'args' | 'env'> {
  adapter?: 'resident';
  runtime_session_hint: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export class HostedAppSpecError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'HostedAppSpecError';
  }
}

export function validateHostedAppId(value: unknown): string {
  if (typeof value !== 'string' || !APP_ID_PATTERN.test(value)) {
    throw new HostedAppSpecError('app_id is malformed');
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedString(
  source: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string {
  const value = source[key];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new HostedAppSpecError(`${key} must be a non-empty bounded string`);
  }
  return value;
}

function canonicalRelativePath(value: string, field: string, allowDot: boolean): string {
  if (
    value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.endsWith('/')
    || (!allowDot && value === '.')
    || value === ''
    || value.length > MAX_PATH_LENGTH
    || value.split('/').filter(Boolean).length > MAX_PATH_DEPTH
    || value === '..'
    || value.startsWith('../')
  ) {
    throw new HostedAppSpecError(`${field} must be a canonical relative path`);
  }
  return value;
}

export function parseHostedAppStartRequest(raw: unknown): {
  runtimeSessionHint: string;
  spec: ResidentHostedAppSpec;
} {
  if (!isPlainObject(raw)) throw new HostedAppSpecError('request body must be an object');
  if (raw.adapter !== undefined && raw.adapter !== 'resident') {
    throw new HostedAppSpecError('adapter must be "resident"');
  }

  const runtimeSessionHint = validateRuntimeSessionHint(raw.runtime_session_hint);
  if (!runtimeSessionHint) {
    throw new HostedAppSpecError('runtime_session_hint is required');
  }
  const appId = boundedString(raw, 'app_id', 64);
  validateHostedAppId(appId);
  const revision = boundedString(raw, 'revision', 128);
  if (!REVISION_PATTERN.test(revision)) throw new HostedAppSpecError('revision is malformed');
  const language = boundedString(raw, 'language', 64);
  const version = boundedString(raw, 'version', 128);
  const entrypoint = canonicalRelativePath(
    boundedString(raw, 'entrypoint', MAX_PATH_LENGTH),
    'entrypoint',
    false,
  );
  const rawCwd = raw.cwd ?? '.';
  if (typeof rawCwd !== 'string') throw new HostedAppSpecError('cwd must be a string');
  const cwd = canonicalRelativePath(rawCwd, 'cwd', true);

  const rawArgs = raw.args ?? [];
  if (
    !Array.isArray(rawArgs)
    || rawArgs.length > MAX_ARGS
    || rawArgs.some(value => (
      typeof value !== 'string'
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > MAX_ARG_BYTES
    ))
  ) {
    throw new HostedAppSpecError(`args must contain at most ${MAX_ARGS} bounded strings`);
  }

  const rawEnv = raw.env ?? {};
  if (!isPlainObject(rawEnv) || Object.keys(rawEnv).length > MAX_ENV_VARS) {
    throw new HostedAppSpecError(`env must be an object with at most ${MAX_ENV_VARS} entries`);
  }
  const env: Record<string, string> = {};
  let envBytes = 0;
  for (const [key, value] of Object.entries(rawEnv)) {
    if (
      !ENV_NAME_PATTERN.test(key)
      || typeof value !== 'string'
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES
    ) {
      throw new HostedAppSpecError(`env.${key} is invalid`);
    }
    const upperKey = key.toUpperCase();
    if (
      RESERVED_ENV_KEYS.has(upperKey)
      || RESERVED_ENV_PREFIXES.some(prefix => upperKey.startsWith(prefix))
    ) {
      throw new HostedAppSpecError(`env.${key} is runner-controlled`);
    }
    envBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (envBytes > MAX_ENV_BYTES) throw new HostedAppSpecError('env is too large');
    env[key] = value;
  }

  return {
    runtimeSessionHint,
    spec: {
      adapter: 'resident',
      app_id: appId,
      revision,
      language,
      version,
      entrypoint,
      cwd,
      args: [...rawArgs] as string[],
      env,
    },
  };
}

function canonicalSpec(spec: ResidentHostedAppSpec): string {
  return JSON.stringify({
    ...spec,
    env: Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))),
  });
}

export function hostedAppSpecFingerprint(spec: ResidentHostedAppSpec): string {
  return createHash('sha256').update(canonicalSpec(spec), 'utf8').digest('hex');
}

/** Opaque, owner-scoped identity used by Redis and preview URLs. */
export function deriveHostedAppRuntimeId(runtimeSessionId: string, appId: string): string {
  const digest = createHash('sha256')
    .update(runtimeSessionId, 'utf8')
    .update('\0', 'utf8')
    .update(appId, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `happ_${digest}`;
}
