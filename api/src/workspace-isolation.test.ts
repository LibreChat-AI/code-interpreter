import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import {
    SANDBOX_WORKSPACE_MODE,
    SESSION_WORKSPACE_ID,
    SandboxJobUidPool,
    applySandboxPathPermissionsNoFollow,
    assertWorkspaceOwnershipCapability,
    checkSandboxWorkspaceHealth,
    clearRetainedWorkspaceCleanupsForTest,
    cleanupSandboxWorkspace,
    compatibilityModeForSkippedChown,
    createSandboxWorkspace,
    createWorkspaceId,
    ensureSessionWorkspace,
    prepareWorkspaceRoot,
    quarantineModeForUid,
    reapStaleWorkspaces,
    resetSessionWorkspace,
    retainWorkspaceCleanupUntilRemoved,
    retainedWorkspaceCleanupCount,
    retryRetainedWorkspaceCleanups,
    sandboxJobUidPool,
    workspaceOwnershipCapabilityErrors,
} from './workspace-isolation';

const nonRootIdentity = {
    slot: 0,
    uid: 65534,
    gid: 65534,
    perJobUid: false,
} as const;

const tmpRoots: string[] = [];
const savedPerJobUids = config.per_job_uids;

async function mkroot(prefix: string): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpRoots.push(root);
    return root;
}

function modeOf(mode: number): number {
    return mode & 0o777;
}

function currentUid(): number | undefined {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

afterEach(async () => {
    config.per_job_uids = savedPerJobUids;
    clearRetainedWorkspaceCleanupsForTest();
    await Promise.all(
        tmpRoots
            .splice(0)
            .map(root => fsp.rm(root, { recursive: true, force: true })),
    );
});

describe('sandbox workspace IDs', () => {
    test('are short random filesystem names and independent from execution IDs', () => {
        const ids = Array.from({ length: 64 }, () => createWorkspaceId());
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect(id.startsWith('ws_')).toBe(true);
            expect(id.length).toBeLessThan(64);
            expect(id).not.toContain('/');
            expect(id).not.toBe('exec_123');
            expect(id).not.toBe('sess_output');
        }
    });
});

describe('sandbox UID slot pool', () => {
    test('allocates one UID/GID per active slot and queues at pool capacity', () => {
        const pool = new SandboxJobUidPool({
            maxConcurrentJobs: 3,
            perJobUids: true,
            uidBase: 200000,
            gidBase: 300000,
            uidCount: 3,
        });

        const a = pool.acquire();
        const b = pool.acquire();
        const c = pool.acquire();
        expect(a?.uid).toBe(200000);
        expect(b?.uid).toBe(200001);
        expect(c?.uid).toBe(200002);
        expect(pool.acquire()).toBeNull();

        pool.release(b!);
        const d = pool.acquire();
        expect(d?.slot).toBe(b?.slot);
        expect(d?.uid).toBe(b?.uid);
        expect(new Set([a!.uid, c!.uid, d!.uid]).size).toBe(3);
    });

    test('caps effective concurrency to UID count when not in strict startup mode', () => {
        const pool = new SandboxJobUidPool({
            maxConcurrentJobs: 4,
            perJobUids: true,
            uidBase: 200000,
            gidBase: 200000,
            uidCount: 2,
        });
        expect(pool.slotCount).toBe(2);
        expect(pool.acquire()).not.toBeNull();
        expect(pool.acquire()).not.toBeNull();
        expect(pool.acquire()).toBeNull();
    });
});

describe('persistent session workspace', () => {
    test('ensureSessionWorkspace uses a stable id and preserves contents across calls', async () => {
        config.per_job_uids = false;
        const root = await mkroot('session-ws-');
        const first = await ensureSessionWorkspace(nonRootIdentity, root);
        expect(first.workspaceId).toBe(SESSION_WORKSPACE_ID);
        expect(first.dir).toBe(path.join(root, SESSION_WORKSPACE_ID));

        await fsp.writeFile(path.join(first.dir, 'state.txt'), 'kept');
        const second = await ensureSessionWorkspace(nonRootIdentity, root);
        expect(second.dir).toBe(first.dir);
        expect(
            await fsp.readFile(path.join(second.dir, 'state.txt'), 'utf8'),
        ).toBe('kept');
    });

    test('the reaper never removes the active session workspace', async () => {
        config.per_job_uids = false;
        const root = await mkroot('session-ws-reaper-');
        const lease = await ensureSessionWorkspace(nonRootIdentity, root);
        await fsp.writeFile(path.join(lease.dir, 'keep.txt'), 'x');
        const removed = await reapStaleWorkspaces({ root, removeAll: true });
        expect(removed).toBe(0);
        expect(
            await fsp.readFile(path.join(lease.dir, 'keep.txt'), 'utf8'),
        ).toBe('x');
    });

    test('resetSessionWorkspace wipes the directory and unprotects it from the reaper', async () => {
        config.per_job_uids = false;
        const root = await mkroot('session-ws-reset-');
        const lease = await ensureSessionWorkspace(nonRootIdentity, root);
        await fsp.writeFile(path.join(lease.dir, 'gone.txt'), 'x');

        expect(await resetSessionWorkspace(root)).toBe(true);
        await expect(fsp.access(lease.dir)).rejects.toBeDefined();

        /* After reset a leftover dir with the same name is reapable again. */
        await fsp.mkdir(lease.dir, { recursive: true });
        const removed = await reapStaleWorkspaces({ root, removeAll: true });
        expect(removed).toBe(1);
    });
});

