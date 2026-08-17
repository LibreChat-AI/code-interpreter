import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    SESSION_INPUTS_MAX_COUNT,
    buildInputBatch,
    inputCacheKey,
    sessionFileRefs,
} from './files';

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const pathname = new URL(req.url).pathname;
            if (pathname.endsWith('/objects/fmissing')) {
                return new Response('not found', { status: 404 });
            }
            if (pathname.endsWith('/objects/fsource')) {
                return new Response('upstream failure', { status: 503 });
            }
            const readOnly = pathname.includes('/objects/ro');
            const headers: Record<string, string> = {
                'X-Original-Filename': 'server-name.txt',
            };
            if (readOnly) headers['X-Read-Only'] = 'true';
            return new Response('0123456789', { status: 200, headers });
        },
    });
});

afterAll(() => {
    server.stop(true);
});

const opts = (
    overrides: Partial<{ maxBytes: number; signal: AbortSignal }> = {},
) => ({
    timeoutMs: 5_000,
    maxBytes: 1024 * 1024,
    fileServerUrl: `http://localhost:${server.port}`,
    ...overrides,
});

const ref = (n: number | string) => ({
    id: `f${n}`,
    storage_session_id: 's1',
    name: `file-${n}.txt`,
    cache_key: inputCacheKey('s1', `f${n}`),
});

/** Lists member names of a produced batch. */
async function membersOf(archive: string): Promise<string[]> {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'batch-check-'));
    try {
        spawnSync('tar', ['-xzf', archive, '-C', tmp]);
        return (await fsp.readdir(tmp)).sort();
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}

/**
 * Cross-component contract — see the twin assertion in the runner's
 * session-inputs.test.ts. Members are named here and looked up there, so a
 * silent divergence makes every delivery land under names the runner can never
 * find. That happened (NUL vs space separator) and only live execution caught
 * it; this vector is what makes it a test failure instead.
 */
const GOLDEN_KEY_SID_1_FILE_1 =
    'a995f1e7977466c5636419d21582e0b44420c44d2d7e2660b13aa4d4b4667d90';

describe('inputCacheKey', () => {
    test('matches the digest the runner resolves cache entries with', () => {
        expect(inputCacheKey('sid-1', 'file-1')).toBe(GOLDEN_KEY_SID_1_FILE_1);
    });
});

describe('sessionFileRefs', () => {
    test('collapses the same object requested under multiple names', () => {
        /* Identity is (storage session, id): one delivery, and priming writes it
         * to each requested path. Two entries would push the same bytes twice. */
        const refs = sessionFileRefs([
            { id: 'f1', storage_session_id: 's1', name: 'a.csv' },
            { id: 'f1', storage_session_id: 's1', name: 'copy/a.csv' },
            { id: 'f2', storage_session_id: 's1', name: 'b.csv' },
            { name: 'inline.py', content: 'print(1)' },
        ]);
        expect(refs.map(r => r.id)).toEqual(['f1', 'f2']);
    });
});

describe('buildInputBatch', () => {
    test('packs digest-named members with metadata the runner can serve', async () => {
        const batch = await buildInputBatch([ref(1)], opts());
        try {
            expect(batch?.count).toBe(1);
            expect(batch?.expandedSize).toBe(
                10 + Buffer.byteLength(JSON.stringify({ readOnly: false })),
            );
            const key = inputCacheKey('s1', 'f1');
            expect(await membersOf(batch!.path)).toEqual(
                [key, `${key}.json`].sort(),
            );
        } finally {
            await batch?.cleanup();
        }
    });

    test('carries only object-level metadata (read-only), never a name', async () => {
        const batch = await buildInputBatch(
            [
                {
                    id: 'ro',
                    storage_session_id: 's1',
                    name: 'skill.md',
                    cache_key: inputCacheKey('s1', 'ro'),
                },
            ],
            opts(),
        );
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'meta-check-'));
        try {
            spawnSync('tar', ['-xzf', batch!.path, '-C', tmp]);
            const meta = JSON.parse(
                await fsp.readFile(
                    path.join(tmp, `${inputCacheKey('s1', 'ro')}.json`),
                    'utf8',
                ),
            );
            /* A name here would override every requesting ref's destination. */
            expect(meta).toEqual({ readOnly: true });
        } finally {
            await batch?.cleanup();
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    });

    test('rejects deliveries above the object-count cap before any fetch', async () => {
        const refs = Array.from(
            { length: SESSION_INPUTS_MAX_COUNT + 1 },
            (_, i) => ref(i),
        );
        await expect(buildInputBatch(refs, opts())).rejects.toMatchObject({
            code: 'SESSION_INPUT_TOO_LARGE',
        });
    });

    test('enforces a CUMULATIVE byte budget, not just per-object size', async () => {
        await expect(
            buildInputBatch([ref(1), ref(2), ref(3)], opts({ maxBytes: 25 })),
        ).rejects.toMatchObject({
            code: 'SESSION_INPUT_TOO_LARGE',
        });
    });

    test('honors an aborted signal instead of consuming disk and bandwidth', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            buildInputBatch([ref(1)], opts({ signal: controller.signal })),
        ).rejects.toMatchObject({
            code: 'SESSION_INPUT_ABORTED',
        });
    });

    test('classifies a rejected object reference as unavailable input', async () => {
        await expect(
            buildInputBatch([ref('missing')], opts()),
        ).rejects.toMatchObject({
            code: 'SESSION_INPUT_UNAVAILABLE',
        });
    });

    test('classifies file-server failures separately from caller input errors', async () => {
        await expect(
            buildInputBatch([ref('source')], opts()),
        ).rejects.toMatchObject({
            code: 'SESSION_INPUT_SOURCE_FAILED',
        });
    });
});
