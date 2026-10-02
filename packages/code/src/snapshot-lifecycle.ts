import { constants } from 'node:fs';
import { lstat, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { withProcessLock, tryWithProcessLock } from './process-lock.js';
import { matchesWorkspaceRoot } from './root-identity.js';
import { readdir, withWorkspaceRoot } from './root-access.js';
import type { DependencySnapshotStore } from './dependency-snapshots.js';

export interface SnapshotLifecyclePolicy {
    maxStoreBytes: number;
    maxEntries: number;
    retentionMs: number;
    scanLimit: number;
}
export interface EnvironmentStoragePolicy {
    minFreeBytes: number;
    setupReserveBytes: number;
}
function positive(value: unknown, zero = false): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= (zero ? 0 : 1)
    );
}
export function parseSnapshotLifecycle(
    value: unknown,
): SnapshotLifecyclePolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid snapshot lifecycle');
    const v = value as Record<string, unknown>;
    const policy = {
        maxStoreBytes: v.maxStoreBytes ?? 20 * 1024 ** 3,
        maxEntries: v.maxEntries ?? 8,
        retentionMs: v.retentionMs ?? 5 * 24 * 60 * 60 * 1000,
        scanLimit: v.scanLimit ?? 4096,
    };
    if (
        Object.keys(v).some(key => !Object.hasOwn(policy, key)) ||
        !Object.values(policy).every(value => positive(value))
    )
        throw new Error('Invalid snapshot lifecycle');
    return policy as SnapshotLifecyclePolicy;
}
export function parseEnvironmentStorage(
    value: unknown,
): EnvironmentStoragePolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid environment storage policy');
    const v = value as Record<string, unknown>;
    const policy = {
        minFreeBytes: v.minFreeBytes ?? 5 * 1024 ** 3,
        setupReserveBytes: v.setupReserveBytes ?? 2 * 1024 ** 3,
    };
    if (
        Object.keys(v).some(key => !Object.hasOwn(policy, key)) ||
        !Object.values(policy).every(value => positive(value, true)) ||
        !Number.isSafeInteger(
            (policy.minFreeBytes as number) +
                (policy.setupReserveBytes as number),
        )
    )
        throw new Error('Invalid environment storage policy');
    return policy as EnvironmentStoragePolicy;
}
/** Soft admission for managed preparation, not a reservation or arbitrary-write quota. */
export async function assertPreparationSpace(
    root: string,
    policy: EnvironmentStoragePolicy,
    available: (root: string) => Promise<bigint> = async path => {
        const status = await statfs(path, { bigint: true });
        return status.bavail * status.bsize;
    },
): Promise<void> {
    if (
        (await available(root)) <
        BigInt(policy.minFreeBytes) + BigInt(policy.setupReserveBytes)
    )
        throw new Error(
            'Managed environment preparation deferred: free disk is below the configured floor plus setup reserve. Clean reproducible artifacts or expand storage; no setup command was started.',
        );
}

export const SNAPSHOT_MANIFEST = '.snapshot.json';
export const STAGING_MANIFEST = '.staging.json';
export class SnapshotBudgetFullError extends Error {}
export interface SnapshotManifest {
    version: 1;
    key: string;
    bytes: number;
    files: number;
    createdAt: number;
}
async function manifest(
    store: DependencySnapshotStore,
    key: string,
    name = key,
    file = SNAPSHOT_MANIFEST,
): Promise<SnapshotManifest | undefined> {
    const directory = join(store.store, name);
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || status.mode & 0o077)
        return;
    const handle = await open(
        join(directory, file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' || e.code === 'ELOOP') return undefined;
        throw e;
    });
    if (!handle) return;
    try {
        const metadata = await handle.stat();
        if (
            !metadata.isFile() ||
            metadata.size > 4096 ||
            metadata.mode & 0o077 ||
            (process.getuid && metadata.uid !== process.getuid())
        )
            return;
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) return;
        let value: unknown;
        try {
            value = JSON.parse(buffer.subarray(0, bytesRead).toString());
        } catch {
            return;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const entry = value as Record<string, unknown>;
        if (
            entry.version !== 1 ||
            entry.key !== key ||
            !positive(entry.bytes, true) ||
            !positive(entry.files) ||
            !positive(entry.createdAt)
        )
            return;
        return value as SnapshotManifest;
    } finally {
        await handle.close();
    }
}
export interface SnapshotPruneResult {
    dryRun: boolean;
    removed: string[];
    skippedActive: string[];
    unknown: string[];
    retainedBytes: number;
    retainedEntries: number;
}

