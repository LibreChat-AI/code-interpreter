import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from 'bun:test';
import { spawnSync } from 'child_process';
import express from 'express';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import v2Router from './v2';
import { config } from '../config';
import {
    SESSION_INPUT_CACHE_DIR,
    SESSION_INPUT_CACHE_MAX_OBJECTS,
    inputCacheKey,
} from '../session-inputs';

/**
 * Route-level coverage for input delivery. The unit suites exercise the cache
 * itself; this exercises the WIRING — body parsing, the JSON gate's tar
 * exemption, and mount paths — which is where a live-only failure hid: the
 * probe route had no parser (there is no global one), so every ref list came
 * back "refs must be an array".
 */

let server: Server;
let baseUrl: string;
const savedSessionWorkspaceEnabled = config.session_workspace_enabled;

beforeAll(async () => {
    config.session_workspace_enabled = true;
    const app = express();
    /* Mirror index.ts: no global JSON parser, router mounted under /api/v2. */
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/v2', v2Router);
    await new Promise<void>(resolve => {
        server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    config.session_workspace_enabled = savedSessionWorkspaceEnabled;
});

afterEach(async () => {
    config.session_workspace_enabled = true;
    await fsp
        .rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true })
        .catch(() => {});
});

async function makeBatch(
    entries: Array<{ sid: string; id: string; body: string }>,
): Promise<Buffer> {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'route-batch-'));
    for (const entry of entries) {
        const key = inputCacheKey(entry.sid, entry.id);
        await fsp.writeFile(path.join(tmp, key), entry.body);
        await fsp.writeFile(
            path.join(tmp, `${key}.json`),
            JSON.stringify({ readOnly: false }),
        );
    }
    const tar = spawnSync('tar', ['-czf', '-', '-C', tmp, '.'], {
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    await fsp.rm(tmp, { recursive: true, force: true });
    return tar.stdout;
}

const probe = (refs: unknown) =>
    fetch(`${baseUrl}/api/v2/session/inputs/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs }),
    });

describe('input delivery routes', () => {
    test('disabled shared-runner targets reject input-cache routes without storing bytes', async () => {
        config.session_workspace_enabled = false;
        const push = await fetch(`${baseUrl}/api/v2/session/inputs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-gtar' },
            body: 'not-a-tar',
        });

        expect(push.status).toBe(404);
        expect((await probe([])).status).toBe(404);
        expect(
            await fsp.lstat(SESSION_INPUT_CACHE_DIR).catch(() => null),
        ).toBeNull();
    });

    test('probe parses its body and reports everything missing on a cold VM', async () => {
        const cacheKey = inputCacheKey('s1', 'f1');
        const response = await probe([{ cache_key: cacheKey }]);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            missing: [{ cache_key: cacheKey }],
        });
    });

    test('a pushed batch flips the probe answer to nothing missing', async () => {
        const push = await fetch(`${baseUrl}/api/v2/session/inputs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-gtar',
                'X-CodeAPI-Input-Expanded-Bytes': String(
                    Buffer.byteLength('bytes') +
                        Buffer.byteLength(JSON.stringify({ readOnly: false })),
                ),
            },
            body: await makeBatch([{ sid: 's1', id: 'f1', body: 'bytes' }]),
        });
        expect(push.status).toBe(200);
        expect(await push.json()).toEqual({ stored: 1 });

        const after = await probe([
            { cache_key: inputCacheKey('s1', 'f1') },
            { cache_key: inputCacheKey('s1', 'f2') },
        ]);
        /* Only the object the VM actually holds is skipped — dedupe is the VM's
         * answer, never control-plane bookkeeping. */
        expect(await after.json()).toEqual({
            missing: [{ cache_key: inputCacheKey('s1', 'f2') }],
        });
    });

    test('probe rejects a malformed ref list rather than guessing', async () => {
        expect((await probe('nope')).status).toBe(400);
        expect((await probe([{ cache_key: 'not-a-digest' }])).status).toBe(400);
        const key = inputCacheKey('s1', 'duplicate');
        expect(
            (await probe([{ cache_key: key }, { cache_key: key }])).status,
        ).toBe(400);
        expect(
            (
                await probe(
                    Array.from(
                        { length: SESSION_INPUT_CACHE_MAX_OBJECTS + 1 },
                        (_, i) => ({
                            cache_key: inputCacheKey('s1', String(i)),
                        }),
                    ),
                )
            ).status,
        ).toBe(400);
    });
});
