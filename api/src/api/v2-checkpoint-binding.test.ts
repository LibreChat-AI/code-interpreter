import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from 'bun:test';
import express from 'express';
import * as fsp from 'fs/promises';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import {
    bindSessionWorkspace,
    resetSessionWorkspaceStateForTests,
} from '../session-workspace';
import v2Router from './v2';

/**
 * The checkpoint/restore routes bind the session straight off the header, and
 * the control plane acts on WHICH way that bind failed: a missing header is a
 * caller error, while a rejected bind means this runner is pinned to a
 * different session and must be recycled. Both used to answer with the same
 * generic 409, so a real conflict was invisible and the VM stayed in service.
 */

let server: Server;
let baseUrl: string;
let packageDir: string;
const savedSessionWorkspaceEnabled = config.session_workspace_enabled;

beforeAll(async () => {
    packageDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'checkpoint-binding-'),
    );
    const app = express();
    app.use('/api/v2', v2Router);
    await new Promise<void>(resolve => {
        server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fsp.rm(packageDir, { recursive: true, force: true });
});

afterEach(() => {
    config.session_workspace_enabled = savedSessionWorkspaceEnabled;
    resetSessionWorkspaceStateForTests();
});

const checkpoint = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/v2/session/checkpoint`, { headers });

const restore = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/v2/session/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-gtar', ...headers },
        body: 'not-a-real-archive',
    });

describe('checkpoint/restore session binding', () => {
    test('a missing header stays a plain 409 without the recycle signal', async () => {
        config.session_workspace_enabled = true;

        for (const response of [await checkpoint(), await restore()]) {
            expect(response.status).toBe(409);
            const body = (await response.json()) as {
                error?: string;
                message?: string;
            };
            expect(body.message).toBe('Missing runtime session header');
            /* A caller that simply forgot the header must NOT trigger a VM recycle. */
            expect(body.error).toBeUndefined();
        }
    });

    test('a bind rejected by a different bound session reports the recycle signal', async () => {
        config.session_workspace_enabled = true;
        expect(
            bindSessionWorkspace({ runtimeSessionId: 'rt_already_bound' }),
        ).toBeDefined();

        for (const response of [
            await checkpoint({ 'X-Runtime-Session-Id': 'rt_other' }),
            await restore({ 'X-Runtime-Session-Id': 'rt_other' }),
        ]) {
            expect(response.status).toBe(409);
            const body = (await response.json()) as {
                error?: string;
                message?: string;
            };
            /* Same code /execute returns for this condition, so an older service
             * fronting a newer runner still recycles the VM. */
            expect(body.error).toBe('session_workspace_dirty');
            expect(body.message).toBe(
                'Runner is bound to a different runtime session',
            );
        }
    });

    test('a malformed header is a 400, not a session conflict', async () => {
        config.session_workspace_enabled = true;

        const response = await checkpoint({
            'X-Runtime-Session-Id': 'not a valid id!',
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as {
            error?: string;
            message?: string;
        };
        expect(body.error).toBeUndefined();
        expect(body.message).toContain('malformed');
    });

    test('a duplicated header is a 400 rather than an unhandled throw', async () => {
        config.session_workspace_enabled = true;

        /* Node joins repeated occurrences of this header into one comma-separated
         * string rather than surfacing an array, so the value fails the id pattern
         * instead of the appears-once check. Either way it must be a caller error,
         * never an unhandled throw or a session-conflict signal. */
        const response = await fetch(`${baseUrl}/api/v2/session/checkpoint`, {
            headers: [
                ['X-Runtime-Session-Id', 'rt_one'],
                ['X-Runtime-Session-Id', 'rt_two'],
            ] as unknown as HeadersInit,
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as {
            error?: string;
            message?: string;
        };
        expect(body.error).toBeUndefined();
        expect(body.message).toMatch(/malformed|exactly once/);
    });

    test('a matching header binds and proceeds past the gate', async () => {
        config.session_workspace_enabled = true;
        expect(
            bindSessionWorkspace({ runtimeSessionId: 'rt_same' }),
        ).toBeDefined();

        const response = await checkpoint({
            'X-Runtime-Session-Id': 'rt_same',
        });
        /* Whatever the handler then does, it must not be rejected by the gate. */
        expect(response.status).not.toBe(409);
        expect(response.status).not.toBe(400);
    });
});
