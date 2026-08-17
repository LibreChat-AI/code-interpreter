import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { config } from './config';
import { logger } from './logger';
import { SANDBOX_DIR_MODE } from './validation';

export const SANDBOX_WORKSPACE_ROOT = '/tmp/sandbox';
/* NsJail's bind-mount setup needs execute permission on the source path and
 * ancestors. 0711 keeps workspace names non-listable while allowing the mount
 * path traversal; staged/generated contents stay owner-only. */
export const SANDBOX_WORKSPACE_MODE = 0o711;
export const SANDBOX_STAGED_FILE_MODE = 0o600;
export const SANDBOX_READONLY_FILE_MODE = 0o444;
export const SANDBOX_INSIDE_UID = 65534;
export const SANDBOX_INSIDE_GID = 65534;
export const WORKSPACE_ID_PREFIX = 'ws_';
/* Fixed id for the single persistent session workspace (stateful mode). One
 * per runner process — a session VM runs exactly one runtime session, whose
 * executions serialize on the control-plane lock. Distinct from the random
 * `ws_` per-job ids and kept in `activeWorkspaceIds` so the reaper never
 * removes it mid-session. */
export const SESSION_WORKSPACE_ID = 'session';
const RETAINED_WORKSPACE_RETRY_MS = 5_000;

export class SandboxWorkspaceIsolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxWorkspaceIsolationError';
    }
}

export interface SandboxJobIdentity {
    slot: number;
    uid: number;
    gid: number;
    perJobUid: boolean;
}

export interface SandboxWorkspaceLease {
    workspaceId: string;
    dir: string;
    identity: SandboxJobIdentity;
}

