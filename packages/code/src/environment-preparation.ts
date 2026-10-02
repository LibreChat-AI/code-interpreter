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
}

/** Checkout-local reuse. Never transfers mutable installations between worktrees. */
export async function prepareCodeEnvironment(
    options: EnvironmentPreparationOptions,
): Promise<'prepared' | 'reused'> {
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
    }
    return 'prepared';
}

async function preparationKey(
    options: EnvironmentPreparationOptions,
): Promise<string | undefined> {
    if (!options.setup.reuse) return undefined;
    return withWorkspaceRoot(options.root, options.identity, async () => {
        const hash = createHash('sha256').update(
            JSON.stringify({
                version: 1,
                root: options.identity,
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
