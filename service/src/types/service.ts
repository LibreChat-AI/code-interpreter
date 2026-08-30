import type { Job } from 'bullmq';
import type { Request } from 'express';
import type { ExecutionManifestClaims } from '../execution-manifest';
import type { ExecutionIdentity } from '../execution-identity';
import type { CodeApiPrincipal } from '../auth/principal';
import type { ExecutionProfile } from '../execution-profile';
import { Jobs } from '@/enum/service';

/**
 * Per-file vs. top-level session distinction
 * --------------------------------------------
 * `storage_session_id` is the long-lived identifier for the bucket of
 * sandbox object storage where a file's bytes live. Scoped to the file's
 * owner (skill, agent, user) and survives across sandbox runs. Used in
 * file-server URLs and as the per-file pointer carried alongside `file_id`
 * on every reference.
 *
 * `session_id` is the transient identifier for one sandbox
 * `/exec` invocation. Created fresh per call (or reused for continuation),
 * torn down at completion. Used to address an in-flight execution.
 *
 * Both used to be called `session_id` and conflating the two caused real
 * bugs (the most recent: a worker overwrote storage ids with the exec id
 * on response, breaking next-turn file mounts). All three repos
 * (codeapi / `@librechat/agents` / LibreChat) deploy this rename in
 * lockstep, so no legacy `session_id` alias is kept — old client builds
 * are not expected after cutover.
 */
export type FileRef = {
  id: string;
  name: string;
  /** Per-file storage session id (where the bytes live in object storage). */
  storage_session_id?: string;
  path?: string;
  /** Lineage tracking - present if this file was modified from a previous session's file */
  modified_from?: {
    id: string;
    storage_session_id: string;
  };
  /**
   * `true` when the sandbox echoed this entry as an unchanged passthrough
   * of an input the caller already owns. Surfaced so callers can render
   * inputs distinctly from generated outputs and skip post-processing.
   */
  inherited?: true;
};

/**
 * Closed set of resource kinds for sandbox file caching. Defined as an
 * `as const` tuple so the runtime list and the TypeScript union can't
 * drift on future additions — adding a new kind to the tuple updates
 * both at once, and the exhaustive `never` check in `resolveSessionKey`
 * surfaces missing switch arms at compile time.
 *
 * - `skill`: shared per skill identity. Cross-user-within-tenant
 *   sharing. SessionKey omits the user dimension. `version` is required
 *   so a skill edit naturally invalidates the prior cache entry under
 *   the new sessionKey.
 * - `agent`: shared per agent identity. Same sharing semantic as
 *   skills.
 * - `user`: user-private. SessionKey is keyed by the requesting user
 *   from auth context. Used for chat attachments and code-output
 *   artifacts.
 */
export const CODE_ENV_KINDS = ['skill', 'agent', 'user'] as const;
export type CodeEnvKind = (typeof CODE_ENV_KINDS)[number];

export type RequestFile = {
  /**
   * **Storage file id** — the per-file uuid the file_server returns
   * at upload time and that uniquely identifies the bytes at
   * `<storage_session_id>/<id>` in the object bucket. Used by the
   * worker to fetch file contents and by the auth layer's upload-key
   * existence check.
   */
  id: string;
  /**
   * **Resource id** — the identity of the entity that owns this
   * file's storage session. Skill `_id` for `kind: 'skill'`, agent
   * id for `'agent'`, informational-only for `'user'` (sessionKey
   * derives from auth context). Distinct from `id` (the storage
   * uuid) — this one drives `resolveSessionKey`. Conflating the two
   * at the wire level (a single `id` field) caused authorization to
   * fail on every shared-kind `/exec` because the sessionKey
   * re-derivation used the storage nanoid as the resource id and
   * produced a key that didn't match the cached one. See codeapi
   * #1455 review.
   */
  resource_id: string;
  /** Per-file storage session id (where the bytes live in object storage). */
  storage_session_id: string;
  name: string;
  /** Resource kind. Drives `resolveSessionKey`'s switch — for shared
   *  kinds (`'skill'`, `'agent'`) the sessionKey omits the user
   *  dimension; for `'user'` it includes the user from auth context. */
  kind: CodeEnvKind;
  /** Resource version. Required when `kind: 'skill'`; rejected
   *  otherwise. The skill's monotonic version counter scopes the cache
   *  per revision so any edit naturally invalidates the prior cache
   *  entry under the new sessionKey. */
  version?: number;
};