describe('sandbox workspace root and reaper', () => {
    test('prepares a non-symlink workspace root with non-listable traversal mode', async () => {
        config.per_job_uids = false;
        const root = await mkroot('codeapi-workspace-root-');
        await prepareWorkspaceRoot(root);
        const st = await fsp.lstat(root);
        expect(st.isDirectory()).toBe(true);
        expect(modeOf(st.mode)).toBe(SANDBOX_WORKSPACE_MODE);
    });

    test('workspace health exercises root preparation', async () => {
        config.per_job_uids = false;
        const root = await mkroot('codeapi-workspace-health-');

        const health = await checkSandboxWorkspaceHealth(root);

        expect(health).toEqual({
            status: 'healthy',
            workspaceRoot: root,
            retainedWorkspaceCleanups: 0,
            uidSlots: {
                total: sandboxJobUidPool.slotCount,
                retained: 0,
            },
        });
        expect(modeOf((await fsp.lstat(root)).mode)).toBe(
            SANDBOX_WORKSPACE_MODE,
        );
        expect(await fsp.readdir(root)).toEqual([]);
    });

    test('workspace health fails when retained cleanups exhaust UID slots', async () => {
        config.per_job_uids = true;
        const root = await mkroot('codeapi-workspace-health-retained-');
        for (let i = 0; i < sandboxJobUidPool.slotCount; i++) {
            retainWorkspaceCleanupUntilRemoved(
                {
                    workspaceId: `ws_retained_${i}`,
                    dir: path.join(root, `ws_retained_${i}`),
                    identity: {
                        slot: i,
                        uid: 200000 + i,
                        gid: 200000 + i,
                        perJobUid: true,
                    },
                },
                () => {},
            );
        }

        await expect(checkSandboxWorkspaceHealth(root)).rejects.toThrow(
            'exhausted all',
        );
    });

    test('workspace health fails when retained cleanups exhaust legacy slots', async () => {
        config.per_job_uids = false;
        const root = await mkroot('codeapi-workspace-health-legacy-retained-');
        for (let i = 0; i < sandboxJobUidPool.slotCount; i++) {
            retainWorkspaceCleanupUntilRemoved(
                {
                    workspaceId: `ws_legacy_retained_${i}`,
                    dir: path.join(root, `ws_legacy_retained_${i}`),
                    identity: {
                        slot: i,
                        uid: 65534,
                        gid: 65534,
                        perJobUid: false,
                    },
                },
                () => {},
            );
        }

        await expect(checkSandboxWorkspaceHealth(root)).rejects.toThrow(
            'exhausted all',
        );
    });

    test('rejects a symlink workspace root', async () => {
        config.per_job_uids = false;
        const target = await mkroot('codeapi-workspace-target-');
        const link = path.join(
            os.tmpdir(),
            `codeapi-workspace-link-${Date.now()}`,
        );
        tmpRoots.push(link);
        await fsp.symlink(target, link);
        await expect(prepareWorkspaceRoot(link)).rejects.toThrow(
            'must not be a symlink',
        );
    });

    test('creates active workspaces with non-listable traversal mode and the reaper skips them', async () => {
        config.per_job_uids = false;
        const root = await mkroot('codeapi-workspace-active-');
        const lease = await createSandboxWorkspace(
            {
                slot: 0,
                uid: 65534,
                gid: 65534,
                perJobUid: false,
            },
            root,
        );
        const st = await fsp.stat(lease.dir);
        const expectedMode =
            currentUid() === 0 ? SANDBOX_WORKSPACE_MODE : 0o777;
        expect(modeOf(st.mode)).toBe(expectedMode);

        const removed = await reapStaleWorkspaces({ root, removeAll: true });
        expect(removed).toBe(0);
        await fsp.access(lease.dir);

        expect(await cleanupSandboxWorkspace(lease)).toBe(true);
        await expect(fsp.access(lease.dir)).rejects.toThrow();
    });

    test('rejects per-job UID mode when ownership cannot be enforced', () => {
        expect(workspaceOwnershipCapabilityErrors(1000)).toContain(
            'sandbox-runner must run as root when SANDBOX_PER_JOB_UIDS=true so it can chown per-job workspaces',
        );
        expect(workspaceOwnershipCapabilityErrors(0)).toEqual([]);
        expect(() => assertWorkspaceOwnershipCapability(1000)).toThrow(
            'SANDBOX_PER_JOB_UIDS=true',
        );
    });

    test('derives legacy compatibility modes when chown cannot be enforced', () => {
        expect(compatibilityModeForSkippedChown(0o600)).toBe(0o666);
        expect(compatibilityModeForSkippedChown(0o700)).toBe(0o777);
        expect(compatibilityModeForSkippedChown(SANDBOX_WORKSPACE_MODE)).toBe(
            0o777,
        );
    });

    test('uses recoverable quarantine permissions for non-root cleanup failures', () => {
        expect(quarantineModeForUid(0)).toBe(0o000);
        expect(quarantineModeForUid(1000)).toBe(0o700);
    });

    test('no-follow permission updates reject symlink files and directories', async () => {
        config.per_job_uids = false;
        const root = await mkroot('codeapi-workspace-nofollow-');
        const targetFile = path.join(root, 'target.txt');
        const fileLink = path.join(root, 'file-link');
        const targetDir = path.join(root, 'target-dir');
        const dirLink = path.join(root, 'dir-link');
        await fsp.writeFile(targetFile, 'secret');
        await fsp.mkdir(targetDir);
        await fsp.symlink(targetFile, fileLink);
        await fsp.symlink(targetDir, dirLink);
        const identity = { slot: 0, uid: 65534, gid: 65534, perJobUid: false };

        await expect(
            applySandboxPathPermissionsNoFollow(
                fileLink,
                identity,
                0o600,
                'file',
            ),
        ).rejects.toThrow('Refusing to change permissions');
        await expect(
            applySandboxPathPermissionsNoFollow(
                dirLink,
                identity,
                0o700,
                'directory',
            ),
        ).rejects.toThrow('Refusing to change permissions');
    });

    test('retains UID release until a failed workspace cleanup later succeeds', async () => {
        const lease = {
            workspaceId: 'ws_retry',
            dir: '/tmp/ws_retry',
            identity: { slot: 0, uid: 200000, gid: 200000, perJobUid: true },
        };
        let releaseCount = 0;
        retainWorkspaceCleanupUntilRemoved(lease, () => {
            releaseCount++;
        });

        expect(retainedWorkspaceCleanupCount()).toBe(1);
        expect(await retryRetainedWorkspaceCleanups(async () => false)).toBe(0);
        expect(releaseCount).toBe(0);
        expect(retainedWorkspaceCleanupCount()).toBe(1);

        expect(await retryRetainedWorkspaceCleanups(async () => true)).toBe(1);
        expect(releaseCount).toBe(1);
        expect(retainedWorkspaceCleanupCount()).toBe(0);
    });

    test('stale reaper does not remove retained workspaces before their UID slot is released', async () => {
        const root = await mkroot('codeapi-workspace-retained-');
        const dir = path.join(root, 'ws_retained');
        await fsp.mkdir(dir);
        const lease = {
            workspaceId: 'ws_retained',
            dir,
            identity: { slot: 0, uid: 200000, gid: 200000, perJobUid: true },
        };
        let released = false;
        retainWorkspaceCleanupUntilRemoved(lease, () => {
            released = true;
        });

        expect(await reapStaleWorkspaces({ root, removeAll: true })).toBe(0);
        await fsp.access(dir);
        expect(released).toBe(false);

        expect(await retryRetainedWorkspaceCleanups()).toBe(1);
        expect(released).toBe(true);
        await expect(fsp.access(dir)).rejects.toThrow();
    });

    test('removes stale direct children without following child symlinks', async () => {
        const root = await mkroot('codeapi-workspace-reap-');
        const staleDir = path.join(root, 'ws_stale');
        await fsp.mkdir(staleDir);
        await fsp.chmod(staleDir, 0o777);
        const outside = path.join(root, '..', `codeapi-outside-${Date.now()}`);
        await fsp.writeFile(outside, 'do-not-delete');
        tmpRoots.push(outside);
        await fsp.symlink(outside, path.join(root, 'ws_link'));

        const removed = await reapStaleWorkspaces({
            root,
            maxAgeMs: 1000,
            nowMs: Date.now() + 10_000,
        });
        expect(removed).toBe(2);
        await expect(fsp.access(staleDir)).rejects.toThrow();
        await expect(fsp.access(path.join(root, 'ws_link'))).rejects.toThrow();
        expect(await fsp.readFile(outside, 'utf8')).toBe('do-not-delete');
    });

    test('uses ctime rather than sandbox-controlled mtime for stale workspace age', async () => {
        const root = await mkroot('codeapi-workspace-future-mtime-');
        const staleDir = path.join(root, 'ws_future');
        await fsp.mkdir(staleDir);
        const future = new Date(Date.now() + 86_400_000);
        await fsp.utimes(staleDir, future, future);

        const removed = await reapStaleWorkspaces({
            root,
            maxAgeMs: 1000,
            nowMs: Date.now() + 10_000,
        });
        expect(removed).toBe(1);
        await expect(fsp.access(staleDir)).rejects.toThrow();
    });

    test('NsJail config does not contain static UID/GID maps', async () => {
        const cfg = await fsp.readFile(
            new URL('../config/sandbox.cfg', import.meta.url),
            'utf8',
        );
        expect(cfg).not.toMatch(/\buidmap\s*\{/);
        expect(cfg).not.toMatch(/\bgidmap\s*\{/);
    });
});
