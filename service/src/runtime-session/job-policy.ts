import type { RuntimeSessionExemption, RuntimeSessionMode } from '../types';

export const PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION: RuntimeSessionExemption =
    'programmatic';

export type RuntimeSessionJobDecision = {
    runtimeSessionId?: string;
    runtimeSessionMode: RuntimeSessionMode;
};

type SandboxBackendName = 'http' | 'lambda-microvm';

function isRuntimeSessionMode(value: unknown): value is RuntimeSessionMode {
    return value === 'stateless' || value === 'affinity' || value === 'strict';
}

/**
 * Resolve the producer-owned session decision a worker passes to its backend.
 *
 * The worker's local mode is only a capability boundary: affinity and strict
 * workers can both honor the same stateful backend contract, while a stateless
 * worker may not silently run a queued stateful job on a one-shot VM.
 *
 * Jobs created before runtimeSessionMode crossed the queue boundary are
 * unambiguous: an id means stateful affinity, while no id means stateless.
 * A legitimate strict producer never queued an ordinary no-id job because the
 * request router rejected it first.
 */
export function resolveRuntimeSessionForJob(args: {
    workerMode: RuntimeSessionMode;
    workerBackend: SandboxBackendName;
    runtimeSessionMode?: unknown;
    runtimeSessionId?: unknown;
    runtimeSessionExemption?: RuntimeSessionExemption;
    isSynthetic: boolean;
}): RuntimeSessionJobDecision {
    if (
        args.isSynthetic ||
        args.runtimeSessionExemption === PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION
    ) {
        return { runtimeSessionMode: 'stateless' };
    }

    if (
        args.runtimeSessionId !== undefined &&
        (typeof args.runtimeSessionId !== 'string' ||
            args.runtimeSessionId.length === 0)
    ) {
        throw new Error('queued runtimeSessionId must be a non-empty string');
    }
    const runtimeSessionId = args.runtimeSessionId;

    let runtimeSessionMode: RuntimeSessionMode;
    if (args.runtimeSessionMode === undefined) {
        runtimeSessionMode =
            runtimeSessionId === undefined ? 'stateless' : 'affinity';
    } else if (isRuntimeSessionMode(args.runtimeSessionMode)) {
        runtimeSessionMode = args.runtimeSessionMode;
    } else {
        throw new Error(
            'queued runtimeSessionMode must be one of: stateless, affinity, strict',
        );
    }

    if (runtimeSessionMode === 'stateless') {
        if (runtimeSessionId !== undefined) {
            throw new Error(
                'stateless queued job must not carry a runtimeSessionId',
            );
        }
        return { runtimeSessionMode };
    }

    if (runtimeSessionId === undefined) {
        throw new Error(
            `${runtimeSessionMode} queued job requires a runtimeSessionId`,
        );
    }
    if (
        args.workerMode === 'stateless' ||
        args.workerBackend !== 'lambda-microvm'
    ) {
        throw new Error(
            `${args.workerBackend}/${args.workerMode} worker cannot honor queued ` +
                `${runtimeSessionMode} runtime session`,
        );
    }

    return {
        runtimeSessionId,
        runtimeSessionMode,
    };
}