export type FileRefs = FileRef[];

export type ExecuteResponse = {
  run?: {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    output: string;
    memory: number | null;
    message: string | null;
    status: string | null;
    cpu_time: number | null;
    wall_time: number | null;
  };
  language: string;
  version: string;
  /** Top-level execution session id (one sandbox `/exec` invocation). */
  session_id: string;
  files: FileRefs;
};

export interface RequestBody {
  code: string;
  lang: string;
  args?: string[];
  user_id?: string;
  files?: RequestFile[];
  /**
   * Optional stable identity hint (e.g. conversation id) for stateful
   * runtime sessions. Never a security boundary: the server derives the
   * final runtime session id as hash(tenant, user, hint). Ignored when
   * CODEAPI_RUNTIME_SESSION_MODE is `stateless`.
   */
  runtime_session_hint?: string;
}

export type CreatePayload = { req: AuthenticatedRequest, session_id: string; isPyPlot?: boolean };
export interface FileObject {
  name: string;
  id: string;
  /** Per-file storage session id. */
  storage_session_id: string;
  content?: string;
  encoding?: 'base64'|'hex'|'utf8';
  size?: number;
  lastModified?: string;
  etag?: string;
  metadata?: {
    'content-type': string;
    'original-filename': string;
  } | undefined;
  versionId?: string | null;
  contentType?: string;
}

export type PayloadFile = { name: string; content: string };
export type PayloadFileRef = {
  id: string;
  storage_session_id: string;
  name: string;
  /**
   * Stable opaque identity for runner-local input caching. The worker derives
   * it from the authorized raw ref before hardened egress replaces the raw
   * identifiers with per-grant handles.
   */
  input_cache_key?: string;
};

export interface PayloadBody {
  language: string;
  version: string;
  run_memory_limit?: number;
  run_timeout?: number;
  run_cpu_time?: number;
  /* Intra-monorepo wire (service-api → sandbox). Hard rename — no
   * legacy compat needed because both ends ship together. The sandbox
   * downloads files by `(storage_session_id, id)`; `kind`/`version`
   * are sessionKey-derivation inputs at the service entry, never
   * consumed by the sandbox, so they're intentionally not on this
   * shape. */
  files: Array<PayloadFile | PayloadFileRef>;
  /** Top-level execution session id (passed to sandbox to seed Job.uuid). */
  session_id?: string;
  /** Output storage session id/handle used for generated file uploads. */
  output_session_id?: string;
  /**
   * Opaque encrypted grant consumed only by sandbox-runner for gateway file
   * egress. This intentionally rides in the JSON body instead of an HTTP
   * header because large skill/file batches can exceed server header limits.
   */
  egress_grant?: string;
  /**
   * Signed execution scope consumed only by sandbox-runner. Kept in the body
   * for the same reason as `egress_grant`.
   */
  execution_manifest?: string;
  /**
   * Allows this single execution to see the sandbox tool-call unix socket.
   * Only blocking-mode PTC needs it; replay-mode PTC and ordinary execute
   * requests should leave the socket unmounted.
   */
  tool_call_socket?: boolean;
  args?: string[];
  /**
   * Extra environment variables to inject into the sandboxed process via nsjail -E.
   * NOTE: PTC replay mode delivers tool-result history as a payload file
   * (`_ptc_history.json` under `/mnt/data`) rather than through this field;
   * the sandbox locates it via `PTC_HISTORY_PATH`. Size-sensitive data should
   * use files to avoid the Linux ARG_MAX ceiling.
   */
  env_vars?: Record<string, string>;
}

export type ExecuteResult = {
  /** Top-level execution session id (one sandbox `/exec` invocation). */
  session_id: string;
  stdout: string;
  stderr: string;
  files: FileRefs;
  code?: number | null;
  signal?: string | null;
  message?: string | null;
  status?: string | null;
  wall_time?: number | null;
};

export interface LanguageConfig {
  language: string;
  version: string;
  fileName: string;
  runtime?: string;
}

export type RuntimeSessionMode = 'stateless' | 'affinity' | 'strict';

