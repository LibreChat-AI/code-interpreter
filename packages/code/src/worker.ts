import { randomBytes } from 'node:crypto';

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  bridgeWorkerPath,
} from './protocol.js';
import { EndpointRuntimeSupervisor } from './runtime.js';
import { signBridgeRequest } from './identity.js';
import { isWorkspaceToolRequest, WorkspaceToolError } from './workspace.js';

import type {
  BridgeAssignment,
  BridgeLeaseResponse,
  BridgeSandboxRequest,
  BridgeSettlement,
  BridgeSettlementResponse,
  BridgeWorkerCapabilities,
  BridgeWorkerCredentialResponse,
  BridgeWorkerRegistrationResponse,
} from './protocol.js';
import type { RuntimeLease, RuntimeSupervisor } from './runtime.js';
import type { WorkspaceToolExecutor } from './workspace.js';

export interface BridgeWorkerOptions {
  codeApiUrl: string;
  token?: string;
  identity?: BridgeWorkerIdentity;
  workerId: string;
  /** @deprecated Use runtimeSupervisor for new runtime adapters. */
  sandboxEndpoint?: string;
  runtimeSupervisor?: RuntimeSupervisor;
  capabilities: BridgeWorkerCapabilities;
  workspaceTools?: WorkspaceToolExecutor;
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
  credentialRefreshTransportTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
  onIdentityChange?: (identity: BridgeWorkerIdentity) => void | Promise<void>;
  onRegistered?: (
    registration: BridgeWorkerRegistrationResponse,
  ) => void | Promise<void>;
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
const MAX_PROOF_CLOCK_SKEW_MS = 60_000;
const DEFAULT_REGISTRATION_TTL_MS = 60_000;
const DEFAULT_REGISTRATION_TRANSPORT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTROL_TRANSPORT_TIMEOUT_MS = 10_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 500;
const DEFAULT_CANCELLATION_TRANSPORT_TIMEOUT_MS = 2_000;
const MIN_REGISTRATION_HEARTBEAT_MS = 25;
const REGISTRATION_RETRY_DELAY_MS = 100;
const CREDENTIAL_REFRESH_RETRY_DELAY_MS = 100;
const SETTLEMENT_RETRY_DELAY_MS = 100;
const REJECTION_ACK_GRACE_MS = 30_000;
const MAX_SETTLEMENT_ERROR_LENGTH = 4_096;

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

function workspaceCapabilitiesMatch(
  advertised: NonNullable<BridgeWorkerCapabilities['workspaceTools']>,
  executor: NonNullable<BridgeWorkerCapabilities['workspaceTools']>,
): boolean {
  return (
    advertised.protocolVersion === executor.protocolVersion &&
    advertised.operations.length === executor.operations.length &&
    advertised.operations.every(
      (operation, index) => operation === executor.operations[index],
    ) &&
    advertised.workspaces.length === executor.workspaces.length &&
    advertised.workspaces.every(
      (workspace, index) =>
        workspace.id === executor.workspaces[index]?.id &&
        workspace.name === executor.workspaces[index]?.name &&
        workspace.operations?.length ===
          executor.workspaces[index]?.operations?.length &&
        (workspace.operations?.every(
          (operation, operationIndex) =>
            operation ===
            executor.workspaces[index]?.operations?.[operationIndex],
        ) ?? executor.workspaces[index]?.operations == null),
    )
  );
}

function registrationCompatibleCapabilities(
  capabilities: BridgeWorkerCapabilities,
): BridgeWorkerCapabilities {
  const workspaceTools = capabilities.workspaceTools;
  if (
    workspaceTools == null ||
    (workspaceTools.operations.every(
      (operation) =>
        operation === 'read_file' || operation === 'search_text',
    ) &&
      workspaceTools.workspaces.every(
        (workspace) => workspace.operations == null,
      ))
  ) {
    return capabilities;
  }
  const operations = workspaceTools.operations.filter(
    (operation) =>
      operation === 'read_file' || operation === 'search_text',
  );
  if (operations.length === 0) {
    const { workspaceTools: _workspaceTools, ...compatible } = capabilities;
    return compatible;
  }
  return {
    ...capabilities,
    workspaceTools: {
      ...workspaceTools,
      operations,
      workspaces: workspaceTools.workspaces.map(({ operations: _, ...workspace }) =>
        workspace,
      ),
    },
  };
}

function supportedWorkspaceCapabilities(
  registration: BridgeWorkerRegistrationResponse,
  capabilities: BridgeWorkerCapabilities,
): BridgeWorkerCapabilities | undefined {
  const desired = capabilities.workspaceTools;
  const supported = registration.supportedWorkspaceToolOperations;
  if (desired == null || !Array.isArray(supported)) return undefined;
  const operations = desired.operations.filter((operation) =>
    supported.includes(operation),
  );
  if (operations.length === 0) return undefined;
  const supportsEntireProtocol =
    operations.length === desired.operations.length;
  const supportsWorkspaceRestrictions =
    supportsEntireProtocol ||
    operations.some(
      (operation) => operation === 'write_file' || operation === 'edit_file',
    );
  const workspaces = supportsWorkspaceRestrictions
    ? desired.workspaces.flatMap((workspace) => {
        if (workspace.operations == null) return [workspace];
        const workspaceOperations = workspace.operations.filter((operation) =>
          operations.includes(operation),
        );
        return workspaceOperations.length === 0
          ? []
          : [{ ...workspace, operations: workspaceOperations }];
      })
    : desired.workspaces.map(({ operations: _, ...workspace }) => workspace);
  if (workspaces.length === 0) return undefined;
  return {
    ...capabilities,
    workspaceTools: {
      ...desired,
      operations,
      workspaces,
    },
  };
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
  private readonly runtimeSupervisor: RuntimeSupervisor;
  private readonly incarnationId: string;
  private readonly compatibleCapabilities: BridgeWorkerCapabilities;
  private registrationCapabilities: BridgeWorkerCapabilities;
  private registrationTtlMs = DEFAULT_REGISTRATION_TTL_MS;
  private lastRegisteredAtMs = 0;
  private serverClockOffsetMs = MAX_PROOF_CLOCK_SKEW_MS;

  constructor(private readonly options: BridgeWorkerOptions) {
    if (!options.token && !options.identity) {
      throw new BridgeProtocolError(
        'Bridge worker requires a static token or paired identity',
      );
    }
    if (options.runtimeSupervisor != null && options.sandboxEndpoint != null) {
      throw new BridgeProtocolError(
        'Bridge worker accepts either a runtime supervisor or sandbox endpoint, not both',
      );
    }
    if (options.runtimeSupervisor == null && !options.sandboxEndpoint?.trim()) {
      throw new BridgeProtocolError('Bridge worker requires a runtime supervisor');
    }
    if (
      (options.workspaceTools == null) !==
        (options.capabilities.workspaceTools == null) ||
      (options.workspaceTools != null &&
        options.capabilities.workspaceTools != null &&
        !workspaceCapabilitiesMatch(
          options.capabilities.workspaceTools,
          options.workspaceTools.capabilities,
        ))
    ) {
      throw new BridgeProtocolError(
        'Workspace tool capabilities require a matching executor',
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.codeApiUrl = normalizedBaseUrl(options.codeApiUrl);
    this.runtimeSupervisor =
      options.runtimeSupervisor ??
      new EndpointRuntimeSupervisor({
        endpoint: options.sandboxEndpoint ?? '',
        statefulWorkspace: options.capabilities.statefulWorkspace,
      });
    this.incarnationId =
      options.incarnationId ?? randomBytes(18).toString('base64url');
    this.compatibleCapabilities = registrationCompatibleCapabilities(
      options.capabilities,
    );
    this.registrationCapabilities = this.compatibleCapabilities;
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
      const register = (capabilities: BridgeWorkerCapabilities) =>
        this.request<BridgeWorkerRegistrationResponse>(
          `${this.codeApiUrl}/bridge/workers/register`,
          {
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            workerId: this.options.workerId,
            incarnationId: this.incarnationId,
            capabilities,
          },
          registrationController.signal,
        );
      try {
        registration = await register(this.registrationCapabilities);
      } catch (error) {
        if (
          !(error instanceof BridgeProtocolError) ||
          error.status !== 400 ||
          this.registrationCapabilities === this.compatibleCapabilities
        ) {
          throw error;
        }
        this.registrationCapabilities = this.compatibleCapabilities;
        registration = await register(this.registrationCapabilities);
      }
      const supportedCapabilities = supportedWorkspaceCapabilities(
        registration,
        this.options.capabilities,
      );
      if (
        supportedCapabilities?.workspaceTools != null &&
        (this.registrationCapabilities.workspaceTools == null ||
          !workspaceCapabilitiesMatch(
            this.registrationCapabilities.workspaceTools,
            supportedCapabilities.workspaceTools,
          ))
      ) {
        this.registrationCapabilities = supportedCapabilities;
        try {
          registration = await register(this.registrationCapabilities);
        } catch (error) {
          this.registrationCapabilities = this.compatibleCapabilities;
          if (signal?.aborted) throw error;
        }
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortRegistration);
    }
    if (registration.incarnationId !== this.incarnationId) {
      throw new BridgeProtocolError(
        'Code API registered a different worker incarnation',
      );
    }
    const registeredAtMs = Date.parse(registration.registeredAt);
    if (Number.isFinite(registeredAtMs)) {
      this.serverClockOffsetMs = registeredAtMs - registrationStartedAtMs;
    }
    this.registrationTtlMs = registration.leaseTtlMs;
    await this.options.onRegistered?.(registration);
    if (this.options.capabilities.requiresReadyConfirmation === true) {
      await this.confirmReady(registration, signal);
    }
    this.lastRegisteredAtMs = registrationStartedAtMs;
    return registration;
  }

  private async confirmReady(
    registration: BridgeWorkerRegistrationResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    const registrationGeneration = registration.registrationGeneration;
    if (
      !Number.isSafeInteger(registrationGeneration) ||
      (registrationGeneration ?? 0) < 1
    ) {
      throw new BridgeProtocolError(
        'Code API does not support explicit worker readiness confirmation',
      );
    }
    await this.timedRequest(
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}/ready`,
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        incarnationId: this.incarnationId,
        registrationGeneration,
      },
      Math.max(
        1,
        this.options.registrationTransportTimeoutMs ??
          DEFAULT_REGISTRATION_TRANSPORT_TIMEOUT_MS,
      ),
      signal,
    );
  }

  async resetWorkspace(
    runtimeSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (runtimeSessionId.trim().length === 0) {
      throw new BridgeProtocolError('Runtime session ID is required');
    }
    await this.runtimeSupervisor.reset(runtimeSessionId, signal);
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
      this.serverClockOffsetMs +
      (this.options.credentialRefreshWindowMs ?? CREDENTIAL_REFRESH_WINDOW_MS),
    transportTimeoutMs = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const identity = this.options.identity;
    if (identity == null) return;
    if (Date.parse(identity.expiresAt) > validThroughMs) {
      return;
    }
    const credential = await this.timedRequest<BridgeWorkerCredentialResponse>(
      `${this.codeApiUrl}${bridgeWorkerPath(this.options.workerId)}` +
        '/credentials/refresh',
      { protocolVersion: BRIDGE_PROTOCOL_VERSION },
      Math.max(
        1,
        Math.min(
          transportTimeoutMs,
          this.options.credentialRefreshTransportTimeoutMs ??
            DEFAULT_CONTROL_TRANSPORT_TIMEOUT_MS,
        ),
      ),
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
    serverClockOffsetMs: number,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    const identity = this.options.identity;
    if (identity == null) return;
    const refreshWindowMs =
      this.options.credentialRefreshWindowMs ?? CREDENTIAL_REFRESH_WINDOW_MS;
    const assignmentDeadlineMs =
      Date.parse(assignment.expiresAt) - serverClockOffsetMs;
    while (!stopSignal.aborted && Date.now() < assignmentDeadlineMs) {
      const refreshAtMs =
        Date.parse(identity.expiresAt) - serverClockOffsetMs - refreshWindowMs;
      const waitMs = Math.max(
        0,
        Math.min(refreshAtMs - Date.now(), assignmentDeadlineMs - Date.now()),
      );
      await abortableDelay(waitMs, stopSignal);
      if (stopSignal.aborted || Date.now() >= assignmentDeadlineMs) return;
      try {
        await this.refreshCredential(
          requestSignal,
          Date.now() + serverClockOffsetMs + refreshWindowMs,
        );
      } catch (error) {
        if (stopSignal.aborted) return;
        const terminal =
          error instanceof BridgeProtocolError &&
          (error.status === 401 || error.status === 403);
        const credentialRemainingMs =
          Date.parse(identity.expiresAt) -
          (Date.now() + serverClockOffsetMs);
        if (terminal || credentialRemainingMs <= 0) throw error;
        await abortableDelay(
          Math.min(
            CREDENTIAL_REFRESH_RETRY_DELAY_MS,
            Math.max(1, Math.floor(credentialRemainingMs / 2)),
          ),
          stopSignal,
        );
      }
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
    const serverClockOffsetMs =
      Number.isSafeInteger(assignment.remainingMs) &&
      (assignment.remainingMs ?? -1) >= 0
        ? Date.parse(assignment.expiresAt) -
          (Date.now() + (assignment.remainingMs ?? 0))
        : 0;
    this.serverClockOffsetMs = serverClockOffsetMs;
    const localDeadlineAtMs =
      Date.now() + this.assignmentRemainingMs(assignment);
    try {
      await this.refreshCredential(
        signal,
        Date.now() +
          serverClockOffsetMs +
          (this.options.credentialRefreshWindowMs ??
            CREDENTIAL_REFRESH_WINDOW_MS),
        Math.max(1, localDeadlineAtMs - Date.now()),
      );
    } catch (error) {
      if (!signal?.aborted) {
        await this.rejectUnexecutedAssignment(
          assignment,
          'Bridge credential refresh failed before sandbox execution',
        );
      }
      throw error;
    }
    const remainingAfterRefreshMs = localDeadlineAtMs - Date.now();
    if (remainingAfterRefreshMs <= 0) {
      await this.rejectUnexecutedAssignment(
        assignment,
        'Bridge assignment expired during credential refresh',
      );
      throw new BridgeProtocolError(
        'Bridge assignment expired during credential refresh',
      );
    }
    if (signal != null && Boolean(signal.aborted)) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('aborted', 'AbortError');
    }
    const executionController = new AbortController();
    const credentialController = new AbortController();
    const abortExecution = (): void => {
      executionController.abort();
      credentialController.abort();
    };
    signal?.addEventListener('abort', abortExecution, { once: true });
    const deadlineDelay = remainingAfterRefreshMs;
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
    let sandboxStarted = false;
    let runtimeLease: RuntimeLease | undefined;
    try {
      credentialMaintenance = this.maintainCredential(
        assignment,
        credentialController.signal,
        serverClockOffsetMs,
        signal,
      ).catch((error) => {
        credentialMaintenanceError = error;
        executionController.abort();
      });
      let payload: object = {};
      if (assignment.executionKind === 'workspace_tool') {
        if (this.options.workspaceTools == null) {
          throw new BridgeProtocolError(
            'Worker does not provide local workspace tools',
          );
        }
        if (!isWorkspaceToolRequest(assignment.request)) {
          throw new BridgeProtocolError('Invalid workspace tool request');
        }
        const workspaceRequest = assignment.request;
        const advertised = this.options.workspaceTools.capabilities;
        if (!advertised.operations.includes(workspaceRequest.operation)) {
          throw new BridgeProtocolError(
            'Workspace tool operation is not advertised',
          );
        }
        const workspace = advertised.workspaces.find(
          (candidate) => candidate.id === workspaceRequest.workspaceId,
        );
        if (workspace == null) {
          throw new BridgeProtocolError('Workspace is not advertised');
        }
        if (
          workspace.operations != null &&
          !workspace.operations.includes(workspaceRequest.operation)
        ) {
          throw new BridgeProtocolError(
            'Workspace tool operation is not advertised for workspace',
          );
        }
        payload = await this.options.workspaceTools.execute(
          workspaceRequest,
          executionController.signal,
        );
        if (executionController.signal.aborted) {
          throw (
            executionController.signal.reason ??
            new DOMException('aborted', 'AbortError')
          );
        }
        if (Date.now() >= localDeadlineAtMs) {
          throw new BridgeProtocolError(
            'Bridge assignment expired during workspace execution',
          );
        }
      } else {
        runtimeLease = await this.runtimeSupervisor.acquire(
          assignment,
          executionController.signal,
        );
        if (executionController.signal.aborted) {
          throw (
            executionController.signal.reason ??
            new DOMException('aborted', 'AbortError')
          );
        }
        const sandboxRequest = assignment.request as BridgeSandboxRequest;
        const headers = {
          ...sandboxRequest.headers,
          ...(runtimeLease.sessionId
            ? { 'X-Runtime-Session-Id': runtimeLease.sessionId }
            : {}),
        };
        const sandboxRequestBody = JSON.stringify(sandboxRequest.body);
        if (Date.now() >= localDeadlineAtMs) {
          throw new BridgeProtocolError(
            'Bridge assignment expired before sandbox execution',
          );
        }
        sandboxStarted = true;
        const response = await this.executeRuntime(
          runtimeLease,
          sandboxRequestBody,
          {
            ...headers,
            'Content-Type': 'application/json',
          },
          executionController.signal,
        );
        try {
          payload = JSON.parse(response.body) as object;
        } catch (error) {
          if (response.status >= 200 && response.status < 300) throw error;
        }
        if (response.status < 200 || response.status >= 300) {
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
      }
      cancellationController.abort();
      await cancellationWatcher;
      if (executionController.signal.aborted) {
        throw (
          executionController.signal.reason ??
          new DOMException('aborted', 'AbortError')
        );
      }
      if (Date.now() >= localDeadlineAtMs) {
        throw new BridgeProtocolError(
          'Bridge assignment expired while draining cancellation',
        );
      }
      if (credentialMaintenanceError != null) {
        throw credentialMaintenanceError;
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
        sandboxStarted &&
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
        ...(assignment.executionKind === 'workspace_tool' &&
        error instanceof WorkspaceToolError
          ? { errorCode: error.code }
          : {}),
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
    credentialController.abort();
    await credentialMaintenance;
    try {
      if (ambiguousSandboxError != null) {
        throw await this.quarantineWorkspace(
          assignment.runtimeSessionId,
          `Stateful workspace ${assignment.runtimeSessionId} was quarantined after an ambiguous sandbox execution`,
          ambiguousSandboxError,
        );
      }
      const knownCleanStatefulRejection =
        assignment.runtimeSessionId != null &&
        settlement.status === 'rejected' &&
        (!sandboxStarted || sandboxRejectedExecution);
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
      try {
        await this.releaseRuntimeLease(runtimeLease, assignment);
      } finally {
        await heartbeat;
        signal?.removeEventListener('abort', abortExecution);
      }
    }
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

  private async executeRuntime(
    lease: RuntimeLease,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    if (lease.execute != null) {
      return await lease.execute({ body, headers, signal });
    }
    if (lease.endpoint == null) {
      throw new BridgeProtocolError('Runtime lease does not provide an execution transport');
    }
    const endpoint = lease.endpoint.replace(/\/+$/, '');
    const response = await this.fetchImpl(`${endpoint}/execute`, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    return { status: response.status, body: await response.text() };
  }

  private async releaseRuntimeLease(
    lease: RuntimeLease | undefined,
    assignment: BridgeAssignment,
  ): Promise<void> {
    if (lease?.release == null) return;
    try {
      await lease.release();
    } catch (error) {
      if (assignment.runtimeSessionId == null) throw error;
      throw await this.quarantineWorkspace(
        assignment.runtimeSessionId,
        `Stateful workspace ${assignment.runtimeSessionId} could not release its runtime lease`,
        error,
      );
    }
  }

  private async quarantineWorkspace(
    runtimeSessionId: string | undefined,
    message: string,
    cause?: unknown,
  ): Promise<BridgeWorkspaceQuarantinedError> {
    if (runtimeSessionId == null) {
      return new BridgeWorkspaceQuarantinedError(message, cause);
    }
    try {
      await this.runtimeSupervisor.quarantine(runtimeSessionId, message, cause);
      return new BridgeWorkspaceQuarantinedError(message, cause);
    } catch (error) {
      return new BridgeWorkspaceQuarantinedError(
        `${message}; local runtime quarantine could not be confirmed`,
        error,
      );
    }
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
        throw await this.quarantineWorkspace(
          assignment.runtimeSessionId,
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
              throw await this.quarantineWorkspace(
                assignment.runtimeSessionId,
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
      throw await this.quarantineWorkspace(
        assignment.runtimeSessionId,
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
      executionController.signal.addEventListener('abort', abortPoll, {
        once: true,
      });
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
        if (error instanceof BridgeProtocolError && error.status === 404) {
          executionController.abort();
          return;
        }
        if (signal.aborted) return;
      } finally {
        clearTimeout(timeout);
        executionController.signal.removeEventListener('abort', abortPoll);
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
