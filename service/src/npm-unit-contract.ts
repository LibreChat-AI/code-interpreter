export const NPM_UNIT_KEEP = ['**/*.d.ts', 'package.json'] as const;
export const NPM_FETCH_TOKEN_HEADER = 'X-CodeAPI-Npm-Fetch-Token';
export const PUBLIC_NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

const NPM_NAME_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const EXACT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA512_SRI_RE = /^sha512-([A-Za-z0-9+/]+={0,2})$/;

export interface NpmUnitRequest {
  name: string;
  version: string;
  integrity: string;
  resolved: string;
  keep: Array<(typeof NPM_UNIT_KEEP)[number]>;
}

export type NpmUnitFailureCode =
  | 'integrity_mismatch'
  | 'not_publicly_fetchable'
  | 'registry_unavailable'
  | 'too_large'
  | 'decompression_limit'
  | 'timeout'
  | 'unsafe_entry'
  | 'parse_failed';

export interface NpmUnitFailure {
  error: NpmUnitFailureCode | 'invalid_request' | 'unsupported_registry' | 'disabled' | 'sandbox_unavailable';
  message: string;
  retryable: boolean;
  rejected?: NpmUnitRejected;
  usage?: Partial<NpmUnitUsage>;
}

export interface NpmUnitRejected {
  link: number;
  device: number;
  unsafePath: number;
  oversize: number;
  other: number;
}

export interface NpmUnitUsage {
  tarballBytes: number;
  unpackedBytes: number;
  peakRssBytes: number;
  /** Peak bytes charged to the per-request cgroup, including descendants. */
  cgroupPeakBytes?: number;
  wallMs: number;
}

export interface NpmUnitFile {
  path: string;
  sha1: string;
  bytes: number;
}

export interface NpmUnitSymbol {
  file: string;
  ordinal: number;
  label: string;
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  signature: string;
  tokens: string;
}

export interface NpmUnitImport {
  file: string;
  spec: string;
}

export interface NpmUnitSuccess {
  status: 'complete' | 'partial';
  name: string;
  version: string;
  integrityVerified: true;
  files: NpmUnitFile[];
  symbols: NpmUnitSymbol[];
  imports: NpmUnitImport[];
  rejected: NpmUnitRejected;
  usage: NpmUnitUsage;
  errors?: Array<{ file?: string; code: NpmUnitFailureCode; message: string }>;
}

export type NpmUnitResponse = NpmUnitSuccess | NpmUnitFailure;

export class NpmUnitValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_request' | 'unsupported_registry' = 'invalid_request',
  ) {
    super(message);
    this.name = 'NpmUnitValidationError';
  }
}

function assertNpmName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214 || name !== name.toLowerCase()) {
    throw new NpmUnitValidationError('name must be a lowercase npm package name of at most 214 characters');
  }
  const parts = name.startsWith('@') ? name.slice(1).split('/') : name.split('/');
  if (
    parts.length !== (name.startsWith('@') ? 2 : 1) ||
    parts.some(part => !NPM_NAME_SEGMENT_RE.test(part) || part === '.' || part === '..')
  ) {
    throw new NpmUnitValidationError('name must be an unscoped package or one @scope/package pair');
  }
}

function assertExactVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || version.length > 128 || !EXACT_SEMVER_RE.test(version)) {
    throw new NpmUnitValidationError('version must be an exact semantic version');
  }
}

function assertIntegrity(integrity: unknown): asserts integrity is string {
  if (typeof integrity !== 'string') {
    throw new NpmUnitValidationError('integrity must be a sha512 SRI string');
  }
  const match = integrity.match(SHA512_SRI_RE);
  if (!match) {
    throw new NpmUnitValidationError('integrity must contain exactly one sha512 SRI digest');
  }
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== match[1]) {
    throw new NpmUnitValidationError('integrity must contain a canonical 64-byte sha512 digest');
  }
}

export function canonicalNpmTarballUrl(name: string, version: string): string {
  assertNpmName(name);
  assertExactVersion(version);
  const registry = new URL(PUBLIC_NPM_REGISTRY_ORIGIN);
  const baseName = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  registry.pathname = `/${name}/-/${baseName}-${version}.tgz`;
  return registry.toString();
}

function assertResolvedUrl(
  resolved: unknown,
  name: string,
  version: string,
): asserts resolved is string {
  if (typeof resolved !== 'string' || resolved.length > 2048) {
    throw new NpmUnitValidationError('resolved must be the package tarball URL');
  }
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(resolved);
    expected = new URL(canonicalNpmTarballUrl(name, version));
  } catch {
    throw new NpmUnitValidationError('resolved must be a valid registry tarball URL');
  }
  if (actual.origin !== PUBLIC_NPM_REGISTRY_ORIGIN) {
    throw new NpmUnitValidationError(
      `resolved must use the anonymous public npm registry at ${PUBLIC_NPM_REGISTRY_ORIGIN}`,
      'unsupported_registry',
    );
  }
  let actualPath: string;
  let expectedPath: string;
  try {
    actualPath = decodeURIComponent(actual.pathname);
    expectedPath = decodeURIComponent(expected.pathname);
  } catch {
    throw new NpmUnitValidationError('resolved contains invalid path encoding');
  }
  if (
    actual.protocol !== 'https:' ||
    actual.username ||
    actual.password ||
    actual.search ||
    actual.hash ||
    actualPath !== expectedPath
  ) {
    throw new NpmUnitValidationError('resolved must exactly match name@version on the public npm registry');
  }
}

function assertKeep(keep: unknown): asserts keep is NpmUnitRequest['keep'] {
  if (!Array.isArray(keep) || keep.length !== NPM_UNIT_KEEP.length) {
    throw new NpmUnitValidationError(`keep must be exactly ${JSON.stringify(NPM_UNIT_KEEP)}`);
  }
  const unique = new Set(keep);
  if (unique.size !== NPM_UNIT_KEEP.length || NPM_UNIT_KEEP.some(value => !unique.has(value))) {
    throw new NpmUnitValidationError(`keep must be exactly ${JSON.stringify(NPM_UNIT_KEEP)}`);
  }
}

export function validateNpmUnitRequest(raw: unknown): NpmUnitRequest {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NpmUnitValidationError('Request body must be an object');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['name', 'version', 'integrity', 'resolved', 'keep']);
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NpmUnitValidationError(`Unknown request fields: ${unknown.sort().join(', ')}`);
  }
  assertNpmName(body.name);
  assertExactVersion(body.version);
  assertIntegrity(body.integrity);
  assertResolvedUrl(body.resolved, body.name, body.version);
  assertKeep(body.keep);
  return {
    name: body.name,
    version: body.version,
    integrity: body.integrity,
    resolved: canonicalNpmTarballUrl(body.name, body.version),
    keep: [...NPM_UNIT_KEEP],
  };
}
