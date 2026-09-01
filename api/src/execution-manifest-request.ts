import type { TFile } from './job';
import {
  EXECUTION_MANIFEST_HEADER,
  ExecutionManifestError,
  executionManifestBodySha256,
  type ExecutionManifestClaims,
  type ExecutionManifestInputFile,
  verifyExecutionManifestWithKey,
} from './execution-manifest';

interface ExecuteRequestBody {
  session_id?: string;
  output_session_id?: string;
  files?: TFile[];
}

interface PayloadFileRef {
  id: string;
  storage_session_id?: string | null;
  name?: string;
}

function isPayloadFileRef(file: unknown): file is PayloadFileRef {
  return (
    file != null &&
    typeof file === 'object' &&
    typeof (file as Record<string, unknown>).id === 'string' &&
    (file as Record<string, unknown>).id !== ''
  );
}

function fileKey(file: ExecutionManifestInputFile): string {
  return `${file.session_id}\0${file.id}\0${file.name}`;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface ManifestBodyHashOptions {
  nowSeconds?: number;
  bodyHashRequiredAfterSeconds?: number;
}

function assertManifestBodyHashMatches(
  manifest: ExecutionManifestClaims,
  body: ExecuteRequestBody,
  options: ManifestBodyHashOptions = {},
): void {
  if (!manifest.execute_body_sha256) {
    /* input_cache_key selects runner-local bytes and is deliberately absent
     * from the coarse input-file claim tuple. It is therefore safe only when
     * the whole execute body is signed; never admit it through the rolling
     * legacy no-body-hash grace. */
    const hasInputCacheSelector = Array.isArray(body.files) && body.files.some(
      file => file != null
        && typeof file === 'object'
        && typeof (file as TFile).input_cache_key === 'string',
    );
    if (hasInputCacheSelector) {
      throw new ExecutionManifestError(
        'scope_mismatch',
        'Execution manifest body hash is required for input cache selectors',
      );
    }
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    /* Updated sandbox pods can receive still-valid manifests from older
     * service workers during a rolling deploy. Keep that compatibility window
     * bounded so body-hash enforcement closes automatically after rollout. */
    if (
      options.bodyHashRequiredAfterSeconds !== undefined &&
      nowSeconds < options.bodyHashRequiredAfterSeconds
    ) {
      return;
    }
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest body hash does not match request');
  }
  if (manifest.execute_body_sha256 !== executionManifestBodySha256(body)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest body hash does not match request');
  }
}

export function collectExecuteRequestInputFiles(body: ExecuteRequestBody): ExecutionManifestInputFile[] {
  const files = Array.isArray(body.files) ? body.files : [];
  return files
    .map((file, index) => {
      if (!isPayloadFileRef(file)) return null;
      /* Inline-content refs (no per-file `storage_session_id`) get persisted
       * under the exec session as their storage prefix — the two roles share
       * the value by design, so falling back to `body.session_id` here is
       * correct, not a category error. Same rationale lives in
       * `service/src/service/router.ts` where the prefix is chosen. */
      const storageId = typeof file.storage_session_id === 'string'
        ? file.storage_session_id
        : body.output_session_id ?? body.session_id;
      if (!storageId) {
        throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
      }
      return {
        id: file.id,
        session_id: storageId,
        name: typeof file.name === 'string' && file.name ? file.name : `file${index}.code`,
      };
    })
    .filter((file): file is ExecutionManifestInputFile => file != null)
    .sort((a, b) => (
      a.session_id.localeCompare(b.session_id) ||
      a.id.localeCompare(b.id) ||
      a.name.localeCompare(b.name)
    ));
}

export function assertManifestMatchesExecuteRequest(
  manifest: ExecutionManifestClaims,
  body: ExecuteRequestBody,
  options: ManifestBodyHashOptions = {},
): void {
  const outputSessionId = body.output_session_id ?? body.session_id;
  if (!outputSessionId || manifest.output_session_id !== outputSessionId) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest output session does not match request');
  }

  const requestFiles = collectExecuteRequestInputFiles(body);
  const manifestFiles = [...manifest.input_files].sort((a, b) => (
    a.session_id.localeCompare(b.session_id) ||
    a.id.localeCompare(b.id) ||
    a.name.localeCompare(b.name)
  ));
  if (requestFiles.length !== manifestFiles.length) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
  }

  const requestFileKeys = requestFiles.map(fileKey);
  const manifestFileKeys = manifestFiles.map(fileKey);
  if (!stringArraysEqual(requestFileKeys, manifestFileKeys)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
  }

  const expectedReadSessions = Array.from(new Set(requestFiles.map(file => file.session_id))).sort();
  const manifestReadSessions = [...manifest.read_sessions].sort();
  if (!stringArraysEqual(expectedReadSessions, manifestReadSessions)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest read sessions do not match request');
  }

  assertManifestBodyHashMatches(manifest, body, options);
}

export function verifyExecuteRequestManifest(args: {
  headerValue: string | undefined;
  publicKey?: string;
  secret?: string;
  body: ExecuteRequestBody;
  nowSeconds?: number;
  bodyHashRequiredAfterSeconds?: number;
}): ExecutionManifestClaims {
  if (!args.headerValue) {
    throw new ExecutionManifestError('missing_header', `${EXECUTION_MANIFEST_HEADER} is required`);
  }
  const manifest = verifyExecutionManifestWithKey(args.headerValue, {
    publicKey: args.publicKey,
    secret: args.secret,
  }, {
    nowSeconds: args.nowSeconds,
  });
  if (manifest.operation !== undefined && manifest.operation !== 'execute') {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest operation does not authorize execute');
  }
  assertManifestMatchesExecuteRequest(manifest, args.body, {
    nowSeconds: args.nowSeconds,
    bodyHashRequiredAfterSeconds: args.bodyHashRequiredAfterSeconds,
  });
  return manifest;
}