export interface SandboxWorkspaceHealth {
    status: 'healthy';
    workspaceRoot: string;
    retainedWorkspaceCleanups: number;
    uidSlots: {
        total: number;
        retained: number;
    };
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

function currentUid(): number | undefined {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function createWorkspaceId(): string {
    return `${WORKSPACE_ID_PREFIX}${crypto.randomBytes(16).toString('base64url')}`;
}

export function workspaceIsolationConfigErrors(): string[] {
    const errors: string[] = [];
    if (config.hardened_sandbox_mode && !config.per_job_uids) {
        errors.push('SANDBOX_PER_JOB_UIDS=true is required in hardened mode');
    }
    if (
        config.per_job_uids &&
        config.hardened_sandbox_mode &&
        config.job_uid_count < config.max_concurrent_jobs
    ) {
        errors.push(
            'SANDBOX_JOB_UID_COUNT must be at least SANDBOX_MAX_CONCURRENT_JOBS in hardened mode',
        );
    }
    if (config.per_job_uids && config.job_uid_base < 65536) {
        errors.push(
            'SANDBOX_JOB_UID_BASE must be >= 65536 when per-job UIDs are enabled',
        );
    }
    if (config.per_job_uids && config.job_gid_base < 65536) {
        errors.push(
            'SANDBOX_JOB_GID_BASE must be >= 65536 when per-job UIDs are enabled',
        );
    }
    if (config.per_job_uids) {
        const maxUid = config.job_uid_base + config.job_uid_count - 1;
        const maxGid = config.job_gid_base + config.job_uid_count - 1;
        if (maxUid > 2_147_483_647)
            errors.push(
                'SANDBOX_JOB_UID_BASE + SANDBOX_JOB_UID_COUNT exceeds uid range',
            );
        if (maxGid > 2_147_483_647)
            errors.push(
                'SANDBOX_JOB_GID_BASE + SANDBOX_JOB_UID_COUNT exceeds gid range',
            );
    }
    if (
        config.hardened_sandbox_mode &&
        config.workspace_reaper_max_age_seconds < 60
    ) {
        errors.push(
            'SANDBOX_WORKSPACE_REAPER_MAX_AGE_SECONDS must be at least 60 in hardened mode',
        );
    }
    return errors;
}

export function workspaceOwnershipCapabilityErrors(
    uid = currentUid(),
): string[] {
    if (uid === 0) return [];
    return [
        'sandbox-runner must run as root when SANDBOX_PER_JOB_UIDS=true so it can chown per-job workspaces',
    ];
}

export function assertWorkspaceOwnershipCapability(uid = currentUid()): void {
    const errors = workspaceOwnershipCapabilityErrors(uid);
    if (errors.length > 0) {
        throw new SandboxWorkspaceIsolationError(errors.join('; '));
    }
}

export function compatibilityModeForSkippedChown(mode: number): number {
    const ownerBits = mode & 0o700;
    return mode | (ownerBits >> 3) | (ownerBits >> 6);
}

export function quarantineModeForUid(uid = currentUid()): number {
    return uid === 0 ? 0o000 : 0o700;
}

export function assertWorkspaceIsolationConfig(): void {
    const errors = workspaceIsolationConfigErrors();
    if (errors.length > 0) {
        throw new SandboxWorkspaceIsolationError(errors.join('; '));
    }
}

export class SandboxJobUidPool {
    private readonly availableSlots: number[];
    private readonly activeSlots = new Set<number>();
    readonly slotCount: number;

    constructor(
        private readonly opts: {
            maxConcurrentJobs: number;
            perJobUids: boolean;
            uidBase: number;
            gidBase: number;
            uidCount: number;
        },
    ) {
        this.slotCount = opts.perJobUids
            ? Math.min(opts.maxConcurrentJobs, opts.uidCount)
            : opts.maxConcurrentJobs;
        if (this.slotCount < 1) {
            throw new SandboxWorkspaceIsolationError(
                'Sandbox job UID pool must contain at least one slot',
            );
        }
        this.availableSlots = Array.from(
            { length: this.slotCount },
            (_v, i) => i,
        );
    }

    acquire(): SandboxJobIdentity | null {
        const slot = this.availableSlots.shift();
        if (slot === undefined) return null;
        this.activeSlots.add(slot);
        return {
            slot,
            uid: this.opts.perJobUids
                ? this.opts.uidBase + slot
                : SANDBOX_INSIDE_UID,
            gid: this.opts.perJobUids
                ? this.opts.gidBase + slot
                : SANDBOX_INSIDE_GID,
            perJobUid: this.opts.perJobUids,
        };
    }

    release(identity: SandboxJobIdentity): void {
        if (!this.activeSlots.delete(identity.slot)) return;
        this.availableSlots.push(identity.slot);
        this.availableSlots.sort((a, b) => a - b);
    }

    activeCount(): number {
        return this.activeSlots.size;
    }

    availableCount(): number {
        return this.availableSlots.length;
    }
}

export function createSandboxJobUidPoolFromConfig(): SandboxJobUidPool {
    return new SandboxJobUidPool({
        maxConcurrentJobs: config.max_concurrent_jobs,
        perJobUids: config.per_job_uids,
        uidBase: config.job_uid_base,
        gidBase: config.job_gid_base,
        uidCount: config.job_uid_count,
    });
}

export const sandboxJobUidPool = createSandboxJobUidPoolFromConfig();

const activeWorkspaceIds = new Set<string>();
const retainedWorkspaceCleanups = new Map<
    string,
    {
        lease: SandboxWorkspaceLease;
        releaseIdentity: () => void;
        attempts: number;
    }
>();
let retainedWorkspaceRetryTimer: ReturnType<typeof setTimeout> | undefined;

function assertSafeWorkspaceRootPath(root: string): void {
    if (!path.isAbsolute(root)) {
        throw new SandboxWorkspaceIsolationError(
            `Sandbox workspace root must be absolute: ${root}`,
        );
    }
    const resolved = path.resolve(root);
    if (resolved !== root) {
        throw new SandboxWorkspaceIsolationError(
            `Sandbox workspace root must be normalized: ${root}`,
        );
    }
    const parsed = path.parse(root);
    const forbiddenRoots = new Set([
        parsed.root,
        '/tmp',
        '/var',
        '/var/tmp',
        '/home',
        '/Users',
    ]);
    if (forbiddenRoots.has(root)) {
        throw new SandboxWorkspaceIsolationError(
            `Refusing unsafe sandbox workspace root: ${root}`,
        );
    }
}

async function chownOrThrow(
    target: string,
    uid: number,
    gid: number,
    requireChown = false,
): Promise<boolean> {
    try {
        await fsp.chown(target, uid, gid);
        return true;
    } catch (error) {
        if (
            !requireChown &&
            currentUid() !== 0 &&
            !config.hardened_sandbox_mode
        ) {
            return false;
        }
        throw error;
    }
}

export async function applySandboxPathPermissions(
    target: string,
    identity: SandboxJobIdentity,
    mode: number,
): Promise<void> {
    if (identity.perJobUid) assertWorkspaceOwnershipCapability();
    const ownershipApplied = await chownOrThrow(
        target,
        identity.uid,
        identity.gid,
        identity.perJobUid,
    );
    await fsp.chmod(
        target,
        ownershipApplied ? mode : compatibilityModeForSkippedChown(mode),
    );
}

async function chownHandleOrThrow(
    handle: fsp.FileHandle,
    uid: number,
    gid: number,
    requireChown = false,
): Promise<boolean> {
    try {
        await handle.chown(uid, gid);
        return true;
    } catch (error) {
        if (
            !requireChown &&
            currentUid() !== 0 &&
            !config.hardened_sandbox_mode
        ) {
            return false;
        }
        throw error;
    }
}

export async function applySandboxPathPermissionsNoFollow(
    target: string,
    identity: SandboxJobIdentity,
    mode: number,
    expectedType: 'file' | 'directory',
): Promise<void> {
    if (identity.perJobUid) assertWorkspaceOwnershipCapability();
    const flags =
        fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        (expectedType === 'directory' ? fs.constants.O_DIRECTORY : 0);
    let handle: fsp.FileHandle;
    try {
        handle = await fsp.open(target, flags);
    } catch (error) {
        const code = errorCode(error);
        if (
            code === 'ELOOP' ||
            (expectedType === 'directory' && code === 'ENOTDIR')
        ) {
            throw new SandboxWorkspaceIsolationError(
                `Refusing to change permissions on symlink or non-${expectedType}: ${target}`,
            );
        }
        throw error;
    }

    try {
        const st = await handle.stat();
        const matchesExpectedType =
            expectedType === 'file' ? st.isFile() : st.isDirectory();
        if (!matchesExpectedType) {
            throw new SandboxWorkspaceIsolationError(
                `Refusing to change permissions on non-${expectedType}: ${target}`,
            );
        }
        const ownershipApplied = await chownHandleOrThrow(
            handle,
            identity.uid,
            identity.gid,
            identity.perJobUid,
        );
        await handle.chmod(
            ownershipApplied ? mode : compatibilityModeForSkippedChown(mode),
        );
    } finally {
        await handle.close();
    }
}

export async function applyReadOnlyInputPermissions(
    target: string,
): Promise<void> {
    await chownOrThrow(target, 0, 0);
    await fsp.chmod(target, SANDBOX_READONLY_FILE_MODE);
}

export async function prepareWorkspaceRoot(
    root = SANDBOX_WORKSPACE_ROOT,
): Promise<void> {
    assertSafeWorkspaceRootPath(root);
    try {
        const st = await fsp.lstat(root);
        if (st.isSymbolicLink()) {
            throw new SandboxWorkspaceIsolationError(
                `Sandbox workspace root must not be a symlink: ${root}`,
            );
        }
        if (!st.isDirectory()) {
            throw new SandboxWorkspaceIsolationError(
                `Sandbox workspace root must be a directory: ${root}`,
            );
        }
    } catch (error) {
        if (error instanceof SandboxWorkspaceIsolationError) throw error;
        if (errorCode(error) !== 'ENOENT') throw error;
        await fsp.mkdir(root, {
            recursive: true,
            mode: SANDBOX_WORKSPACE_MODE,
        });
    }

    if (currentUid() === 0) {
        await fsp.chown(root, 0, 0);
    } else if (config.hardened_sandbox_mode || config.per_job_uids) {
        assertWorkspaceOwnershipCapability();
    }
    await fsp.chmod(root, SANDBOX_WORKSPACE_MODE);
}

function sandboxWorkspaceHealthProbeIdentity(): SandboxJobIdentity {
    return {
        slot: -1,
        uid: config.per_job_uids ? config.job_uid_base : SANDBOX_INSIDE_UID,
        gid: config.per_job_uids ? config.job_gid_base : SANDBOX_INSIDE_GID,
        perJobUid: config.per_job_uids,
    };
}

export async function checkSandboxWorkspaceHealth(
    root = SANDBOX_WORKSPACE_ROOT,
): Promise<SandboxWorkspaceHealth> {
    const retainedCleanups = retainedWorkspaceCleanupCount();
    if (retainedCleanups >= sandboxJobUidPool.slotCount) {
        throw new SandboxWorkspaceIsolationError(
            `Retained sandbox workspace cleanups exhausted all ${sandboxJobUidPool.slotCount} UID slots`,
        );
    }

    const lease = await createSandboxWorkspace(
        sandboxWorkspaceHealthProbeIdentity(),
        root,
    );
    const removed = await cleanupSandboxWorkspace(lease);
    if (!removed) {
        throw new SandboxWorkspaceIsolationError(
            'Sandbox workspace health probe cleanup failed',
        );
    }

    return {
        status: 'healthy',
        workspaceRoot: root,
        retainedWorkspaceCleanups: retainedCleanups,
        uidSlots: {
            total: sandboxJobUidPool.slotCount,
            retained: retainedCleanups,
        },
    };
}

export async function createSandboxWorkspace(
    identity: SandboxJobIdentity,
    root = SANDBOX_WORKSPACE_ROOT,
): Promise<SandboxWorkspaceLease> {
    if (identity.perJobUid) assertWorkspaceOwnershipCapability();
    await prepareWorkspaceRoot(root);
    for (let attempt = 0; attempt < 8; attempt++) {
        const workspaceId = createWorkspaceId();
        const dir = path.join(root, workspaceId);
        try {
            await fsp.mkdir(dir, { mode: SANDBOX_WORKSPACE_MODE });
            await applySandboxPathPermissions(
                dir,
                identity,
                SANDBOX_WORKSPACE_MODE,
            );
            activeWorkspaceIds.add(workspaceId);
            return { workspaceId, dir, identity };
        } catch (error) {
            if (errorCode(error) === 'EEXIST') continue;
            try {
                await fsp.rm(dir, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
            throw error;
        }
    }
    throw new SandboxWorkspaceIsolationError(
        'Unable to allocate a unique sandbox workspace ID',
    );
}

/**
 * Idempotently ensures the single persistent session workspace exists and is
 * owned by `identity`. Unlike `createSandboxWorkspace`, the directory is
 * stable (`SESSION_WORKSPACE_ID`) and its contents are preserved across calls
 * — reused by every execution in a stateful session. Registered in
 * `activeWorkspaceIds` so the stale-workspace reaper skips it.
 */
export async function ensureSessionWorkspace(
    identity: SandboxJobIdentity,
    root = SANDBOX_WORKSPACE_ROOT,
): Promise<SandboxWorkspaceLease> {
    if (identity.perJobUid) assertWorkspaceOwnershipCapability();
    await prepareWorkspaceRoot(root);
    const dir = path.join(root, SESSION_WORKSPACE_ID);
    try {
        await fsp.mkdir(dir, { mode: SANDBOX_WORKSPACE_MODE });
        await applySandboxPathPermissions(
            dir,
            identity,
            SANDBOX_WORKSPACE_MODE,
        );
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
            try {
                await fsp.rm(dir, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
            throw error;
        }
        /* Already present from a prior job in this session — keep contents,
         * only (re)assert ownership so the pinned identity can read/write. */
        await applySandboxPathPermissions(
            dir,
            identity,
            SANDBOX_WORKSPACE_MODE,
        );
    }
    activeWorkspaceIds.add(SESSION_WORKSPACE_ID);
    return { workspaceId: SESSION_WORKSPACE_ID, dir, identity };
}

/** Tears down the persistent session workspace (session reset / VM terminate). */
export async function resetSessionWorkspace(
    root = SANDBOX_WORKSPACE_ROOT,
): Promise<boolean> {
    const dir = path.join(root, SESSION_WORKSPACE_ID);
    try {
        await fsp.rm(dir, { recursive: true, force: true });
        return true;
    } catch (error) {
        logger.error({ dir, err: error }, 'Failed to reset session workspace');
        await quarantineWorkspace(dir);
        return false;
    } finally {
        activeWorkspaceIds.delete(SESSION_WORKSPACE_ID);
    }
}

async function quarantineWorkspace(dir: string): Promise<void> {
    try {
        const st = await fsp.lstat(dir);
        if (st.isSymbolicLink()) {
            await fsp.unlink(dir);
            return;
        }
        if (currentUid() === 0) await fsp.chown(dir, 0, 0);
        await fsp.chmod(dir, quarantineModeForUid());
    } catch {
        /* Cleanup is already failing; keep the original error visible. */
    }
}

export async function cleanupSandboxWorkspace(
    lease: SandboxWorkspaceLease,
): Promise<boolean> {
    try {
        await fsp.rm(lease.dir, { recursive: true, force: true });
        return true;
    } catch (error) {
        logger.error(
            { workspaceId: lease.workspaceId, dir: lease.dir, err: error },
            'Failed to remove sandbox workspace',
        );
        await quarantineWorkspace(lease.dir);
        return false;
    } finally {
        activeWorkspaceIds.delete(lease.workspaceId);
    }
}

function scheduleRetainedWorkspaceRetry(): void {
    if (retainedWorkspaceRetryTimer || retainedWorkspaceCleanups.size === 0)
        return;
    retainedWorkspaceRetryTimer = setTimeout(() => {
        retainedWorkspaceRetryTimer = undefined;
        retryRetainedWorkspaceCleanups().catch(err => {
            logger.error(
                { err },
                'Retained sandbox workspace cleanup retry failed',
            );
        });
    }, RETAINED_WORKSPACE_RETRY_MS);
    retainedWorkspaceRetryTimer.unref?.();
}

export function retainWorkspaceCleanupUntilRemoved(
    lease: SandboxWorkspaceLease,
    releaseIdentity: () => void,
): void {
    if (!retainedWorkspaceCleanups.has(lease.workspaceId)) {
        retainedWorkspaceCleanups.set(lease.workspaceId, {
            lease,
            releaseIdentity,
            attempts: 0,
        });
    }
    scheduleRetainedWorkspaceRetry();
}

export function retainedWorkspaceCleanupCount(): number {
    return retainedWorkspaceCleanups.size;
}

export async function retryRetainedWorkspaceCleanups(
    cleanup: (
        lease: SandboxWorkspaceLease,
    ) => Promise<boolean> = cleanupSandboxWorkspace,
): Promise<number> {
    if (retainedWorkspaceRetryTimer) {
        clearTimeout(retainedWorkspaceRetryTimer);
        retainedWorkspaceRetryTimer = undefined;
    }

    let released = 0;
    for (const [workspaceId, retained] of Array.from(
        retainedWorkspaceCleanups,
    )) {
        retained.attempts++;
        let removed = false;
        try {
            removed = await cleanup(retained.lease);
        } catch (error) {
            logger.error(
                { workspaceId, attempts: retained.attempts, err: error },
                'Retained sandbox workspace cleanup failed',
            );
        }
        if (!removed) continue;

        if (retainedWorkspaceCleanups.delete(workspaceId)) {
            retained.releaseIdentity();
            released++;
        }
    }

    scheduleRetainedWorkspaceRetry();
    return released;
}

export function clearRetainedWorkspaceCleanupsForTest(): void {
    if (retainedWorkspaceRetryTimer) {
        clearTimeout(retainedWorkspaceRetryTimer);
        retainedWorkspaceRetryTimer = undefined;
    }
    retainedWorkspaceCleanups.clear();
}

export async function reapStaleWorkspaces(
    args: {
        root?: string;
        maxAgeMs?: number;
        removeAll?: boolean;
        nowMs?: number;
    } = {},
): Promise<number> {
    const root = args.root ?? SANDBOX_WORKSPACE_ROOT;
    assertSafeWorkspaceRootPath(root);
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return 0;
        throw error;
    }

    const nowMs = args.nowMs ?? Date.now();
    const maxAgeMs =
        args.maxAgeMs ?? config.workspace_reaper_max_age_seconds * 1000;
    let removed = 0;
    for (const entry of entries) {
        if (activeWorkspaceIds.has(entry.name)) continue;
        if (retainedWorkspaceCleanups.has(entry.name)) continue;
        const fullPath = path.join(root, entry.name);
        const st = await fsp.lstat(fullPath).catch(() => null);
        if (!st) continue;
        if (st.isSymbolicLink()) {
            await fsp.unlink(fullPath);
        } else {
            if (!args.removeAll && nowMs - st.ctimeMs < maxAgeMs) continue;
            await fsp.rm(fullPath, { recursive: true, force: true });
        }
        removed++;
    }
    return removed;
}

export async function assertNsJailConfigHasNoStaticUidMaps(
    configPath: string,
): Promise<void> {
    const text = await fsp.readFile(configPath, 'utf8');
    if (/\b(?:uidmap|gidmap)\s*\{/.test(text)) {
        throw new SandboxWorkspaceIsolationError(
            'NsJail config must not contain static uidmap/gidmap blocks; sandbox-runner supplies per-job mappings',
        );
    }
}

export async function initializeSandboxWorkspaceIsolation(): Promise<void> {
    assertWorkspaceIsolationConfig();
    if (config.per_job_uids) assertWorkspaceOwnershipCapability();
    await assertNsJailConfigHasNoStaticUidMaps(config.nsjail_config);
    await prepareWorkspaceRoot();
    const removed = await reapStaleWorkspaces({ removeAll: true });
    logger.info(
        { root: SANDBOX_WORKSPACE_ROOT, removed },
        'Sandbox workspace isolation initialized',
    );
}

export function startWorkspaceReaper(): () => void {
    const interval = setInterval(() => {
        retryRetainedWorkspaceCleanups()
            .then(async released => {
                if (released > 0)
                    logger.info(
                        { released },
                        'Released retained sandbox job UID slots',
                    );
                return reapStaleWorkspaces();
            })
            .then(removed => {
                if (removed > 0)
                    logger.info(
                        { removed },
                        'Removed stale sandbox workspaces',
                    );
            })
            .catch(err =>
                logger.error({ err }, 'Sandbox workspace reaper failed'),
            );
    }, 300_000);
    interval.unref?.();
    return () => clearInterval(interval);
}

export function fallbackSandboxIdentity(): SandboxJobIdentity {
    return {
        slot: -1,
        uid: SANDBOX_INSIDE_UID,
        gid: SANDBOX_INSIDE_GID,
        perJobUid: false,
    };
}

/**
 * Creates every directory from `root` (exclusive) to `target` (inclusive) one
 * component at a time, refusing to descend through a symlink.
 * `fsp.mkdir(dir, { recursive: true })` would instead follow a symlinked
 * ancestor a prior session turn planted and create directories OUTSIDE the
 * workspace as root — so any privileged write into a PERSISTENT session
 * workspace (input priming, pushed file delivery) must build the path with
 * no-follow semantics first. Fresh per-job workspaces can never contain such a
 * link, so callers may skip it there.
 *
 * Pass `identity` to give directories this call creates the sandbox dir mode
 * and ownership; without it they inherit the runner's (root) ownership, which
 * would leave the sandbox UID unable to write inside them.
 */
export async function ensureDirNoFollow(
    root: string,
    target: string,
    identity?: SandboxJobIdentity,
): Promise<void> {
    const rel = path.relative(root, target);
    if (!rel || rel === '.') return;
    if (rel === '..' || rel.startsWith('..' + path.sep)) {
        throw new SandboxWorkspaceIsolationError(
            `Workspace path escapes the sandbox: ${target}`,
        );
    }
    let cursor = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const st = await fsp.lstat(cursor).catch(() => null);
        if (st == null) {
            /* Parent is already validated as a real dir; create just this component
             * (non-recursive, so it can't follow a link). Tolerate a concurrent
             * sibling prime having just created it. */
            let created = true;
            await fsp.mkdir(cursor).catch((err: NodeJS.ErrnoException) => {
                if (err.code !== 'EEXIST') throw err;
                created = false;
            });
            if (created && identity) {
                await applySandboxPathPermissions(
                    cursor,
                    identity,
                    SANDBOX_DIR_MODE,
                );
            }
            continue;
        }
        if (st.isSymbolicLink()) {
            throw new SandboxWorkspaceIsolationError(
                `Refusing to write through symlinked workspace path: ${path.relative(root, cursor)}`,
            );
        }
        if (!st.isDirectory()) {
            throw new SandboxWorkspaceIsolationError(
                `Workspace ancestor is not a directory: ${path.relative(root, cursor)}`,
            );
        }
    }
}
