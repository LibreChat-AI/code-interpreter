import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { open, withWorkspaceRoot } from './root-access.js';
import {
    loadEnvironmentPreparationKey,
    saveEnvironmentPreparationKey,
} from './storage.js';
import type { CodeEnvironmentDefinition } from './environment.js';
import type { WorkspaceRootIdentity } from './root-identity.js';
import {
    withDependencySnapshot,
    restoreDependencySnapshot,
    publishDependencySnapshot,
} from './dependency-snapshots.js';
import type { DependencySnapshotStore } from './dependency-snapshots.js';
import { assertPreparationSpace } from './snapshot-lifecycle.js';
import type { EnvironmentStoragePolicy } from './snapshot-lifecycle.js';

// Safety bounds on operator-declared hashing, not a dependency-store quota.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;

export interface EnvironmentPreparationOptions {
    root: string;
    identity: WorkspaceRootIdentity;
    setup: NonNullable<CodeEnvironmentDefinition['setup']>;
    receiptPath: string;
    /** Includes the worker's policy and toolchain configuration. */
    context: string;
    execute(
        command: string,
        timeoutMs: number,
    ): Promise<{ exitCode: number | null; timedOut: boolean }>;
    signal?: AbortSignal;
    snapshotStore?: DependencySnapshotStore;
    snapshotScope?: string;
    beforeMutation?(): Promise<void>;
    storage?: EnvironmentStoragePolicy;
}

/** Checkout-local reuse. Never transfers mutable installations between worktrees. */
export async function prepareCodeEnvironment(
    options: EnvironmentPreparationOptions,
): Promise<'prepared' | 'reused' | 'restored'> {
    if (options.snapshotStore) {
        if (!options.setup.reuse?.snapshot || !options.snapshotScope)
            throw new Error(
                'Dependency snapshot requires an explicit preparation scope',
            );
        if (options.snapshotStore.identity.dev !== options.identity.dev)
            throw new Error(
                'Dependency snapshots and checkouts must use the same clone-capable filesystem',
            );
        const portable = await preparationKey(options, true);
        return withDependencySnapshot(
            options.snapshotStore,
            portable!,
            () => prepareInLock(options, portable),
            options.signal,
            true,
        );
    }
    return prepareInLock(options);
}

async function prepareInLock(
    options: EnvironmentPreparationOptions,
    portable?: string,
): Promise<'prepared' | 'reused' | 'restored'> {
    options.signal?.throwIfAborted();
    const key = await preparationKey(options);
    if (
        key &&
        (await loadEnvironmentPreparationKey(options.receiptPath)) === key
    ) {
        const reuse = options.setup.reuse!;
        const check = await options.execute(
            reuse.checkCommand,
            reuse.checkTimeoutMs,
        );
        options.signal?.throwIfAborted();
        if (check.timedOut || check.exitCode === null)
            throw new Error('Environment readiness check did not settle');
        if (check.exitCode === 0 && (await preparationKey(options)) === key)
            return 'reused';
    }
    if (options.snapshotStore && portable) {
        if (options.storage)
            await assertPreparationSpace(options.root, options.storage);
        await options.beforeMutation?.();
        if (
            await restoreDependencySnapshot(
                options.snapshotStore,
                portable,
                options.root,
                options.identity,
                options.signal,
            )
        ) {
            const reuse = options.setup.reuse!;
            const check = await options.execute(
                reuse.checkCommand,
                reuse.checkTimeoutMs,
            );
            options.signal?.throwIfAborted();
            if (check.timedOut || check.exitCode === null)
                throw new Error(
                    'Restored dependency readiness check did not settle',
                );
            if (
                check.exitCode === 0 &&
                (await preparationKey(options)) === key
            ) {
                await saveEnvironmentPreparationKey(options.receiptPath, key!);
                return 'restored';
            }
        }
    }
    if (options.storage)
        await assertPreparationSpace(options.root, options.storage);
    const result = await options.execute(
        options.setup.command,
        options.setup.timeoutMs,
    );
    options.signal?.throwIfAborted();
    if (result.timedOut || result.exitCode !== 0)
        throw new Error('Environment setup failed');
    if (key) {
        // Do not stamp an installation against inputs that changed during setup.
        if ((await preparationKey(options)) !== key)
            throw new Error(
                'Environment preparation inputs changed during setup',
            );
        const reuse = options.setup.reuse!;
        const check = await options.execute(
            reuse.checkCommand,
            reuse.checkTimeoutMs,
        );
        options.signal?.throwIfAborted();
        if (check.timedOut || check.exitCode !== 0)
            throw new Error('Environment readiness check failed after setup');
        if ((await preparationKey(options)) !== key)
            throw new Error(
                'Environment preparation inputs changed during readiness check',
            );
        await saveEnvironmentPreparationKey(options.receiptPath, key);
        if (options.snapshotStore && portable)
            await publishDependencySnapshot(
                options.snapshotStore,
                portable,
                options.root,
                options.identity,
                options.signal,
            );
    }
    return 'prepared';
}

async function preparationKey(
    options: EnvironmentPreparationOptions,
    portable = false,
): Promise<string | undefined> {
    if (!options.setup.reuse) return undefined;
    return withWorkspaceRoot(options.root, options.identity, async () => {
        const hash = createHash('sha256').update(
            JSON.stringify({
                version: 1,
                root: portable ? options.snapshotScope : options.identity,
                setup: options.setup,
                context: options.context,
                node: process.version,
                abi: process.versions.modules,
                platform: process.platform,
                arch: process.arch,
            }),
        );
        let total = 0;
        for (const path of options.setup.reuse!.inputs) {
            options.signal?.throwIfAborted();
            const handle = await open(
                resolve(options.root, path),
                constants.O_RDONLY |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK,
            );
            try {
                const before = await handle.stat();
                if (
                    !before.isFile() ||
                    before.size > MAX_INPUT_BYTES ||
                    total + before.size > MAX_TOTAL_INPUT_BYTES
                )
                    throw new Error(
                        'Environment preparation inputs exceed the bounded regular-file contract',
                    );
                const buffer = Buffer.alloc(before.size + 1);
                let length = 0;
                while (length < buffer.length) {
                    options.signal?.throwIfAborted();
                    const read = await handle.read(
                        buffer,
                        length,
                        buffer.length - length,
                        length,
                    );
                    if (!read.bytesRead) break;
                    length += read.bytesRead;
                }
                const after = await handle.stat();
                if (
                    length !== before.size ||
                    after.size !== before.size ||
                    after.mtimeMs !== before.mtimeMs ||
                    after.ctimeMs !== before.ctimeMs
                )
                    throw new Error(
                        'Environment preparation input changed while hashing',
                    );
                total += length;
                hash.update(JSON.stringify([path, length])).update(
                    buffer.subarray(0, length),
                );
            } finally {
                await handle.close();
            }
        }
        return hash.digest('hex');
    });
}
