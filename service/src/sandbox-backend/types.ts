import type * as t from '../types';
import { getAxiosErrorDetails } from '../utils';

/**
 * Fully built sandbox execute request: `body` already carries the egress
 * grant and signed execution manifest from `buildSandboxExecuteRequest`.
 * Backends MUST NOT mutate `body` — the manifest binds its sha256.
 */
export interface SandboxTransportRequest {
  body: t.PayloadBody;
  headers: Record<string, string>;
  /**
   * Control-plane-only fetch refs. These retain authorized storage IDs while
   * `body.files` may contain per-grant sandbox handles. Backends must never
   * serialize this field to the sandbox.
   */
  inputDelivery?: SandboxInputDeliveryRef[];
}

export interface SandboxInputDeliveryRef {
  id: string;
  storage_session_id: string;
  name: string;
  cache_key: string;
}

export interface SandboxExecuteContext {
  executionId: string;
  language: string;
  isSynthetic: boolean;
  /** Worker-owned JOB_TIMEOUT abort signal. */
  signal: AbortSignal;
  /** Absolute deadline anchored to BullMQ enqueue time when available. Unlike
   * a backend-local timer, this includes queue wait, egress-grant creation, and
   * request setup. Direct backend callers may omit it and receive a
   * backend-entry fallback. */
  deadlineAtMs?: number;
  tenantId?: string;
  canonicalUserId?: string;
  /** Absent ⇒ stateless execution (no runtime session affinity). */
  runtimeSessionId?: string;
  runtimeSessionMode: t.RuntimeSessionMode;
  /**
   * Worker-owned result transformation that must succeed before a stateful
   * backend makes workspace mutations reusable or durable. Stateless backends
   * intentionally leave this to the worker's normal post-execute path.
   */
  sessionResultFinalizer?: (result: SandboxRawResponse) => Promise<SandboxRawResponse>;
}

/** Raw sandbox response, pre-gateway-restore. */
export type SandboxRawResponse = t.ExecuteResponse & {
  session_id: string;
  files?: t.FileRefs;
  run?: t.ExecuteResponse['run'];
};

export interface SandboxBackend {
  readonly name: 'http' | 'lambda-microvm' | 'remote-bridge';
  execute(req: SandboxTransportRequest, ctx: SandboxExecuteContext): Promise<SandboxRawResponse>;
  shutdown?(): Promise<void>;
}

export type SandboxBackendErrorCode =
  | 'RUNTIME_SESSION_BUSY'
  | 'BRIDGE_WORKER_OFFLINE'
  | 'BRIDGE_WORKER_BUSY'
  | 'BRIDGE_EXECUTION_FAILED'
  | 'BRIDGE_DEADLINE_EXCEEDED'
  | 'MICROVM_LAUNCH_FAILED'
  | 'MICROVM_LAUNCH_THROTTLED'
  | 'MICROVM_UNHEALTHY'
  | 'MICROVM_FENCED'
  | 'MICROVM_DEADLINE_EXCEEDED';

/** Lambda-only failure modes; the worker prefixes messages with the code so
 *  the router can map them (e.g. RUNTIME_SESSION_BUSY -> 409). Axios errors
 *  from the sandbox POST itself are rethrown raw by every backend. */
export class SandboxBackendError extends Error {
  /**
   * The originating failure, ALWAYS stored sanitized. Backend causes are
   * routinely axios errors whose `config` carries the minted MicroVM auth
   * header, the internal service token, and (on a push) the request body —
   * i.e. the archive bytes. Callers log wrapper errors wholesale, so
   * sanitizing at construction is the only place that covers every path.
   */
  public readonly cause?: unknown;

  /**
   * @param transient - Marks a failure the backend may safely retry once with
   * fresh identifiers (e.g. a MicroVM that reached a terminal state during
   * boot). Throttles, aborts, and deadline timeouts stay non-transient: a
   * throttle retry worsens the pressure and a timeout retry doubles the wait.
   */
  constructor(
    public readonly code: SandboxBackendErrorCode,
    message: string,
    cause?: unknown,
    public readonly transient: boolean = false,
  ) {
    super(message);
    this.name = 'SandboxBackendError';
    this.cause = cause === undefined ? undefined : getAxiosErrorDetails(cause);
  }
}
