import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Job, type TFile } from './job';
import { SessionWorkspace } from './session-workspace';

/**
 * Inline (`content`) priming must protect prior session bytes the same way
 * by-reference priming does. The by-ref path leaves an existing regular file in
 * place and lets a rename replace it, so a failed write cannot erase the
 * previous turn's state; inline priming used to unlink first and write second,
 * which could destroy a file and then fail — forcing a recycle/restore, and
 * losing warm workspace state when no checkpoint exists yet.
 */

let tmpDir: string;

afterEach(async () => {
    if (tmpDir)
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function makeJob(files: TFile[], session?: object): Job {
    return new Job({
        session_id: 'inline-prime-test',
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

const writeInline = (job: Job, file: TFile): Promise<void> =>
    (job as unknown as { writeFile(f: TFile): Promise<void> }).writeFile(file);

describe('inline priming in a session workspace', () => {
    test('replaces an existing file without unlinking it first', async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inline-prime-'));
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_inline_1',
        });
        const job = makeJob([], session);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        await fsp.writeFile(path.join(tmpDir, 'main.py'), 'print("old")\n');
        await writeInline(job, { name: 'main.py', content: 'print("new")\n' });

        expect(await fsp.readFile(path.join(tmpDir, 'main.py'), 'utf8')).toBe(
            'print("new")\n',
        );
        /* The temp file used for the atomic swap must not linger in the workspace,
         * or the output scan would surface it as a generated file. */
        const leftovers = (await fsp.readdir(tmpDir)).filter(n =>
            n.startsWith('.tmp-'),
        );
        expect(leftovers).toEqual([]);
    });

    test('a failed write leaves the previous turn bytes intact', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'inline-prime-fail-'),
        );
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_inline_2',
        });
        const job = makeJob([], session);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        const target = path.join(tmpDir, 'keep.txt');
        await fsp.writeFile(target, 'previous turn\n');

        /* Inject the failure at the write itself — the ENOSPC/EIO shape this
         * guards against. Note a read-only workspace dir does NOT reproduce it:
         * that blocks the unlink too, so the old code never got far enough to
         * destroy anything. The write has to fail while the destination is already
         * removable for the regression to show. */
        const spy = spyOn(fsp, 'writeFile').mockImplementation(async () => {
            throw Object.assign(new Error('no space left on device'), {
                code: 'ENOSPC',
            });
        });
        try {
            await expect(
                writeInline(job, {
                    name: 'keep.txt',
                    content: 'replacement\n',
                }),
            ).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }

        /* The old rm-then-write order deleted this before failing, forcing a
         * recycle/restore that loses warm state when no checkpoint exists. */
        expect(await fsp.readFile(target, 'utf8')).toBe('previous turn\n');
    });

    test('still clears a squatting symlink instead of following it', async () => {
        tmpDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'inline-prime-link-'),
        );
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_inline_3',
        });
        const job = makeJob([], session);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        const outside = path.join(tmpDir, 'outside-target.txt');
        await fsp.writeFile(outside, 'must not be clobbered\n');
        await fsp.symlink(outside, path.join(tmpDir, 'link.txt'));

        await writeInline(job, {
            name: 'link.txt',
            content: 'fresh regular file\n',
        });

        const stat = await fsp.lstat(path.join(tmpDir, 'link.txt'));
        expect(stat.isSymbolicLink()).toBe(false);
        expect(await fsp.readFile(path.join(tmpDir, 'link.txt'), 'utf8')).toBe(
            'fresh regular file\n',
        );
        /* The symlink target is untouched — writeFile never followed the link. */
        expect(await fsp.readFile(outside, 'utf8')).toBe(
            'must not be clobbered\n',
        );
    });

    test('a directory squatting the destination is still removed', async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inline-prime-dir-'));
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_inline_4',
        });
        const job = makeJob([], session);
        (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

        await fsp.mkdir(path.join(tmpDir, 'squat.txt'));
        await fsp.writeFile(
            path.join(tmpDir, 'squat.txt', 'inner.txt'),
            'inner\n',
        );

        await writeInline(job, { name: 'squat.txt', content: 'now a file\n' });

        const stat = await fsp.lstat(path.join(tmpDir, 'squat.txt'));
        expect(stat.isFile()).toBe(true);
        expect(await fsp.readFile(path.join(tmpDir, 'squat.txt'), 'utf8')).toBe(
            'now a file\n',
        );
    });
});
