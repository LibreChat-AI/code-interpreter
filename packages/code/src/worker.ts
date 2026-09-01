import { randomBytes } from 'node:crypto';

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  bridgeWorkerPath,
} from './protocol.js';
import { signBridgeRequest } from './identity.js';

import type {
  BridgeAssignment,
  BridgeLeaseResponse,
  BridgeSettlement,
  BridgeSettlementResponse,
  BridgeWorkerCapabilities,
  BridgeWorkerCredentialResponse,
  BridgeWorkerRegistrationResponse,
} from './protocol.js';

export interface BridgeWorkerOptions {
  codeApiUrl: string;
  token?: string;
  identity?: BridgeWorkerIdentity;
  workerId: string;
  sandboxEndpoint: string;
  capabilities: BridgeWorkerCapabilities;
  leaseWaitMs?: number;
  leaseTransportGraceMs?: number;
  registrationTransportTimeoutMs?: number;
  leaseAckTransportTimeoutMs?: number;
  resetTransportTimeoutMs?: number;
  cancellationPollIntervalMs?: number;
  cancellationTransportTimeoutMs?: number;
  rejectionAckGraceMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectRandom?: () => number;
  credentialRefreshWindowMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
  onIdentityChange?: (identity: BridgeWorkerIdentity) => void | Promise<void>;
  incarnationId?: string;
}

export interface BridgeWorkerIdentity {
  privateKey: string;
  credential: string;
  expiresAt: string;
}

const DEFAULT_LEASE_WAIT_MS = 25_000;
const MAX_LEASE_WAIT_MS = 30_000;
const DEFAULT_LEASE_TRANSPORT_GRACE_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const CREDENTIAL_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_REGISTRATION_TTL_MS = 60_000;
const DEFAULT_REGISTRATION_TRANSPORT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTROL_TRANSPORT_TIMEOUT_MS = 10_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 500;
const DEFAULT_CANCELLATION_TRANSPORT_TIMEOUT_MS = 2_000;
const MIN_REGISTRATION_HEARTBEAT_MS = 25;
const REGISTRATION_RETRY_DELAY_MS = 100;
const SETTLEMENT_RETRY_DELAY_MS = 100;
const REJECTION_ACK_GRACE_MS = 30_000;
const MAX_SETTLEMENT_ERROR_LENGTH = 4_096;
const RUNTIME_SESSION_PLACEHOLDER = '{runtimeSessionId}';

export function reconnectDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  return Math.floor(cap * (0.5 + Math.min(1, Math.max(0, random())) * 0.5));
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(value: object): string | undefined {
  if ('error' in value && typeof value.error === 'string') return value.error;
  return undefined;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorCode(value: object): string | undefined {
  if ('code' in value && typeof value.code === 'string') return value.code;
  return undefined;
}

export class BridgeWorkspaceQuarantinedError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BridgeWorkspaceQuarantinedError';
  }
}

export class BridgeWorker {
  private readonly fetchImpl: typeof fetch;
  private readonly codeApiUrl: string;
  private readonly sandboxEndpoint: string;
  private readonly incarnationId: string;
  private registrationTtlMs = DEFAULT_REGISTRATION_TTL_MS;
  private lastRegisteredAtMs = 0;