/** Explicit reasons a queue job may remain stateless in a stateful mode. */
export type RuntimeSessionExemption = 'programmatic';

export type JobData = {
  code: string;
  userId: string;
  apiKeyId: string;
  principalSource?: string;
  isSynthetic?: boolean;
  payload: PayloadBody;
  isPyPlot?: boolean;
  executionId?: string;
  tenantId?: string;
  canonicalUserId?: string;
  /** Trusted dynamic outbound worker selection. */
  bridgeWorkerId?: string;
  /** Producer deployment identity. Optional only for pre-profile queued jobs. */
  executionProfile?: ExecutionProfile;
  /**
   * Server-derived runtime session identity. Absence is stateless unless
   * strict mode requires it; explicit exemptions document intentional gaps.
   */
  runtimeSessionId?: string;
  /**
   * Producer-owned effective execution mode. This crosses the BullMQ boundary
   * so API/worker rollout skew cannot reinterpret a stateful job as stateless
   * (or reject an intentional stateless fallback). Optional only for queued
   * jobs created before this field existed; workers infer those from the
   * presence of runtimeSessionId.
   */
  runtimeSessionMode?: RuntimeSessionMode;
  /**
   * Intentional stateless exception. Programmatic/replay execution externalizes
   * continuation state and does not yet bind PTC rounds to a warm session.
   */
  runtimeSessionExemption?: RuntimeSessionExemption;
  executionManifestClaims?: ExecutionManifestClaims;
  /** Raw grant claims retained only for service-worker dispatch so grant
   * expiry is anchored to sandbox start, not BullMQ enqueue time. */
  egressGrantClaims?: ExecutionManifestClaims;
  /** Opaque encrypted grant passed to sandbox-runner for gateway-only file egress. */
  egressGrantToken?: string;
  /** W3C trace context carrier injected by the API before the BullMQ boundary. */
  _otel?: Record<string, string>;
};
export type JobResult = ExecuteResult;
export type ExecuteJob = Job<JobData, JobResult, Jobs.execute>;

export interface CodeApiAuthContext {
  userId: string;
  /** Multi-tenant prefix used by `resolveSessionKey`. Optional because
   *  single-tenant deploys may not populate it; `TENANT_ISOLATION_STRICT`
   *  rejects requests missing this field, otherwise `'legacy'` is used. */
  tenantId?: string;
  orgId?: string;
  serviceId?: string;
  externalUserId?: string;
  principalSource?: string;
  authContextHash?: string;
}

export interface AuthenticatedRequest extends Request {
  sessionKey?: string;
  planId?: string;
  executionIdentity?: ExecutionIdentity;
  codeApiAuthContext?: CodeApiAuthContext;
  codeApiPrincipal?: CodeApiPrincipal;
}

export interface ProgrammaticTool {
  name: string;
  description?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// Programmatic Tool Calling Types
export interface ProgrammaticRequestBody {
  code: string;
  tools?: ProgrammaticTool[];
  /** Top-level execution session id (continuation reuses this). */
  session_id?: string;
  timeout?: number;
  continuation_token?: string;
  tool_results?: Array<{
    call_id: string;
    result: unknown;
    is_error?: boolean;
    error_message?: string;
  }>;
  user_id?: string;
  files?: RequestFile[];
  /** Optional. Defaults to 'python'. Currently supported: 'python', 'bash'. */
  language?: 'python' | 'bash';
  /** Back-compat alias for `language`. The `danny-avila/agents` bash PTC
   * client sends `lang: 'bash'` (mirroring the `lang` field on the
   * legacy `/exec` sandbox body), so the router accepts either key and
   * normalizes to `language`. If both are present, `language` wins. */
  lang?: 'python' | 'bash';
}

export interface ProgrammaticToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProgrammaticResponse {
  status: 'tool_call_required' | 'completed' | 'error';
  continuation_token?: string;
  tool_calls?: ProgrammaticToolCall[];
  partial_stdout?: string;
  partial_stderr?: string;
  stdout?: string;
  stderr?: string;
  files?: FileRefs;
  /** Top-level execution session id (one sandbox PTC invocation). */
  session_id?: string;
  tool_calls_made?: number;
  execution_time?: number;
  error?: string;
  error_type?: string;
}
