import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import {
    Job,
    SessionWorkspaceDirtyError,
    ValidationError,
    type TFile,
} from './job';
import type { Runtime } from './runtime';
import type { SessionWorkspace } from './session-workspace';
import {
    sandboxJobUidPool,
    type SandboxJobIdentity,
    type SandboxWorkspaceLease,
} from './workspace-isolation';
import { config } from './config';

interface CleanupInternals {
    jobIdentity?: SandboxJobIdentity;
}

function makeRuntime(): Runtime {
    return {
        language: 'bash',
        version: new semver.SemVer('5.2.0'),
        aliases: [],
        pkgdir: '/tmp',
        compiled: false,
        env_vars: {},
        timeouts: { compile: 5000, run: 5000 },
        cpu_times: { compile: 5000, run: 5000 },
        memory_limits: { compile: 100_000_000, run: 100_000_000 },
        max_process_count: 100,
        max_open_files: 100,
        max_file_size: 10_000_000,
        output_max_size: 1_000_000,
    };
}

function makeJob(): Job {
    return new Job({
        session_id: 'cleanup-test',
        runtime: makeRuntime(),
        files: [],
        args: [],
        stdin: '',
        timeouts: { compile: 5000, run: 5000 },
        cpu_times: { compile: 5000, run: 5000 },
        memory_limits: { compile: 100_000_000, run: 100_000_000 },
    });
}

function asCleanupInternals(job: Job): CleanupInternals {
    return job as unknown as CleanupInternals;
}

describe('Job cleanup', () => {
    test('releases a UID slot when prime fails before a workspace lease is created', async () => {
        const availableBefore = sandboxJobUidPool.availableCount();
        const activeBefore = sandboxJobUidPool.activeCount();
        const identity = sandboxJobUidPool.acquire();
        expect(identity).not.toBeNull();
        expect(sandboxJobUidPool.availableCount()).toBe(availableBefore - 1);
        expect(sandboxJobUidPool.activeCount()).toBe(activeBefore + 1);

        const job = makeJob();
        asCleanupInternals(job).jobIdentity = identity!;
        await job.cleanup();

        expect(sandboxJobUidPool.availableCount()).toBe(availableBefore);
        expect(sandboxJobUidPool.activeCount()).toBe(activeBefore);
    });

    test('prime waits for every sibling operation before exposing a session failure', async () => {
        const workspace = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-settlement-'),
        );
        const identity: SandboxJobIdentity = {
            slot: 0,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
            gid: typeof process.getgid === 'function' ? process.getgid() : 0,
            perJobUid: false,
        };
        const lease: SandboxWorkspaceLease = {
            workspaceId: 'prime-settlement',
            dir: workspace,
            identity,
        };
        let dirty = false;
        const session = {
            runtimeSessionId: 'rt_prime_settlement',
            acquire: async () => lease,
            markDirty: () => {
                dirty = true;
            },
        } as unknown as SessionWorkspace;
        const files: TFile[] = [
            { name: 'fast-failure.txt', content: 'fast' },
            { name: 'slow-sibling.txt', content: 'slow' },
        ];
        const job = new Job({
            session_id: 'prime-settlement',
            runtime: makeRuntime(),
            files,
            args: [],
            stdin: '',
            timeouts: { compile: 5000, run: 5000 },
            cpu_times: { compile: 5000, run: 5000 },
            memory_limits: { compile: 100_000_000, run: 100_000_000 },
            session,
        });
        type PrimeContext = {
            submissionDir: string;
            identity: SandboxJobIdentity;
            signal?: AbortSignal;
        };
        const internals = job as unknown as {
            writeFile(file: TFile, context?: PrimeContext): Promise<void>;
        };
        let slowSettled = false;
        internals.writeFile = async (file, context) => {
            if (file.name === 'fast-failure.txt') {
                throw new ValidationError('scripted prime failure');
            }
            await new Promise(resolve => setTimeout(resolve, 30));
            /* Ignore the sibling abort on purpose. The aggregate still must wait,
             * and the immutable context must keep this write inside the workspace. */
            await fsp.writeFile(
                path.join(context!.submissionDir, file.name),
                file.content!,
            );
            slowSettled = true;
        };

        try {
            await expect(job.prime()).rejects.toBeInstanceOf(
                SessionWorkspaceDirtyError,
            );
            expect(slowSettled).toBe(true);
            expect(dirty).toBe(true);
            expect(
                await fsp.readFile(
                    path.join(workspace, 'slow-sibling.txt'),
                    'utf8',
                ),
            ).toBe('slow');
            await job.cleanup();
            expect(
                await fsp
                    .lstat(path.join(process.cwd(), 'slow-sibling.txt'))
                    .catch(() => null),
            ).toBeNull();
        } finally {
            await fsp.rm(workspace, { recursive: true, force: true });
        }
    });

    test('bounds concurrent priming operations', async () => {
        const workspace = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'prime-concurrency-'),
        );
        const identity: SandboxJobIdentity = {
            slot: 0,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
            gid: typeof process.getgid === 'function' ? process.getgid() : 0,
            perJobUid: false,
        };
        const lease: SandboxWorkspaceLease = {
            workspaceId: 'prime-concurrency',
            dir: workspace,
            identity,
        };
        const session = {
            runtimeSessionId: 'rt_prime_concurrency',
            acquire: async () => lease,
            markDirty: () => {},
        } as unknown as SessionWorkspace;
        const files: TFile[] = Array.from(
            { length: config.prime_concurrency + 4 },
            (_, i) => ({ name: `input-${i}.txt`, content: String(i) }),
        );
        const job = new Job({
            session_id: 'prime-concurrency',
            runtime: makeRuntime(),
            files,
            args: [],
            stdin: '',
            timeouts: { compile: 5000, run: 5000 },
            cpu_times: { compile: 5000, run: 5000 },
            memory_limits: { compile: 100_000_000, run: 100_000_000 },
            session,
        });
        const internals = job as unknown as {
            writeFile(file: TFile): Promise<void>;
        };
        let active = 0;
        let maxActive = 0;
        internals.writeFile = async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active -= 1;
        };

        try {
            await job.prime();
            expect(maxActive).toBeLessThanOrEqual(config.prime_concurrency);
            expect(maxActive).toBeGreaterThan(1);
        } finally {
            await job.cleanup();
            await fsp.rm(workspace, { recursive: true, force: true });
        }
    });
});
