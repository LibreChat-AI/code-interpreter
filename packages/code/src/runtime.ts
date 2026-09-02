import type { BridgeAssignment } from './protocol.js';

export const RUNTIME_SESSION_PLACEHOLDER = '{runtimeSessionId}';

export interface RuntimeLease {
  endpoint: string;
  sessionId?: string;
  release?(): Promise<void>;
}

export interface RuntimeSupervisor {
  acquire(assignment: BridgeAssignment, signal?: AbortSignal): Promise<RuntimeLease>;
  reset(runtimeSessionId: string, signal?: AbortSignal): Promise<void>;
  quarantine(runtimeSessionId: string, reason: string, cause?: unknown): Promise<void>;
}

export interface EndpointRuntimeSupervisorOptions {
  endpoint: string;
  statefulWorkspace: boolean;
}

function normalizedEndpoint(value: string): string {
  return value.replace(/\/+$/, '');
}

function assignmentSessionId(assignment: BridgeAssignment): string | undefined {
  if (assignment.runtimeSessionId != null) return assignment.runtimeSessionId;
  if (assignment.assignmentId.length === 0) return undefined;
  return `assignment-${assignment.assignmentId}`;
}

/**
 * Compatibility adapter for an already-running loopback sandbox supervisor.
 * New runtime adapters own provisioning and return the same lease shape.
 */
export class EndpointRuntimeSupervisor implements RuntimeSupervisor {
  private readonly endpoint: string;

  constructor(private readonly options: EndpointRuntimeSupervisorOptions) {
    this.endpoint = normalizedEndpoint(options.endpoint);
    if (this.endpoint.length === 0) {
      throw new Error('Runtime supervisor endpoint is required');
    }
  }

  async acquire(assignment: BridgeAssignment): Promise<RuntimeLease> {
    const sessionId = assignmentSessionId(assignment);
    if (assignment.runtimeSessionId != null) {
      if (!this.options.statefulWorkspace) {
        throw new Error('Stateful assignments require a stateful runtime supervisor');
      }
      if (!this.endpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
        throw new Error(
          'Stateful assignments require a runtime supervisor endpoint containing {runtimeSessionId}',
        );
      }
    }
    if (sessionId == null || !this.endpoint.includes(RUNTIME_SESSION_PLACEHOLDER)) {
      return { endpoint: this.endpoint };
    }
    return {
      endpoint: this.endpoint.replace(
        RUNTIME_SESSION_PLACEHOLDER,
        encodeURIComponent(sessionId),
      ),
      sessionId,
    };
  }

  async reset(_runtimeSessionId: string): Promise<void> {}

  async quarantine(runtimeSessionId: string, _reason: string, _cause?: unknown): Promise<void> {
    await this.reset(runtimeSessionId);
  }
}
