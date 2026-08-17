import { describe, expect, test } from 'bun:test';
import { classifySandboxSafeError } from './safe-error';

describe('classifySandboxSafeError', () => {
    test('maps permission failures to a safe sandbox setup response', () => {
        const err = Object.assign(
            new Error("EPERM: operation not permitted, chown '/tmp/sandbox'"),
            {
                code: 'EPERM',
                path: '/tmp/sandbox',
            },
        );

        expect(classifySandboxSafeError(err)).toEqual({
            status: 503,
            body: {
                error: 'permission_denied',
                message: 'Sandbox setup failed: operation not permitted',
            },
        });
    });

    test('maps missing workspace failures without leaking the workspace path', () => {
        const err = Object.assign(
            new Error(
                "ENOENT: no such file or directory, scandir '/tmp/sandbox/ws_secret'",
            ),
            {
                code: 'ENOENT',
                path: '/tmp/sandbox/ws_secret',
            },
        );

        expect(classifySandboxSafeError(err)).toEqual({
            status: 503,
            body: {
                error: 'workspace_missing',
                message: 'Sandbox setup failed: workspace unavailable',
            },
        });
    });

    test('maps mount setup failures without returning nsjail internals', () => {
        const err = new Error("Failed to mount mandatory point: '/mnt/data'");

        expect(classifySandboxSafeError(err)).toEqual({
            status: 503,
            body: {
                error: 'mount_failed',
                message: 'Sandbox setup failed: workspace mount failed',
            },
        });
    });

    test('maps workspace isolation guard errors to a generic setup response', () => {
        const err = Object.assign(
            new Error('specific internal guard failure'),
            {
                name: 'SandboxWorkspaceIsolationError',
            },
        );

        expect(classifySandboxSafeError(err)).toEqual({
            status: 503,
            body: {
                error: 'sandbox_setup_failed',
                message: 'Sandbox setup failed',
            },
        });
    });
});
