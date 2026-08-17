import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Job, type TFile } from './job';
import { SESSION_INPUT_CACHE_DIR, inputCacheKey } from './session-inputs';
import { SessionWorkspace } from './session-workspace';
import { fallbackSandboxIdentity } from './workspace-isolation';

/**
 * The seam that makes the redesign work: a pushed cache entry must prime
 * exactly as a file-server fetch would. Unit tests cover the cache, and route
 * tests cover the wiring — this covers the join, which is where a live-only
 * failure hid.
 */

let tmpDir: string;

afterEach(async () => {
    await fsp
        .rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true })
        .catch(() => {});
    if (tmpDir)
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function seedCache(
    sid: string,
    id: string,
    body: string,
    meta: object,
): Promise<void> {
    await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
    const key = inputCacheKey(sid, id);
    await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), body);
    await fsp.writeFile(
        path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`),
        JSON.stringify(meta),
    );
}

function makeJob(files: TFile[], session?: object): Job {
    return new Job({
        session_id: 'prime-cache-test',
        runtime: {
            language: 'bash',
            version: '5.0.0',
            aliases: [],
            runtime: 'bash',
        } as never,
        args: [],
        stdin: '',
        files,
        timeouts: { run: 5000, compile: 5000 },
        cpu_times: { run: 5000, compile: 5000 },
        memory_limits: { run: 128 * 1024 * 1024, compile: 128 * 1024 * 1024 },
        session,
    } as never);
}

describe('priming from the pushed input cache', () => {
    test('writes the cached bytes under the requested name without any HTTP fetch', async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prime-cache-'));
        await seedCache('s1', 'f1', 'a,b\n1,2\n', { readOnly: false });

        const file: TFile = {
            id: 'f1',
            storage_session_id: 's1',
            name: 'data.csv',
        };
        const job = makeJob([file]);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        /* A fetch would fail here: no file server is configured in tests, so a
         * successful write proves the bytes came from the cache. */
        const written = await job.downloadAndWriteFile(file);
        expect(written).toBe('data.csv');
        expect(await fsp.readFile(path.join(tmpDir, 'data.csv'), 'utf8')).toBe(
            'a,b\n1,2\n',
        );
    });

    test('honors the cached read-only bit at the requested destination', async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prime-cache-ro-'));
        await seedCache('s1', 'ro', 'SKILL\n', { readOnly: true });

        const file: TFile = {
            id: 'ro',
            storage_session_id: 's1',
            name: 'requested.md',
        };
        const job = makeJob([file]);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        const written = await job.downloadAndWriteFile(file);
        expect(written).toBe('requested.md');
        const stat = await fsp.lstat(path.join(tmpDir, 'requested.md'));
        expect(stat.mode & 0o777).toBe(0o444);
    });

    test('one cached object serves several destinations in the same execute', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-multi-'),
        );
        await seedCache('s1', 'shared', 'shared bytes\n', { readOnly: false });

        /* Live regression: a per-OBJECT cached name made the second ref resolve to
         * the first ref's path — which overwrote a file the sandbox had edited.
         * The cache is keyed by object, so destinations belong to the refs. */
        const job = makeJob([]);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;
        for (const name of ['first.txt', 'nested/second.txt']) {
            const written = await job.downloadAndWriteFile({
                id: 'shared',
                storage_session_id: 's1',
                name,
            });
            expect(written).toBe(name);
        }
        expect(await fsp.readFile(path.join(tmpDir, 'first.txt'), 'utf8')).toBe(
            'shared bytes\n',
        );
        expect(
            await fsp.readFile(path.join(tmpDir, 'nested/second.txt'), 'utf8'),
        ).toBe('shared bytes\n');
    });

    test('stable cache identity preserves a modified session input across fresh grant handles', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-stable-'),
        );
        await fsp.writeFile(
            path.join(tmpDir, 'data.csv'),
            'sandbox-modified\n',
        );
        const stable = inputCacheKey('raw-session', 'raw-object');
        const session = {
            primedInputId: () => stable,
            primedHash: () => 'original-upload-hash',
            isPrimedReadOnly: () => false,
        };
        const job = makeJob([], session);
        const internals = job as unknown as {
            submissionDir: string;
            reusePrimedInput(file: TFile): Promise<boolean>;
            inputFileHashes: Map<
                string,
                {
                    originalId?: string;
                    originalSessionId?: string;
                    hash: string;
                }
            >;
        };
        internals.submissionDir = tmpDir;

        const reused = await internals.reusePrimedInput({
            id: 'second-grant-object-handle',
            storage_session_id: 'second-grant-session-handle',
            input_cache_key: stable,
            name: 'data.csv',
        });

        expect(reused).toBe(true);
        expect(await fsp.readFile(path.join(tmpDir, 'data.csv'), 'utf8')).toBe(
            'sandbox-modified\n',
        );
        expect(internals.inputFileHashes.get('data.csv')).toMatchObject({
            originalId: 'second-grant-object-handle',
            originalSessionId: 'second-grant-session-handle',
            hash: 'original-upload-hash',
        });
    });

    test('same-session re-prime refuses a symlinked ancestor without touching its target', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-ancestor-link-'),
        );
        const outsideDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-outside-'),
        );
        const outsideTarget = path.join(outsideDir, 'input.txt');
        await fsp.writeFile(outsideTarget, 'outside-original\n');
        await fsp.symlink(outsideDir, path.join(tmpDir, 'nested'));
        await seedCache('s1', 'f1', 'delivered\n', { readOnly: false });

        const file: TFile = {
            id: 'f1',
            storage_session_id: 's1',
            name: 'nested/input.txt',
        };
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_symlink_ancestor',
        });
        session.markPrimed(file.name, inputCacheKey('s1', 'f1'));
        const job = makeJob([file], session);
        const primeInputFile = (
            job as unknown as {
                primeInputFile(
                    input: TFile,
                    context: {
                        submissionDir: string;
                        identity: ReturnType<typeof fallbackSandboxIdentity>;
                    },
                ): Promise<void>;
            }
        ).primeInputFile.bind(job);

        try {
            await expect(
                primeInputFile(file, {
                    submissionDir: tmpDir,
                    identity: fallbackSandboxIdentity(),
                }),
            ).rejects.toThrow('symlinked workspace path');
            expect(await fsp.readFile(outsideTarget, 'utf8')).toBe(
                'outside-original\n',
            );
        } finally {
            await fsp.rm(outsideDir, { recursive: true, force: true });
        }
    });

    test('same-session re-prime replaces a direct symlink instead of following it', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-target-link-'),
        );
        const outsideDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-cache-outside-'),
        );
        const outsideTarget = path.join(outsideDir, 'outside.txt');
        const destination = path.join(tmpDir, 'input.txt');
        await fsp.writeFile(outsideTarget, 'outside-original\n');
        await fsp.symlink(outsideTarget, destination);
        await seedCache('s1', 'f1', 'delivered\n', { readOnly: false });

        const file: TFile = {
            id: 'f1',
            storage_session_id: 's1',
            name: 'input.txt',
        };
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_symlink_target',
        });
        session.markPrimed(file.name, inputCacheKey('s1', 'f1'));
        const job = makeJob([file], session);
        const primeInputFile = (
            job as unknown as {
                primeInputFile(
                    input: TFile,
                    context: {
                        submissionDir: string;
                        identity: ReturnType<typeof fallbackSandboxIdentity>;
                    },
                ): Promise<void>;
            }
        ).primeInputFile.bind(job);

        try {
            await primeInputFile(file, {
                submissionDir: tmpDir,
                identity: fallbackSandboxIdentity(),
            });

            expect((await fsp.lstat(destination)).isFile()).toBe(true);
            expect(await fsp.readFile(destination, 'utf8')).toBe('delivered\n');
            expect(await fsp.readFile(outsideTarget, 'utf8')).toBe(
                'outside-original\n',
            );
        } finally {
            await fsp.rm(outsideDir, { recursive: true, force: true });
        }
    });
});
