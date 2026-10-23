import { BRIDGE_WORKER_ID_PATTERN } from './protocol.js';

/** Worker-local diagnostics: never add these fields to bridge settlements. */
export type CommandFailureStage =
    | 'allocation'
    | 'sandbox_startup'
    | 'programmatic_preflight'
    | 'credential_resolution'
    | 'command_wrapping'
    | 'dispatch'
    | 'executor_transport'
    | 'cleanup';

const reasons = [
    'workspace_busy',
    'capacity_exhausted',
    'allocation_failed',
    'startup_failed',
    'prerequisite_failed',
    'credential_failed',
    'wrapping_failed',
    'executor_rejected',
    'executor_unavailable',
    'executor_lost',
    'send_failed',
    'rpc_timeout',
    'cleanup_failed',
] as const;
export type CommandFailureReason = (typeof reasons)[number];

const setupReasons = {
    sandbox_startup: 'startup_failed',
    programmatic_preflight: 'prerequisite_failed',
    credential_resolution: 'credential_failed',
    command_wrapping: 'wrapping_failed',
} as const;
export type CommandSetupStage = keyof typeof setupReasons;

export function commandSetupFailureDiagnostic(
    stage: CommandSetupStage,
    error: unknown,
): CommandFailureDiagnostic {
    return commandFailureDiagnostic(stage, setupReasons[stage], error);
}
export interface CommandFailureDiagnostic {
    stage: CommandFailureStage;
    reason: CommandFailureReason;
    osCode?: string;
}
const stages = new Set<string>([
    'allocation',
    'sandbox_startup',
    'programmatic_preflight',
    'credential_resolution',
    'command_wrapping',
    'dispatch',
    'executor_transport',
    'cleanup',
]);
const osCodes = new Set([
    'ENOSPC',
    'EDQUOT',
    'EACCES',
    'EPERM',
    'ENOMEM',
    'EMFILE',
    'ENFILE',
    'EIO',
    'ENOENT',
    'EPIPE',
    'ECONNRESET',
    'ETIMEDOUT',
]);

export function commandFailureDiagnostic(
    stage: CommandFailureStage,
    reason: CommandFailureReason,
    error?: unknown,
): CommandFailureDiagnostic {
    let code: unknown;
    try {
        // Diagnostic extraction must not execute an exception object's getters.
        if (error != null && typeof error === 'object') {
            code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        }
    } catch {
        // Even an unusual provider error/proxy cannot replace the original failure.
    }
    return {
        stage,
        reason,
        ...(typeof code === 'string' && osCodes.has(code)
            ? { osCode: code }
            : {}),
    };
}

/** Reconstruct only allowlisted fields, even across the trusted executor IPC. */
export function readCommandFailureDiagnostic(
    value: unknown,
): CommandFailureDiagnostic | undefined {
    if (value == null || typeof value !== 'object') return;
    const v = value as Partial<CommandFailureDiagnostic>;
    if (!stages.has(v.stage ?? '') || !reasons.includes(v.reason!)) return;
    return commandFailureDiagnostic(v.stage!, v.reason!, { code: v.osCode });
}

export interface CommandFailureEvent extends CommandFailureDiagnostic {
    event: 'workspace_command_unavailable';
    assignmentId?: string;
    workspaceId?: string;
    workerId?: string;
    incarnationId?: string;
    operation: 'execute_command' | 'workspace_programmatic';
    mutationMayHaveCommitted: boolean;
    requiresQuarantine: boolean;
}

/** One complete JSON record, suitable for a JSON-lines log collector. */
export function commandFailureLogLine(event: CommandFailureEvent): string {
    return `${JSON.stringify(event)}\n`;
}

export function commandFailureEvent(
    diagnostic: CommandFailureDiagnostic | undefined,
    context: Omit<
        CommandFailureEvent,
        keyof CommandFailureDiagnostic | 'event'
    >,
): CommandFailureEvent {
    const id = (
        value: string | undefined,
        pattern: RegExp,
    ): string | undefined =>
        value &&
        value.length <= 128 &&
        !/[\r\n]/.test(value) &&
        pattern.test(value)
            ? value
            : undefined;
    // Assignment/incarnation IDs are opaque and may begin with '-' or '_'.
    const opaqueIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
    return {
        event: 'workspace_command_unavailable',
        ...(readCommandFailureDiagnostic(diagnostic) ??
            commandFailureDiagnostic('dispatch', 'executor_rejected')),
        assignmentId: id(context.assignmentId, opaqueIdPattern),
        workspaceId: id(context.workspaceId, BRIDGE_WORKER_ID_PATTERN),
        workerId: id(context.workerId, BRIDGE_WORKER_ID_PATTERN),
        incarnationId: id(context.incarnationId, opaqueIdPattern),
        operation: context.operation,
        mutationMayHaveCommitted: context.mutationMayHaveCommitted,
        requiresQuarantine: context.requiresQuarantine,
    };
}
