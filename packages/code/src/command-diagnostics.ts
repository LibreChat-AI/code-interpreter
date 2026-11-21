import {
    BRIDGE_WORKER_ID_PATTERN,
    readBridgeCommandFailure,
} from './protocol.js';
import type {
    BridgeCommandFailure,
    BridgeCommandFailureReason,
    BridgeCommandFailureStage,
} from './protocol.js';

/** A bridge settlement carries these only through `readBridgeCommandFailure`. */
export type CommandFailureStage = BridgeCommandFailureStage;
export type CommandFailureReason = BridgeCommandFailureReason;
export type CommandFailureDiagnostic = BridgeCommandFailure;

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

const MAX_ERROR_PROTOTYPE_DEPTH = 8;

/** The nearest `name` data property; an accessor ends the search unread. */
function errorName(error: object): unknown {
    let target: object | null = error;
    for (
        let depth = 0;
        target != null && depth < MAX_ERROR_PROTOTYPE_DEPTH;
        depth++
    ) {
        const descriptor = Object.getOwnPropertyDescriptor(target, 'name');
        if (descriptor != null) return descriptor.value;
        target = Object.getPrototypeOf(target) as object | null;
    }
    return undefined;
}

export function commandFailureDiagnostic(
    stage: CommandFailureStage,
    reason: CommandFailureReason,
    error?: unknown,
): CommandFailureDiagnostic {
    let code: unknown;
    let name: unknown;
    try {
        // Diagnostic extraction must not execute an exception object's getters.
        if (error != null && typeof error === 'object') {
            code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
            name = errorName(error);
        }
    } catch {
        // Even an unusual provider error/proxy cannot replace the original failure.
    }
    return (
        readBridgeCommandFailure({
            stage,
            reason,
            osCode: code,
            nodeCode: code,
            errorName: name,
        }) ?? { stage, reason }
    );
}

/** Reconstruct only allowlisted fields, even across the trusted executor IPC. */
export const readCommandFailureDiagnostic = readBridgeCommandFailure;

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
