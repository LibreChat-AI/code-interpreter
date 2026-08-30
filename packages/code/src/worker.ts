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
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectRandom?: () => number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
  onIdentityChange?: (identity: BridgeWorkerIdentity) => void | Promise<void>;
  incarnationId?: string;
  credentialRefreshWindowMs?: number;
}

export interface BridgeWorkerIdentity {
  privateKey: string;
  credential: string;
  expiresAt: string;
}

const DEFAULT_LEASE_WAIT_MS = 25_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const CREDENTIAL_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_REGISTRATION_TTL_MS = 60_000;
const MIN_REGISTRATION_HEARTBEAT_MS = 25;
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

export class BridgeWorker {
  private readonly fetchImpl: typeof fetch;
  private readonly codeApiUrl: string;
  private readonly sandboxEndpoint: string;
  private readonly incarnationId: string;
  private registrationTtlMs = DEFAULT_REGISTRATION_TTL_MS;

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
    const response = await this.request<BridgeLeaseResponse>(
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}/lease`,
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        waitMs: this.options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS,
        incarnationId: this.incarnationId,
      },
      signal,
    );
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
      (this.options.credentialRefreshWindowMs ??
        CREDENTIAL_REFRESH_WINDOW_MS),
  ): Promise<void> {
    const identity = this.options.identity;
    if (identity == null) return;
    if (Date.parse(identity.expiresAt) > validThroughMs) {
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
      this.options.credentialRefreshWindowMs ??
      CREDENTIAL_REFRESH_WINDOW_MS;
    const assignmentDeadlineMs = Date.parse(assignment.expiresAt);
    while (!stopSignal.aborted && Date.now() < assignmentDeadlineMs) {
      const refreshAtMs = Date.parse(identity.expiresAt) - refreshWindowMs;
      const waitMs = Math.max(
        0,
        Math.min(refreshAtMs - Date.now(), assignmentDeadlineMs - Date.now()),
      );
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          stopSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (stopSignal.aborted || Date.now() >= assignmentDeadlineMs) return;
      /* Sandbox completion stops the maintenance loop, but it must not abort a
       * refresh already accepted by the server. Only cancellation of the
       * whole worker operation may cancel that request. */
      await this.refreshCredential(requestSignal);
    }
  }

  async executeAndSettle(
    assignment: BridgeAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.refreshCredential(
      signal,
      Date.parse(assignment.expiresAt) + CREDENTIAL_REFRESH_WINDOW_MS,
    );
    const executionController = new AbortController();
    const credentialController = new AbortController();
    const abortExecution = (): void => {
      executionController.abort();
      credentialController.abort();
    };
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
    let credentialMaintenanceError: unknown;
    let credentialMaintenance: Promise<void> | undefined;
    let settlement: BridgeSettlement;
    try {
      await this.refreshCredential(signal);
      credentialMaintenance = this.maintainCredential(
        assignment,
        credentialController.signal,
        signal,
      ).catch((error) => {
        credentialMaintenanceError = error;
        executionController.abort();
      });
      const headers = {
        ...assignment.request.headers,
        ...(assignment.runtimeSessionId
          ? { 'X-Runtime-Session-Id': assignment.runtimeSessionId }
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
      if (credentialMaintenanceError != null) {
        throw credentialMaintenanceError;
      }
      if (!response.ok) {
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
    heartbeatController.abort();
    await heartbeat;
    credentialController.abort();
    await credentialMaintenance;
    cancellationController.abort();
    await cancellationWatcher;
    signal?.removeEventListener('abort', abortExecution);
    await this.refreshCredential(signal);
    await this.request<BridgeSettlementResponse>(
      this.assignmentUrl(assignment, 'settle'),
      settlement,
      signal,
    );
  }

  private sandboxEndpointFor(assignment: BridgeAssignment): string {
    if (assignment.runtimeSessionId == null) return this.sandboxEndpoint;
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
      await abortableDelay(
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

  private assignmentUrl(assignment: BridgeAssignment, action: string): string {
    return (
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}` +
      `/assignments/${encodeURIComponent(assignment.assignmentId)}/${action}`
    );
  }

  private async watchCancellation(
    assignment: BridgeAssignment,
    executionController: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !executionController.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
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
    const payload = (await response.json()) as object;
    if (!response.ok) {
      throw new BridgeProtocolError(
        errorMessage(payload) ??
          `Bridge request failed with HTTP ${response.status}`,
        response.status,
        'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : undefined,
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
}
