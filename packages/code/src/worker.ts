import { randomBytes } from 'node:crypto';

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  bridgeWorkerPath,
} from './protocol.js';

import type {
  BridgeAssignment,
  BridgeLeaseResponse,
  BridgeSettlement,
  BridgeSettlementResponse,
  BridgeWorkerCapabilities,
  BridgeWorkerRegistrationResponse,
} from './protocol.js';

export interface BridgeWorkerOptions {
  codeApiUrl: string;
  token: string;
  workerId: string;
  sandboxEndpoint: string;
  capabilities: BridgeWorkerCapabilities;
  leaseWaitMs?: number;
  leaseTransportGraceMs?: number;
  reconnectDelayMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
  incarnationId?: string;
}

const DEFAULT_LEASE_WAIT_MS = 25_000;
const MAX_LEASE_WAIT_MS = 30_000;
const DEFAULT_LEASE_TRANSPORT_GRACE_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_REGISTRATION_TTL_MS = 60_000;
const MIN_REGISTRATION_HEARTBEAT_MS = 25;
const SETTLEMENT_RETRY_DELAY_MS = 100;
const RUNTIME_SESSION_PLACEHOLDER = '{runtimeSessionId}';

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(value: object): string | undefined {
  if ('error' in value && typeof value.error === 'string') return value.error;
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

  constructor(private readonly options: BridgeWorkerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.codeApiUrl = normalizedBaseUrl(options.codeApiUrl);
    this.sandboxEndpoint = normalizedBaseUrl(options.sandboxEndpoint);
    this.incarnationId =
      options.incarnationId ?? randomBytes(18).toString('base64url');
  }

  async register(
    signal?: AbortSignal,
  ): Promise<BridgeWorkerRegistrationResponse> {
    const registration = await this.request<BridgeWorkerRegistrationResponse>(
      `${this.codeApiUrl}/bridge/workers/register`,
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: this.options.workerId,
        incarnationId: this.incarnationId,
        capabilities: this.options.capabilities,
      },
      signal,
    );
    if (registration.incarnationId !== this.incarnationId) {
      throw new BridgeProtocolError(
        'Code API registered a different worker incarnation',
      );
    }
    this.registrationTtlMs = registration.leaseTtlMs;
    return registration;
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
    return response.assignment;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.register(signal);
        const assignment = await this.lease(signal);
        if (!assignment) continue;
        await this.executeAndSettle(assignment, signal);
      } catch (error) {
        if (error instanceof BridgeWorkspaceQuarantinedError) {
          throw error;
        }
        if (signal?.aborted) return;
        if (
          error instanceof BridgeProtocolError &&
          (error.status === 401 || error.status === 403 || error.status === 409)
        ) {
          throw error;
        }
        this.options.onError?.(error);
        const delay =
          this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async executeAndSettle(
    assignment: BridgeAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    const executionController = new AbortController();
    const abortExecution = (): void => executionController.abort();
    signal?.addEventListener('abort', abortExecution, { once: true });
    const deadlineDelay = Math.max(
      0,
      Date.parse(assignment.expiresAt) - Date.now(),
    );
    const deadlineTimer = setTimeout(
      () => executionController.abort(),
      deadlineDelay,
    );
    const heartbeatController = new AbortController();
    let heartbeatError: unknown;
    const heartbeat = this.maintainRegistration(
      heartbeatController.signal,
      executionController,
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
    let settlement: BridgeSettlement;
    let ambiguousSandboxError: unknown;
    let sandboxRejectedExecution = false;
    try {
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
      const payload = (await response.json()) as object;
      if (heartbeatError != null) throw heartbeatError;
      if (!response.ok) {
        sandboxRejectedExecution =
          errorMessage(payload) !== 'session_workspace_dirty';
        throw new BridgeProtocolError(
          errorMessage(payload) ??
            `Sandbox rejected execution with HTTP ${response.status}`,
          response.status,
        );
      }
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
          error instanceof Error ? error.message : 'Sandbox execution failed',
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
      await this.settleWithRetry(assignment, settlement, signal);
    } finally {
      heartbeatController.abort();
      await heartbeat;
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

  private async maintainRegistration(
    signal: AbortSignal,
    executionController: AbortController,
  ): Promise<void> {
    while (!signal.aborted && !executionController.signal.aborted) {
      await this.delay(
        Math.max(
          MIN_REGISTRATION_HEARTBEAT_MS,
          Math.floor(this.registrationTtlMs / 2),
        ),
        signal,
      );
      if (signal.aborted || executionController.signal.aborted) return;
      await this.register(signal);
    }
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
    signal?: AbortSignal,
  ): Promise<void> {
    const deadlineAtMs = Date.parse(assignment.expiresAt);
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
    if (assignment.runtimeSessionId != null) {
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
      await this.delay(500, signal);
      if (signal.aborted || executionController.signal.aborted) return;
      try {
        const response = await this.request<{ cancelled: boolean }>(
          this.assignmentUrl(assignment, 'cancellation'),
          {
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            incarnationId: this.incarnationId,
          },
          signal,
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
      }
    }
  }

  private async request<T>(
    url: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as object;
    if (!response.ok) {
      throw new BridgeProtocolError(
        errorMessage(payload) ??
          `Bridge request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return payload as T;
  }
}
