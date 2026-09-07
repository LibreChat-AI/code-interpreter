import { createHash } from 'node:crypto';

import { BRIDGE_PROTOCOL_VERSION, isWorkspaceToolResult } from './protocol.js';
import { WorkspaceToolError } from './workspace.js';

import type {
  BridgeAssignment,
  WorkspaceExecuteCommandRequest,
  WorkspaceExecuteCommandResult,
} from './protocol.js';
import type { RuntimeSupervisor } from './runtime.js';
import type { WorkspaceCommandSandbox } from './workspace.js';

const RESPONSE_KEYS = new Set([
  'exitCode',
  'signal',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
]);

export interface RuntimeWorkspaceCommandSandboxOptions {
  runtimeSupervisor: RuntimeSupervisor;
  workerId: string;
  incarnationId: string;
}

function runtimeSessionId(workerId: string, workspaceId: string): string {
  return `workspace-${createHash('sha256')
    .update(`${workerId}\0${workspaceId}`)
    .digest('hex')
    .slice(0, 40)}`;
}

function commandAssignment(
  options: RuntimeWorkspaceCommandSandboxOptions,
  request: WorkspaceExecuteCommandRequest,
  sessionId: string,
): BridgeAssignment {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    assignmentId: `workspace-command-${createHash('sha256')
      .update(request.command)
      .digest('hex')
      .slice(0, 24)}`,
    workerId: options.workerId,
    incarnationId: options.incarnationId,
    generation: 1,
    leaseToken: 'local-workspace-command',
    expiresAt: new Date(Date.now() + (request.timeoutMs ?? 30_000)).toISOString(),
    runtimeSessionId: sessionId,
    executionKind: 'workspace_tool',
    request,
  };
}

function parseResponse(
  request: WorkspaceExecuteCommandRequest,
  value: unknown,
): WorkspaceExecuteCommandResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid sandbox response');
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !RESPONSE_KEYS.has(key))) {
    throw new Error('invalid sandbox response');
  }
  const candidate = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'execute_command',
    workspaceId: request.workspaceId,
    exitCode: result.exitCode as number | null,
    ...(result.signal !== undefined ? { signal: result.signal as string } : {}),
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    truncated: result.truncated as boolean,
    timedOut: result.timedOut as boolean,
  };
  if (!isWorkspaceToolResult(request, candidate)) {
    throw new Error('invalid sandbox response');
  }
  return candidate;
}

/** Runs workspace commands only through a stateful sandbox runner route. */
export class RuntimeWorkspaceCommandSandbox implements WorkspaceCommandSandbox {
  readonly mutationFailuresAreAtomic = true as const;

  constructor(private readonly options: RuntimeWorkspaceCommandSandboxOptions) {}

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    const sessionId = runtimeSessionId(this.options.workerId, request.workspaceId);
    try {
      const lease = await this.options.runtimeSupervisor.acquire(
        commandAssignment(this.options, request, sessionId),
        signal,
      );
      if (!lease.execute || lease.sessionId !== sessionId) {
        throw new Error('runtime does not provide isolated command execution');
      }
      const response = await lease.execute({
        path: '/api/v2/workspace/execute',
        body: JSON.stringify({
          command: request.command,
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.maxOutputBytes !== undefined
            ? { maxOutputBytes: request.maxOutputBytes }
            : {}),
        }),
        headers: {
          'Content-Type': 'application/json',
          'X-Runtime-Session-Id': sessionId,
        },
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        if (response.status >= 400 && response.status < 500) {
          throw new WorkspaceToolError(
            'Sandboxed command request was rejected',
            response.status === 400 ? 'INVALID_REQUEST' : 'COMMAND_UNAVAILABLE',
          );
        }
        throw new Error(`sandbox rejected command with HTTP ${response.status}`);
      }
      return parseResponse(request, JSON.parse(response.body) as unknown);
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      await this.options.runtimeSupervisor
        .quarantine(sessionId, 'Sandboxed workspace command failed', error)
        .catch(() => undefined);
      throw new WorkspaceToolError(
        'Sandboxed command execution unavailable',
        'COMMAND_UNAVAILABLE',
        true,
      );
    }
  }
}