  constructor(private readonly options: BridgeWorkerOptions) {
    if (!options.token && !options.identity) {
      throw new BridgeProtocolError(
        'Bridge worker requires a static token or paired identity',
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.codeApiUrl = normalizedBaseUrl(options.codeApiUrl);
    this.sandboxEndpoint = normalizedBaseUrl(options.sandboxEndpoint);
    this.incarnationId =
      options.incarnationId ?? randomBytes(18).toString('base64url');
  }

  async register(
    signal?: AbortSignal,
  ): Promise<BridgeWorkerRegistrationResponse> {
    const registrationController = new AbortController();
    const abortRegistration = (): void => registrationController.abort();
    if (signal?.aborted) {
      abortRegistration();
    } else {
      signal?.addEventListener('abort', abortRegistration, { once: true });
    }
    const timeoutMs = Math.min(
      Math.max(1, this.registrationTtlMs - 1),
      Math.max(
        1,
        this.options.registrationTransportTimeoutMs ??
          DEFAULT_REGISTRATION_TRANSPORT_TIMEOUT_MS,
      ),
    );
    const timeout = setTimeout(abortRegistration, timeoutMs);
    const registrationStartedAtMs = Date.now();
    let registration: BridgeWorkerRegistrationResponse;
    try {
      registration = await this.request<BridgeWorkerRegistrationResponse>(
        `${this.codeApiUrl}/bridge/workers/register`,
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          workerId: this.options.workerId,
          incarnationId: this.incarnationId,
          capabilities: this.options.capabilities,
        },
        registrationController.signal,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortRegistration);
    }
    if (registration.incarnationId !== this.incarnationId) {
      throw new BridgeProtocolError(
        'Code API registered a different worker incarnation',
      );
    }
    this.registrationTtlMs = registration.leaseTtlMs;
    this.lastRegisteredAtMs = registrationStartedAtMs;
    return registration;
  }

  async resetWorkspace(
    runtimeSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (runtimeSessionId.trim().length === 0) {
      throw new BridgeProtocolError('Runtime session ID is required');
    }
    await this.timedRequest(
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}/workspaces/reset`,
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        incarnationId: this.incarnationId,
        runtimeSessionId,
        confirmDiscarded: true,
      },
      Math.max(
        1,
        this.options.resetTransportTimeoutMs ??
          DEFAULT_CONTROL_TRANSPORT_TIMEOUT_MS,
      ),
      signal,
    );
  }

  async lease(signal?: AbortSignal): Promise<BridgeAssignment | undefined> {
    const waitMs = Math.min(
      MAX_LEASE_WAIT_MS,
      Math.max(0, this.options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS),
    );
    const leaseController = new AbortController();
    const abortLease = (): void => leaseController.abort();
    if (signal?.aborted) {
      abortLease();
    } else {
      signal?.addEventListener('abort', abortLease, { once: true });
    }
    const timeout = setTimeout(
      abortLease,
      waitMs +
        Math.max(
          0,
          this.options.leaseTransportGraceMs ??
            DEFAULT_LEASE_TRANSPORT_GRACE_MS,
        ),
    );
    let response: BridgeLeaseResponse;
    const requestStartedAtMs = Date.now();
    try {
      response = await this.request<BridgeLeaseResponse>(
        `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}/lease`,
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          waitMs,
          incarnationId: this.incarnationId,
        },
        leaseController.signal,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortLease);
    }
    if (
      response.assignment != null &&
      response.assignment.incarnationId !== this.incarnationId
    ) {
      throw new BridgeProtocolError(
        'Code API leased an assignment for a different worker incarnation',
      );
    }
    if (
      response.assignment != null &&
      (!Number.isSafeInteger(response.assignment.remainingMs) ||
        (response.assignment.remainingMs ?? -1) < 0)
    ) {
      throw new BridgeProtocolError(
        'Code API leased an assignment without a valid server-relative deadline',
      );
    }
    if (response.assignment == null) return undefined;
    if (
      !Number.isSafeInteger(response.serverElapsedMs) ||
      (response.serverElapsedMs ?? -1) < 0
    ) {
      throw new BridgeProtocolError(
        'Code API leased an assignment without valid server timing',
      );
    }
    const transportElapsedMs = Math.max(
      0,
      Date.now() - requestStartedAtMs - (response.serverElapsedMs ?? 0),
    );
    const adjustedAssignment = {
      ...response.assignment,
      remainingMs: Math.max(
        0,
        (response.assignment.remainingMs ?? 0) - transportElapsedMs,
      ),
    };
    const acknowledgementStartedAtMs = Date.now();
    try {
      await this.timedRequest(
        this.assignmentUrl(adjustedAssignment, 'ack'),
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          incarnationId: this.incarnationId,
          generation: adjustedAssignment.generation,
          leaseToken: adjustedAssignment.leaseToken,
        },
        Math.max(
          1,
          this.options.leaseAckTransportTimeoutMs ??
            DEFAULT_CONTROL_TRANSPORT_TIMEOUT_MS,
        ),
        signal,
      );
    } catch (error) {
      const definiteRejection =
        error instanceof BridgeProtocolError &&
        error.status != null &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429;
      if (!definiteRejection) {
        await this.rejectUnexecutedAssignment(
          adjustedAssignment,
          'Bridge lease acknowledgement delivery was ambiguous',
        );
      }
      throw error;
    }
    const remainingMs = Math.max(
      0,
      (adjustedAssignment.remainingMs ?? 0) -
        (Date.now() - acknowledgementStartedAtMs),
    );
    if (remainingMs <= 0) {
      await this.rejectUnexecutedAssignment(
        adjustedAssignment,
        'Bridge assignment expired during lease acknowledgement',
      );
      throw new BridgeProtocolError(
        'Bridge assignment expired during lease acknowledgement',
      );
    }
    return {
      ...adjustedAssignment,
      remainingMs,
    };
  }

  async run(signal?: AbortSignal): Promise<void> {
    let reconnectAttempt = 0;
    while (!signal?.aborted) {
      try {
        await this.refreshCredential(signal);
        await this.register(signal);
        const assignment = await this.lease(signal);
        reconnectAttempt = 0;
        if (!assignment) continue;
        await this.executeAndSettle(assignment, signal);
      } catch (error) {
        if (error instanceof BridgeWorkspaceQuarantinedError) {
          throw error;
        }
        if (signal?.aborted) return;
        if (
          error instanceof BridgeProtocolError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.code === 'WORKER_FENCED' ||
            error.code === 'WORKER_QUARANTINED')
        ) {
          throw error;
        }
        this.options.onError?.(error);
        const delay = reconnectDelayMs(
          reconnectAttempt,
          this.options.reconnectDelayMs,
          this.options.reconnectMaxDelayMs,
          this.options.reconnectRandom,
        );
        reconnectAttempt += 1;
        await abortableDelay(delay, signal);
      }
    }
  }

  async refreshCredential(
    signal?: AbortSignal,
    validThroughMs =
      Date.now() +
      (this.options.credentialRefreshWindowMs ?? CREDENTIAL_REFRESH_WINDOW_MS),
  ): Promise<void> {
    const identity = this.options.identity;
    if (identity == null) return;
    if (
      Date.parse(identity.expiresAt) > validThroughMs
    ) {
      return;
    }
    const credential = await this.request<BridgeWorkerCredentialResponse>(
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}` +
        '/credentials/refresh',
      { protocolVersion: BRIDGE_PROTOCOL_VERSION },
      signal,
    );
    if (
      credential.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      credential.workerId !== this.options.workerId ||
      typeof credential.credential !== 'string' ||
      credential.credential.length < 32 ||
      !Number.isFinite(Date.parse(credential.expiresAt)) ||
      Date.parse(credential.expiresAt) <= validThroughMs
    ) {
      throw new BridgeProtocolError(
        'Code API returned an invalid rotated worker credential',
      );
    }
    const rotatedIdentity: BridgeWorkerIdentity = {
      ...identity,
      credential: credential.credential,
      expiresAt: credential.expiresAt,
    };
    await this.options.onIdentityChange?.(rotatedIdentity);
    identity.credential = rotatedIdentity.credential;
    identity.expiresAt = rotatedIdentity.expiresAt;
  }

  private async maintainCredential(
    assignment: BridgeAssignment,
    stopSignal: AbortSignal,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    const identity = this.options.identity;
    if (identity == null) return;
    const refreshWindowMs =
      this.options.credentialRefreshWindowMs ?? CREDENTIAL_REFRESH_WINDOW_MS;
    const assignmentDeadlineMs = Date.parse(assignment.expiresAt);
    while (!stopSignal.aborted && Date.now() < assignmentDeadlineMs) {
      const refreshAtMs = Date.parse(identity.expiresAt) - refreshWindowMs;
      const waitMs = Math.max(
        0,
        Math.min(refreshAtMs - Date.now(), assignmentDeadlineMs - Date.now()),
      );
      await abortableDelay(waitMs, stopSignal);
      if (stopSignal.aborted || Date.now() >= assignmentDeadlineMs) return;
      await this.refreshCredential(requestSignal);
    }
  }

  async executeAndSettle(
    assignment: BridgeAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('aborted', 'AbortError');
    }
    await this.refreshCredential(signal);
    const executionController = new AbortController();
    const credentialController = new AbortController();
    const abortExecution = (): void => {
      executionController.abort();
      credentialController.abort();
    };
    signal?.addEventListener('abort', abortExecution, { once: true });
    const deadlineDelay = this.assignmentRemainingMs(assignment);
    const localDeadlineAtMs = Date.now() + deadlineDelay;
    const deadlineTimer = setTimeout(
      () => executionController.abort(),
      deadlineDelay,
    );
    if (this.lastRegisteredAtMs === 0) {
      this.lastRegisteredAtMs = Date.now();
    }
    const heartbeatController = new AbortController();
    let heartbeatError: unknown;
    const heartbeat = this.maintainRegistration(
      heartbeatController.signal,
    ).catch((error) => {
      heartbeatError = error;
      executionController.abort();
    });
    const cancellationController = new AbortController();
    const cancellationWatcher = this.watchCancellation(
      assignment,
      executionController,
      cancellationController.signal,
    );
    let credentialMaintenanceError: unknown;
    let credentialMaintenance: Promise<void> | undefined;
    let settlement: BridgeSettlement;
    let ambiguousSandboxError: unknown;
    let sandboxRejectedExecution = false;
    try {
      credentialMaintenance = this.maintainCredential(
        assignment,
        credentialController.signal,
        signal,
      ).catch((error) => {
        credentialMaintenanceError = error;
        executionController.abort();
      });
      const sandboxSessionId = this.sandboxSessionIdFor(assignment);
      const headers = {
        ...assignment.request.headers,
        ...(sandboxSessionId
          ? { 'X-Runtime-Session-Id': sandboxSessionId }
          : {}),
      };
      const response = await this.fetchImpl(
        `${this.sandboxEndpointFor(assignment)}/execute`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(assignment.request.body),
          signal: executionController.signal,
        },
      );
      let payload: object = {};
      try {
        payload = (await response.json()) as object;
      } catch (error) {
        if (response.ok) throw error;
      }
      if (credentialMaintenanceError != null) {
        throw credentialMaintenanceError;
      }
      if (!response.ok) {
        sandboxRejectedExecution =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429 &&
          errorMessage(payload) !== 'session_workspace_dirty';
        throw new BridgeProtocolError(
          errorMessage(payload) ??
            `Sandbox rejected execution with HTTP ${response.status}`,
          response.status,
        );
      }
      if (heartbeatError != null) throw heartbeatError;
      settlement = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment.generation,
        leaseToken: assignment.leaseToken,
        incarnationId: this.incarnationId,
        status: 'fulfilled',
        result: payload,
      };
    } catch (error) {
      if (
        assignment.runtimeSessionId != null &&
        !sandboxRejectedExecution
      ) {
        ambiguousSandboxError = error;
      }
      settlement = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment.generation,
        leaseToken: assignment.leaseToken,
        incarnationId: this.incarnationId,
        status: 'rejected',
        error:
          (error instanceof Error
            ? error.message
            : 'Sandbox execution failed'
          ).slice(0, MAX_SETTLEMENT_ERROR_LENGTH),
      };
    }

    clearTimeout(deadlineTimer);
    cancellationController.abort();
    await cancellationWatcher;
    try {
      if (ambiguousSandboxError != null) {
        throw new BridgeWorkspaceQuarantinedError(
          `Stateful workspace ${assignment.runtimeSessionId} was quarantined after an ambiguous sandbox execution`,
          ambiguousSandboxError,
        );
      }
      const knownCleanStatefulRejection =
        assignment.runtimeSessionId != null &&
        settlement.status === 'rejected' &&
        sandboxRejectedExecution;
      if (knownCleanStatefulRejection) {
        heartbeatController.abort();
        await heartbeat;
        const recoveryHeartbeatController = new AbortController();
        const recoveryHeartbeat = this.maintainRegistration(
          recoveryHeartbeatController.signal,
          true,
        ).catch(() => undefined);
        try {
          await this.settleWithRetry(
            assignment,
            settlement,
            localDeadlineAtMs +
              Math.max(
                0,
                this.options.rejectionAckGraceMs ?? REJECTION_ACK_GRACE_MS,
              ),
          );
        } finally {
          recoveryHeartbeatController.abort();
          await recoveryHeartbeat;
        }
      } else {
        await this.settleWithRetry(
          assignment,
          settlement,
          localDeadlineAtMs,
          signal,
        );
      }
    } finally {
      heartbeatController.abort();
      await heartbeat;
      credentialController.abort();
      await credentialMaintenance;
      signal?.removeEventListener('abort', abortExecution);
    }
  }

  private sandboxSessionIdFor(
    assignment: BridgeAssignment,
  ): string | undefined {
    if (assignment.runtimeSessionId != null) {
      return assignment.runtimeSessionId;
    }
    if (this.sandboxEndpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
      return `assignment-${assignment.assignmentId}`;
    }
    return undefined;
  }

  private assignmentRemainingMs(assignment: BridgeAssignment): number {
    if (
      Number.isSafeInteger(assignment.remainingMs) &&
      (assignment.remainingMs ?? -1) >= 0
    ) {
      return assignment.remainingMs ?? 0;
    }
    return Math.max(0, Date.parse(assignment.expiresAt) - Date.now());
  }

  private sandboxEndpointFor(assignment: BridgeAssignment): string {
    if (assignment.runtimeSessionId == null) {
      if (!this.sandboxEndpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
        return this.sandboxEndpoint;
      }
      return this.sandboxEndpoint.replace(
        RUNTIME_SESSION_PLACEHOLDER,
        encodeURIComponent(`assignment-${assignment.assignmentId}`),
      );
    }
    if (
      this.options.capabilities.statefulWorkspace !== true ||
      !this.sandboxEndpoint.includes(RUNTIME_SESSION_PLACEHOLDER)
    ) {
      throw new BridgeProtocolError(
        'Stateful assignments require a sandbox endpoint template containing {runtimeSessionId}',
      );
    }
    return this.sandboxEndpoint.replace(
      RUNTIME_SESSION_PLACEHOLDER,
      encodeURIComponent(assignment.runtimeSessionId),
    );
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    await abortableDelay(ms, signal);
  }

  private async maintainRegistration(
    signal: AbortSignal,
    retryTransient = false,
  ): Promise<void> {
    while (!signal.aborted) {
      const heartbeatIntervalMs = Math.max(
        MIN_REGISTRATION_HEARTBEAT_MS,
        Math.floor(this.registrationTtlMs / 2),
      );
      await this.delay(
        Math.max(
          0,
          this.lastRegisteredAtMs + heartbeatIntervalMs - Date.now(),
        ),
        signal,
      );
      if (signal.aborted) return;
      try {
        await this.register(signal);
      } catch (error) {
        const terminal =
          error instanceof BridgeProtocolError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.code === 'WORKER_FENCED' ||
            error.code === 'WORKER_QUARANTINED');
        if (!retryTransient || terminal || signal.aborted) throw error;
        await this.delay(REGISTRATION_RETRY_DELAY_MS, signal);
      }
    }
  }

  private async rejectUnexecutedAssignment(
    assignment: BridgeAssignment,
    error: string,
  ): Promise<void> {
    const heartbeatController = new AbortController();
    const heartbeat = this.maintainRegistration(
      heartbeatController.signal,
      true,
    ).catch(() => undefined);
    try {
      await this.settleWithRetry(
        assignment,
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          generation: assignment.generation,
          leaseToken: assignment.leaseToken,
          incarnationId: this.incarnationId,
          status: 'rejected',
          error,
        },
        Date.now() +
          Math.max(
            0,
            this.options.rejectionAckGraceMs ?? REJECTION_ACK_GRACE_MS,
          ),
      );
    } finally {
      heartbeatController.abort();
      await heartbeat;
    }
  }

  private assignmentUrl(assignment: BridgeAssignment, action: string): string {
    return (
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}` +
      `/assignments/${encodeURIComponent(assignment.assignmentId)}/${action}`
    );
  }

  private async settleWithRetry(
    assignment: BridgeAssignment,
    settlement: BridgeSettlement,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) {
      if (assignment.runtimeSessionId != null) {
        throw new BridgeWorkspaceQuarantinedError(
          `Stateful workspace ${assignment.runtimeSessionId} was quarantined before settlement during shutdown`,
          signal.reason,
        );
      }
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('aborted', 'AbortError');
    }
    const settlementController = new AbortController();
    const abortSettlement = (): void => settlementController.abort();
    signal?.addEventListener('abort', abortSettlement, { once: true });
    const deadlineTimer = setTimeout(
      () => settlementController.abort(),
      Math.max(0, deadlineAtMs - Date.now()),
    );
    let lastError: unknown;
    try {
      while (!settlementController.signal.aborted) {
        try {
          await this.request<BridgeSettlementResponse>(
            this.assignmentUrl(assignment, 'settle'),
            settlement,
            settlementController.signal,
          );
          return;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) break;
          if (
            error instanceof BridgeProtocolError &&
            error.status != null &&
            error.status < 500 &&
            error.status !== 408 &&
            error.status !== 429
          ) {
            if (
              assignment.runtimeSessionId != null &&
              settlement.status === 'fulfilled'
            ) {
              throw new BridgeWorkspaceQuarantinedError(
                `Stateful workspace ${assignment.runtimeSessionId} was quarantined after Code API rejected its fulfilled settlement`,
                error,
              );
            }
            throw error;
          }
          const remainingMs = deadlineAtMs - Date.now();
          if (remainingMs <= 0) break;
          await this.delay(
            Math.min(SETTLEMENT_RETRY_DELAY_MS, remainingMs),
            settlementController.signal,
          );
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abortSettlement);
    }
    if (
      assignment.runtimeSessionId != null &&
      settlement.status === 'fulfilled'
    ) {
      throw new BridgeWorkspaceQuarantinedError(
        `Stateful workspace ${assignment.runtimeSessionId} was quarantined after ambiguous settlement delivery`,
        lastError,
      );
    }
    if (lastError instanceof Error) throw lastError;
    throw new BridgeProtocolError('Bridge settlement deadline expired');
  }

  private async watchCancellation(
    assignment: BridgeAssignment,
    executionController: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !executionController.signal.aborted) {
      await this.delay(
        Math.max(
          1,
          this.options.cancellationPollIntervalMs ??
            DEFAULT_CANCELLATION_POLL_INTERVAL_MS,
        ),
        signal,
      );
      if (signal.aborted || executionController.signal.aborted) return;
      const pollController = new AbortController();
      const abortPoll = (): void => pollController.abort();
      signal.addEventListener('abort', abortPoll, { once: true });
      const timeout = setTimeout(
        abortPoll,
        Math.max(
          1,
          this.options.cancellationTransportTimeoutMs ??
            DEFAULT_CANCELLATION_TRANSPORT_TIMEOUT_MS,
        ),
      );
      try {
        const response = await this.request<{ cancelled: boolean }>(
          this.assignmentUrl(assignment, 'cancellation'),
          {
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            incarnationId: this.incarnationId,
          },
          pollController.signal,
        );
        if (response.cancelled) {
          executionController.abort();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof BridgeProtocolError && error.status === 404) {
          executionController.abort();
          return;
        }
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortPoll);
      }
    }
  }

  private async request<T>(
    url: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestBody = JSON.stringify(body);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...this.authorizationHeaders(url, requestBody),
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (response.ok) throw error;
      payload = {};
    }
    if (!response.ok) {
      const errorPayload =
        typeof payload === 'object' && payload !== null ? payload : {};
      throw new BridgeProtocolError(
        errorMessage(errorPayload) ??
          `Bridge request failed with HTTP ${response.status}`,
        response.status,
        errorCode(errorPayload),
      );
    }
    return payload as T;
  }

  private authorizationHeaders(
    url: string,
    body: string,
  ): Record<string, string> {
    const identity = this.options.identity;
    if (identity == null) {
      return { Authorization: `Bearer ${this.options.token}` };
    }
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(18).toString('base64url');
    const proof = {
      credential: identity.credential,
      method: 'POST',
      path: new URL(url).pathname,
      timestamp,
      nonce,
      body,
    };
    return {
      Authorization: `Bridge ${identity.credential}`,
      'X-LibreChat-Code-Timestamp': timestamp,
      'X-LibreChat-Code-Nonce': nonce,
      'X-LibreChat-Code-Signature': signBridgeRequest(
        identity.privateKey,
        proof,
      ),
    };
  }

  private async timedRequest<T>(
    url: string,
    body: object,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abortRequest = (): void => controller.abort();
    if (signal?.aborted) {
      abortRequest();
    } else {
      signal?.addEventListener('abort', abortRequest, { once: true });
    }
    const timeout = setTimeout(abortRequest, timeoutMs);
    timeout.unref?.();
    try {
      return await this.request<T>(url, body, controller.signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortRequest);
    }
  }
}