/** Only worker-published manifests authorize deletion. Source worktrees and unknown entries never qualify. */
export async function pruneDependencySnapshots(
    store: DependencySnapshotStore,
    options: {
        dryRun?: boolean;
        currentKey?: string;
        incomingBytes?: number;
        incomingEntries?: number;
        now?: number;
        signal?: AbortSignal;
        publish?: () => Promise<void>;
    } = {},
): Promise<SnapshotPruneResult> {
    const policy = store.lifecycle;
    if (!policy) throw new Error('Snapshot lifecycle is not configured');
    return withProcessLock(
        join(store.store, '.maintenance.lock'),
        async () => {
            if (!(await matchesWorkspaceRoot(store.store, store.identity)))
                throw new Error(
                    'Dependency snapshot store changed before cleanup',
                );
            const result: SnapshotPruneResult = {
                dryRun: options.dryRun === true,
                removed: [],
                skippedActive: [],
                unknown: [],
                retainedBytes: 0,
                retainedEntries: 0,
            };
            const candidates: {
                key: string;
                data: SnapshotManifest;
                lastUsed: number;
            }[] = [];
            const names = await withWorkspaceRoot(
                store.store,
                store.identity,
                () => readdir(store.store, policy.scanLimit),
            );
            for (const key of names) {
                options.signal?.throwIfAborted();
                const staging = /^\.staging-([a-f0-9]{64})-[A-Za-z0-9]+$/.exec(
                    key,
                );
                if (staging) {
                    const owner = staging[1];
                    const data = await manifest(
                        store,
                        owner,
                        key,
                        STAGING_MANIFEST,
                    );
                    if (!data) {
                        result.unknown.push(key);
                        continue;
                    }
                    if (owner === options.currentKey) continue;
                    const lock = await tryWithProcessLock(
                        join(store.store, `${owner}.lock`),
                        async () => {
                            if (
                                !(await manifest(
                                    store,
                                    owner,
                                    key,
                                    STAGING_MANIFEST,
                                ))
                            )
                                return;
                            if (!options.dryRun)
                                await rm(join(store.store, key), {
                                    recursive: true,
                                    force: false,
                                });
                            result.removed.push(key);
                        },
                        options.signal,
                    );
                    if (!lock.acquired) result.skippedActive.push(key);
                    continue;
                }
                if (!/^[a-f0-9]{64}$/.test(key)) {
                    if (
                        !/^[a-f0-9]{64}\.lock$/.test(key) &&
                        key !== '.maintenance.lock'
                    )
                        result.unknown.push(key);
                    continue;
                }
                const data = await manifest(store, key);
                if (!data) {
                    result.unknown.push(key);
                    continue;
                }
                candidates.push({
                    key,
                    data,
                    lastUsed: (
                        await lstat(join(store.store, key, SNAPSHOT_MANIFEST))
                    ).mtimeMs,
                });
                result.retainedBytes += data.bytes;
                result.retainedEntries++;
            }
            const now = options.now ?? Date.now();
            candidates.sort(
                (a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key),
            );
            for (const candidate of candidates) {
                options.signal?.throwIfAborted();
                if (candidate.key === options.currentKey) continue;
                if (
                    now - candidate.lastUsed < policy.retentionMs &&
                    result.retainedBytes + (options.incomingBytes ?? 0) <=
                        policy.maxStoreBytes &&
                    result.retainedEntries + (options.incomingEntries ?? 0) <=
                        policy.maxEntries
                )
                    continue;
                const admission = await tryWithProcessLock(
                    join(store.store, `${candidate.key}.lock`),
                    async () => {
                        const fresh = await manifest(store, candidate.key);
                        const updated = await lstat(
                            join(store.store, candidate.key, SNAPSHOT_MANIFEST),
                        );
                        if (
                            !fresh ||
                            fresh.createdAt !== candidate.data.createdAt ||
                            updated.mtimeMs !== candidate.lastUsed
                        )
                            return;
                        if (!options.dryRun)
                            await rm(join(store.store, candidate.key), {
                                recursive: true,
                                force: false,
                            });
                        result.removed.push(candidate.key);
                        result.retainedBytes -= candidate.data.bytes;
                        result.retainedEntries--;
                    },
                    options.signal,
                );
                if (!admission.acquired)
                    result.skippedActive.push(candidate.key);
            }
            if (
                !options.dryRun &&
                (result.retainedBytes + (options.incomingBytes ?? 0) >
                    policy.maxStoreBytes ||
                    result.retainedEntries + (options.incomingEntries ?? 0) >
                        policy.maxEntries)
            )
                throw new SnapshotBudgetFullError(
                    'Dependency snapshot budget is full; active or unknown data was not deleted',
                );
            if (!options.dryRun) await options.publish?.();
            return result;
        },
        options.signal,
    );
}
