export type SandboxSafeErrorCode =
    | 'sandbox_setup_failed'
    | 'permission_denied'
    | 'workspace_missing'
    | 'mount_failed';

export interface SandboxSafeError {
    status: number;
    body: {
        error: SandboxSafeErrorCode;
        message: string;
    };
}

function errorField(
    error: unknown,
    field: 'code' | 'path' | 'message',
): string {
    if (typeof error !== 'object' || error === null || !(field in error))
        return '';
    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
}

function messageIncludes(error: unknown, pattern: RegExp): boolean {
    return pattern.test(errorField(error, 'message'));
}

function errorName(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('name' in error))
        return '';
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
}

export function classifySandboxSafeError(
    error: unknown,
): SandboxSafeError | null {
    const code = errorField(error, 'code');
    const path = errorField(error, 'path');

    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
        return {
            status: 503,
            body: {
                error: 'permission_denied',
                message: 'Sandbox setup failed: operation not permitted',
            },
        };
    }

    if (
        code === 'ENOENT' &&
        (path.startsWith('/tmp/sandbox') ||
            messageIncludes(error, /\/tmp\/sandbox/))
    ) {
        return {
            status: 503,
            body: {
                error: 'workspace_missing',
                message: 'Sandbox setup failed: workspace unavailable',
            },
        };
    }

    if (
        messageIncludes(
            error,
            /Failed to mount mandatory point|\/mnt\/data|mount/i,
        )
    ) {
        return {
            status: 503,
            body: {
                error: 'mount_failed',
                message: 'Sandbox setup failed: workspace mount failed',
            },
        };
    }

    if (errorName(error) === 'SandboxWorkspaceIsolationError') {
        return {
            status: 503,
            body: {
                error: 'sandbox_setup_failed',
                message: 'Sandbox setup failed',
            },
        };
    }

    return null;
}
