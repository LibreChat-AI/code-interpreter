import { SessionFilesError } from './runtime-session/files';

/**
 * Classifies failures controlled by the worker's shared deadline before the
 * remaining backend/error-specific branches run.
 */
export function workerDeadlineFailure(
    error: unknown,
    signalAborted: boolean,
    jobTimeoutMs: number,
): Error | undefined {
    if (
        error instanceof SessionFilesError &&
        error.code === 'SESSION_INPUT_ABORTED'
    ) {
        /* Input delivery has its own stable public failure. It observes the same
         * deadline, so preserve it even though the shared signal is also aborted. */
        return new Error(`${error.code}: ${error.message}`);
    }
    if (signalAborted) {
        return new Error(`Job timed out after ${jobTimeoutMs}ms`);
    }
    return undefined;
}
