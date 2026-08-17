import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import {
    SANDBOX_WORKSPACE_ROOT,
    reapStaleWorkspaces,
} from './workspace-isolation';
import {
    SESSION_INPUT_CACHE_DIR,
    cachedInputResponse,
    hasCachedInput,
    inputCacheKey,
    openCachedInput,
    pruneInputCache,
    resolveSessionInputCacheDir,
    storeCachedInputs,
    writeAllToHandle,
} from './session-inputs';

afterEach(async () => {
    await fsp
        .rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true })
        .catch(() => {});
});

/** Builds the digest-named batch the control plane pushes. */
async function makeBatch(
    entries: Array<{
        storageSessionId: string;
        id: string;
        body: string;
        meta?: object;
    }>,
    extras: Record<string, string> = {},
): Promise<Buffer> {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'inputs-batch-'));
    for (const entry of entries) {
        const key = inputCacheKey(entry.storageSessionId, entry.id);
        await fsp.writeFile(path.join(tmp, key), entry.body);
        if (entry.meta)
            await fsp.writeFile(
                path.join(tmp, `${key}.json`),
                JSON.stringify(entry.meta),
            );
    }
    for (const [name, body] of Object.entries(extras)) {
        await fsp.mkdir(path.dirname(path.join(tmp, name)), {
            recursive: true,
        });
        await fsp.writeFile(path.join(tmp, name), body);
    }
    const tar = spawnSync('tar', ['-czf', '-', '-C', tmp, '.'], {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    await fsp.rm(tmp, { recursive: true, force: true });
    if (tar.status !== 0) throw new Error(`fixture tar exited ${tar.status}`);
    return tar.stdout;
}

/**
 * Cross-component contract. The control plane names batch members with ITS
 * implementation of this digest and the runner looks entries up with THIS one;
 * nothing else ties them together, so both suites assert the same vector.
 *
 * They silently diverged once — one side used a literal NUL separator, the
 * other a space — and every push landed in the cache under names no lookup
 * would ever produce. Both unit suites passed (each self-consistent) and only
 * a live execution showed it, as "file not found" for files that had been
 * delivered successfully.
 */
const GOLDEN_KEY_SID_1_FILE_1 =
    'a995f1e7977466c5636419d21582e0b44420c44d2d7e2660b13aa4d4b4667d90';

describe('pushed input cache', () => {
    test('digests match the wire contract the control plane names members with', () => {
        expect(inputCacheKey('sid-1', 'file-1')).toBe(GOLDEN_KEY_SID_1_FILE_1);
    });

    test('retries short FileHandle writes until the complete slice is persisted', async () => {
        const written: Buffer[] = [];
        const handle = {
            write: async (
                buffer: Buffer,
                offset: number,
                length: number,
            ): Promise<{ bytesWritten: number; buffer: Buffer }> => {
                const bytesWritten = Math.max(1, Math.floor(length / 2));
                written.push(
                    Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
                );
                return { bytesWritten, buffer };
            },
        };
        await writeAllToHandle(
            handle as never,
            Buffer.from('complete-payload'),
        );
        expect(Buffer.concat(written).toString()).toBe('complete-payload');
        expect(written.length).toBeGreaterThan(1);
    });

    test('recovers from ENOSPC mid-write without duplicating the persisted prefix', async () => {
        const written: Buffer[] = [];
        let calls = 0;
        let recoveries = 0;
        const handle = {
            write: async (
                buffer: Buffer,
                offset: number,
                length: number,
            ): Promise<{ bytesWritten: number; buffer: Buffer }> => {
                calls += 1;
                if (calls === 2) {
                    throw Object.assign(new Error('disk full'), {
                        code: 'ENOSPC',
                    });
                }
                const bytesWritten = calls === 1 ? Math.min(4, length) : length;
                written.push(
                    Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
                );
                return { bytesWritten, buffer };
            },
        };

        await writeAllToHandle(
            handle as never,
            Buffer.from('complete-payload'),
            async () => {
                recoveries += 1;
            },
        );

        expect(recoveries).toBe(1);
        expect(Buffer.concat(written).toString()).toBe('complete-payload');
    });

    test('lives outside the workspace root so the reaper cannot eat it', async () => {
        /* Regression: the cache was originally a dot-directory INSIDE
         * SANDBOX_WORKSPACE_ROOT, where the stale-workspace reaper treats every
         * entry as a workspace — it deleted pending inputs between the push and
         * the execute they were pushed for. */
        expect(
            SESSION_INPUT_CACHE_DIR.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`),
        ).toBe(false);

        await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
        const key = inputCacheKey('s1', 'survives');
        await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), 'bytes');
        await fsp.writeFile(
            path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`),
            JSON.stringify({ readOnly: false }),
        );
        await reapStaleWorkspaces({ maxAgeMs: 0 });
        expect(await hasCachedInput('s1', 'survives')).toBe(true);
    });

    test('stores a batch and serves it as the response a fetch would have returned', async () => {
        const batch = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'f1',
                body: 'a,b\n1,2\n',
                meta: { readOnly: false },
            },
            {
                storageSessionId: 's1',
                id: 'ro',
                body: 'SKILL\n',
                meta: { readOnly: true },
            },
        ]);
        expect(await storeCachedInputs(Readable.from(batch))).toBe(2);

        expect(await hasCachedInput('s1', 'f1')).toBe(true);
        expect(await hasCachedInput('s1', 'nope')).toBe(false);

        const hit = await openCachedInput('s1', 'f1');
        expect(hit).not.toBeNull();
        const response = cachedInputResponse(hit!);
        /* No Content-Disposition: the cache is keyed by OBJECT, so the requesting
         * ref owns the destination name and priming falls back to it. */
        expect(response.headers.get('content-disposition')).toBeNull();
        expect(response.headers.get('x-read-only')).toBeNull();
        expect(await response.text()).toBe('a,b\n1,2\n');

        const readOnly = cachedInputResponse(
            (await openCachedInput('s1', 'ro'))!,
        );
        expect(readOnly.headers.get('x-read-only')).toBe('true');
    });

    test('an opened cache hit remains readable when concurrent pruning unlinks its path', async () => {
        const batch = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'held',
                body: 'held-open-bytes',
                meta: { readOnly: false },
            },
        ]);
        await storeCachedInputs(Readable.from(batch));
        const hit = await openCachedInput('s1', 'held');
        expect(hit).not.toBeNull();

        await pruneInputCache(1);
        expect(await fsp.lstat(hit!.path).catch(() => null)).toBeNull();
        expect(await cachedInputResponse(hit!).text()).toBe('held-open-bytes');
    });

    test('rejects a batch containing anything but digest-named flat members', async () => {
        /* Names are runner-computed digests, so a traversal attempt is not a path
         * problem to solve — it is simply not a legal member name. Any member that
         * is not `<64 hex>[.json]` fails the whole batch, and nothing lands. */
        const cases: Array<Record<string, string>> = [
            { 'notadigest.txt': 'nope' },
            { 'nested/deep.txt': 'nope' },
        ];
        for (const extras of cases) {
            const batch = await makeBatch(
                [
                    {
                        storageSessionId: 's1',
                        id: 'f1',
                        body: 'ok',
                        meta: { readOnly: false },
                    },
                ],
                extras,
            );
            await expect(
                storeCachedInputs(Readable.from(batch)),
            ).rejects.toThrow();
            expect(await hasCachedInput('s1', 'f1')).toBe(false);
        }
    });

    test('missing or corrupt metadata is a cache miss, never a read-only downgrade', async () => {
        const key = inputCacheKey('s1', 'f1');
        await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
        await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), 'payload');
        expect(await openCachedInput('s1', 'f1')).toBeNull();
        await fsp.writeFile(
            path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`),
            '{not json',
        );

        expect(await openCachedInput('s1', 'f1')).toBeNull();
        expect(await hasCachedInput('s1', 'f1')).toBe(false);
    });

    test('rejects incomplete or invalid object/metadata pairs before committing', async () => {
        const missingMeta = await makeBatch([
            { storageSessionId: 's1', id: 'missing', body: 'bytes' },
        ]);
        await expect(
            storeCachedInputs(Readable.from(missingMeta)),
        ).rejects.toThrow(
            'requires exactly one data file and metadata sidecar',
        );

        const invalidMeta = await makeBatch([
            { storageSessionId: 's1', id: 'invalid', body: 'bytes', meta: {} },
        ]);
        await expect(
            storeCachedInputs(Readable.from(invalidMeta)),
        ).rejects.toThrow('has invalid metadata');
        expect(await hasCachedInput('s1', 'missing')).toBe(false);
        expect(await hasCachedInput('s1', 'invalid')).toBe(false);
    });

    test('rejects an oversized metadata sidecar before reading it into memory', async () => {
        const oversized = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'oversized-meta',
                body: 'bytes',
                meta: { readOnly: false, padding: 'x'.repeat(2048) },
            },
        ]);
        await expect(
            storeCachedInputs(Readable.from(oversized)),
        ).rejects.toThrow('metadata exceeds');
        expect(await hasCachedInput('s1', 'oversized-meta')).toBe(false);
    });

    test('bounds decompressed zero padding after the tar terminator', async () => {
        const batch = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'zero-tail',
                body: '',
                meta: { readOnly: false },
            },
        ]);
        const expanded = gunzipSync(batch);
        const zeroTailBomb = gzipSync(
            Buffer.concat([expanded, Buffer.alloc(2 * 1024 * 1024)]),
        );

        await expect(
            storeCachedInputs(Readable.from(zeroTailBomb), 1024),
        ).rejects.toThrow('Decompressed session input batch exceeds');
        expect(await hasCachedInput('s1', 'zero-tail')).toBe(false);
    });

    test('rejects cache roots that could delete workspaces or broad system paths', () => {
        expect(() => resolveSessionInputCacheDir('relative/cache')).toThrow(
            'absolute path',
        );
        expect(() => resolveSessionInputCacheDir('/tmp')).toThrow(
            'dedicated directory',
        );
        expect(() => resolveSessionInputCacheDir('/var')).toThrow(
            'dedicated directory',
        );
        expect(() =>
            resolveSessionInputCacheDir(SANDBOX_WORKSPACE_ROOT),
        ).toThrow('dedicated directory');
        expect(() =>
            resolveSessionInputCacheDir(`${SANDBOX_WORKSPACE_ROOT}/inputs`),
        ).toThrow('dedicated directory');
        expect(resolveSessionInputCacheDir('/tmp/sandbox-inputs-safe')).toBe(
            '/tmp/sandbox-inputs-safe',
        );
    });

    test('eviction drops least-recently-used entries with their metadata', async () => {
        const batch = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'old',
                body: 'x'.repeat(4096),
                meta: { readOnly: false },
            },
            {
                storageSessionId: 's1',
                id: 'new',
                body: 'y'.repeat(4096),
                meta: { readOnly: false },
            },
        ]);
        await storeCachedInputs(Readable.from(batch));
        const oldKey = inputCacheKey('s1', 'old');
        /* Backdate the older entry so LRU ordering is deterministic. */
        const past = new Date(Date.now() - 60_000);
        await fsp.utimes(
            path.join(SESSION_INPUT_CACHE_DIR, oldKey),
            past,
            past,
        );
        await fsp.utimes(
            path.join(SESSION_INPUT_CACHE_DIR, `${oldKey}.json`),
            past,
            past,
        );

        await pruneInputCache(5000);

        expect(await hasCachedInput('s1', 'old')).toBe(false);
        expect(await hasCachedInput('s1', 'new')).toBe(true);
        /* The sidecar must go with its object, or metadata leaks forever. */
        expect(
            await fsp
                .lstat(path.join(SESSION_INPUT_CACHE_DIR, `${oldKey}.json`))
                .catch(() => null),
        ).toBeNull();
    });

    test('makes staging room from cold cache entries before committing a missing batch', async () => {
        const initial = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'cold',
                body: 'c'.repeat(4096),
                meta: { readOnly: false },
            },
            {
                storageSessionId: 's1',
                id: 'working',
                body: 'w'.repeat(4096),
                meta: { readOnly: false },
            },
        ]);
        await storeCachedInputs(Readable.from(initial));

        const coldKey = inputCacheKey('s1', 'cold');
        const past = new Date(Date.now() - 60_000);
        await fsp.utimes(
            path.join(SESSION_INPUT_CACHE_DIR, coldKey),
            past,
            past,
        );
        await fsp.utimes(
            path.join(SESSION_INPUT_CACHE_DIR, `${coldKey}.json`),
            past,
            past,
        );
        /* A probe hit explicitly refreshes LRU state even on relatime tmpfs. */
        expect(await hasCachedInput('s1', 'working')).toBe(true);

        const incoming = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'missing',
                body: 'm'.repeat(4096),
                meta: { readOnly: false },
            },
        ]);
        /* Only two objects fit this logical cache budget. storeCachedInputs itself
         * must evict the cold pair while staging, before the route's post-store
         * prune can run. */
        await storeCachedInputs(Readable.from(incoming), 8500);

        expect(await hasCachedInput('s1', 'cold')).toBe(false);
        expect(await hasCachedInput('s1', 'working')).toBe(true);
        expect(await hasCachedInput('s1', 'missing')).toBe(true);
    });

    test('rejects a batch whose declared expanded size does not match its members', async () => {
        const batch = await makeBatch([
            {
                storageSessionId: 's1',
                id: 'mismatch',
                body: 'bytes',
                meta: { readOnly: false },
            },
        ]);
        await expect(
            storeCachedInputs(Readable.from(batch), 1024, 1),
        ).rejects.toThrow('expanded-byte mismatch');
        expect(await hasCachedInput('s1', 'mismatch')).toBe(false);
    });
});
