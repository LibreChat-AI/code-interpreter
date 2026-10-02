import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'node:path';
import { createRequire } from 'node:module';
import * as rooted from './root-access.js';
import { withProcessLock } from './process-lock.js';
import {
    captureWorkspaceRootIdentity,
    matchesWorkspaceRoot,
} from './root-identity.js';
import { loadEnvironmentResource } from './environment-resources.js';
import { isSafePortableRelativePath } from './protocol.js';
import type { WorkspaceRootIdentity } from './root-identity.js';

export interface DependencySnapshotConfig {
    store: string;
    paths: string[];
    maxBytes: number;
    maxFiles: number;
}
export interface DependencySnapshotStore extends DependencySnapshotConfig {
    identity: WorkspaceRootIdentity;
    controlPaths: string[];
}
export function parseDependencySnapshot(
    value: unknown,
): DependencySnapshotConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid dependency snapshot');
    const v = value as Record<string, unknown>;
    const maxBytes = v.maxBytes ?? 4 * 1024 ** 3;
    const maxFiles = v.maxFiles ?? 200_000;
    if (
        Object.keys(v).some(
            k => !['store', 'paths', 'maxBytes', 'maxFiles'].includes(k),
        ) ||
        typeof v.store !== 'string' ||
        !isAbsolute(v.store) ||
        v.store.length > 4096 ||
        /[\0\r\n]/.test(v.store) ||
        !Array.isArray(v.paths) ||
        !v.paths.length ||
        v.paths.length > 32 ||
        v.paths.some(
            p =>
                typeof p !== 'string' ||
                !isSafePortableRelativePath(p) ||
                basename(p) !== 'node_modules' ||
                p.split('/').some(c => c === '.git' || c === '.worktrees'),
        ) ||
        new Set(v.paths).size !== v.paths.length ||
        v.paths.some(p =>
            (v.paths as unknown[]).some(
                q => p !== q && (p as string).startsWith(`${q}/`),
            ),
        ) ||
        !Number.isSafeInteger(maxBytes) ||
        (maxBytes as number) < 1 ||
        !Number.isSafeInteger(maxFiles) ||
        (maxFiles as number) < 1
    )
        throw new Error('Invalid dependency snapshot');
    return {
        store: v.store,
        paths: v.paths as string[],
        maxBytes: maxBytes as number,
        maxFiles: maxFiles as number,
    };
}
export async function loadDependencySnapshot(
    config: DependencySnapshotConfig,
): Promise<DependencySnapshotStore> {
    const resource = await loadEnvironmentResource({
        kind: 'npm-cache',
        path: config.store,
        access: 'read-only',
    });
    return {
        ...config,
        store: resource.path,
        identity: resource.identity,
        controlPaths: resource.controlPaths,
    };
}

let native:
    | { clone: (...args: any[]) => number; errno: () => number }
    | undefined;
/** No copy fallback and no hardlinks: failure means the host cannot meet the contract. */
async function cloneFile(source: fs.FileHandle, target: string): Promise<void> {
    if (!native) {
        const koffi = createRequire(import.meta.url)('koffi');
        const library = koffi.load(null);
        native = {
            errno: () => koffi.errno(),
            clone:
                process.platform === 'darwin'
                    ? library.func(
                          'int fclonefileat(int srcfd, int dstfd, const char *name, unsigned int flags)',
                      )
                    : library.func(
                          'int ioctl(int fd, unsigned long request, ...)',
                      ),
        };
    }
    if (process.platform === 'darwin') {
        const parent = await rooted.open(
            dirname(target),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            if (native.clone(source.fd, parent.fd, basename(target), 0) !== 0)
                throw new Error(
                    `Copy-on-write dependency cloning unavailable (errno ${native.errno()})`,
                );
        } finally {
            await parent.close();
        }
    } else if (process.platform === 'linux') {
        const output = await rooted.open(
            target,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
            0o600,
        );
        try {
            if (native.clone(output.fd, 0x40049409, 'int', source.fd) !== 0)
                throw new Error(
                    `Copy-on-write dependency cloning unavailable (errno ${native.errno()})`,
                );
        } finally {
            await output.close();
        }
    } else
        throw new Error(
            'Dependency snapshots require a clone-capable POSIX filesystem',
        );
}

function inside(root: string, path: string): boolean {
    const p = relative(root, path);
    return !isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`);
}
async function removeTree(path: string): Promise<void> {
    const stat = await rooted.lstat(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
    });
    if (!stat) return;
    if (!stat.isDirectory()) return rooted.unlink(path);
    for (const name of await rooted.readdir(path))
        await removeTree(join(path, name));
    await rooted.rmdir(path);
}
async function cloneTree(
    sourceRoot: string,
    sourceIdentity: WorkspaceRootIdentity,
    targetRoot: string,
    targetIdentity: WorkspaceRootIdentity,
    paths: string[],
    config: DependencySnapshotConfig,
    checkout: string,
    signal?: AbortSignal,
): Promise<void> {
    let bytes = 0,
        files = 0;
    const target = <T>(operation: () => Promise<T>) =>
        rooted.withWorkspaceRoot(targetRoot, targetIdentity, operation);
    await rooted.withWorkspaceRoot(sourceRoot, sourceIdentity, async () => {
        const visit = async (
            path: string,
            out: string,
            checkoutPath: string,
        ): Promise<void> => {
            signal?.throwIfAborted();
            if (++files > config.maxFiles)
                throw new Error('Dependency snapshot exceeds maxFiles');
            const before = await rooted.lstat(path);
            if (before.isDirectory()) {
                await target(() => rooted.mkdir(out));
                for (const name of await rooted.readdir(
                    path,
                    config.maxFiles - files,
                ))
                    await visit(
                        join(path, name),
                        join(out, name),
                        join(checkoutPath, name),
                    );
                const after = await rooted.lstat(path);
                if (
                    before.ino !== after.ino ||
                    before.dev !== after.dev ||
                    before.mtimeMs !== after.mtimeMs ||
                    before.ctimeMs !== after.ctimeMs
                )
                    throw new Error(
                        'Dependencies changed during snapshot traversal',
                    );
            } else if (before.isSymbolicLink()) {
                const link = await rooted.readlink(path);
                const resolved = resolve(dirname(checkoutPath), link);
                if (
                    isAbsolute(link) ||
                    !inside(checkout, resolved) ||
                    relative(checkout, resolved).split(sep).includes('.git') ||
                    relative(checkout, resolved)
                        .split(sep)
                        .includes('.worktrees')
                )
                    throw new Error(
                        'Dependency snapshot link must remain checkout-local',
                    );
                await target(() => rooted.symlink(link, out));
            } else if (before.isFile()) {
                if (before.nlink !== 1)
                    throw new Error(
                        'Dependency snapshots reject hard-linked files',
                    );
                bytes += Number(before.size);
                if (bytes > config.maxBytes)
                    throw new Error('Dependency snapshot exceeds maxBytes');
                const handle = await rooted.open(
                    path,
                    constants.O_RDONLY |
                        constants.O_NOFOLLOW |
                        constants.O_NONBLOCK,
                );
                try {
                    const opened = await handle.stat();
                    if (
                        !opened.isFile() ||
                        opened.nlink !== 1 ||
                        opened.ino !== before.ino ||
                        opened.dev !== before.dev
                    )
                        throw new Error(
                            'Dependency entry changed before cloning',
                        );
                    await target(async () => {
                        await cloneFile(handle, out);
                        const output = await rooted.open(
                            out,
                            constants.O_RDONLY | constants.O_NOFOLLOW,
                        );
                        try {
                            await output.chmod(opened.mode & 0o777);
                        } finally {
                            await output.close();
                        }
                    });
                    const after = await handle.stat();
                    if (
                        opened.size !== after.size ||
                        after.nlink !== 1 ||
                        opened.mtimeMs !== after.mtimeMs ||
                        opened.ctimeMs !== after.ctimeMs
                    )
                        throw new Error(
                            'Dependency file changed during cloning',
                        );
                } finally {
                    await handle.close();
                }
            } else
                throw new Error(
                    'Dependency snapshots accept regular files, directories and relative links only',
                );
        };
        for (let i = 0; i < paths.length; i++)
            await visit(
                join(sourceRoot, paths[i]),
                join(targetRoot, String(i)),
                join(checkout, config.paths[i]),
            );
    });
}

export async function withDependencySnapshot<T>(
    store: DependencySnapshotStore,
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    verifyCloneSupport = false,
): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('Invalid dependency snapshot key');
    if (!(await matchesWorkspaceRoot(store.store, store.identity)))
        throw new Error('Dependency snapshot store changed after admission');
    return withProcessLock(
        join(store.store, `${key}.lock`),
        async () => {
            if (!(await matchesWorkspaceRoot(store.store, store.identity)))
                throw new Error(
                    'Dependency snapshot store changed while waiting',
                );
            signal?.throwIfAborted();
            // Fail before installation, rather than discovering unsupported reflinks after npm ci.
            if (verifyCloneSupport) {
                const probe = await fs.mkdtemp(join(store.store, '.probe-'));
                try {
                    await fs.writeFile(join(probe, 'source'), 'clone-support', {
                        mode: 0o600,
                    });
                    const input = await fs.open(
                        join(probe, 'source'),
                        constants.O_RDONLY | constants.O_NOFOLLOW,
                    );
                    try {
                        await rooted.withWorkspaceRoot(
                            store.store,
                            store.identity,
                            () => cloneFile(input, join(probe, 'target')),
                        );
                    } finally {
                        await input.close();
                    }
                } finally {
                    await fs.rm(probe, { recursive: true, force: true });
                }
            }
            signal?.throwIfAborted();
            return operation();
        },
        signal,
    );
}
/** Restores only when every declared installation is absent. Existing files are never replaced. */
export async function restoreDependencySnapshot(
    store: DependencySnapshotStore,
    key: string,
    checkout: string,
    identity: WorkspaceRootIdentity,
    signal?: AbortSignal,
): Promise<boolean> {
    return rooted.withWorkspaceRoot(checkout, identity, async () => {
        for (const path of store.paths) {
            const exists = await rooted.lstat(join(checkout, path)).then(
                () => true,
                (e: NodeJS.ErrnoException) => {
                    if (e.code === 'ENOENT') return false;
                    throw e;
                },
            );
            if (exists) return false;
        }
        const source = join(store.store, key);
        const metadata = await fs
            .lstat(source)
            .catch((e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOENT') return undefined;
                throw e;
            });
        if (!metadata) return false;
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
            throw new Error('Invalid dependency snapshot entry');
        const staging = join(
            checkout,
            `.librechat-dependencies-${randomUUID()}`,
        );
        await rooted.mkdir(staging);
        const installed: string[] = [];
        try {
            const stagingIdentity = await captureWorkspaceRootIdentity(staging);
            await cloneTree(
                source,
                await captureWorkspaceRootIdentity(source),
                staging,
                stagingIdentity,
                store.paths.map((_, i) => String(i)),
                store,
                checkout,
                signal,
            );
            for (let i = 0; i < store.paths.length; i++) {
                signal?.throwIfAborted();
                const destination = join(checkout, store.paths[i]);
                // rename is descriptor-anchored; reject a newly appeared entry instead of replacing it.
                if (
                    await rooted.lstat(destination).then(
                        () => true,
                        (e: NodeJS.ErrnoException) => {
                            if (e.code === 'ENOENT') return false;
                            throw e;
                        },
                    )
                )
                    throw new Error(
                        'Dependency destination appeared during restore',
                    );
                await rooted.renameExclusive(
                    join(staging, String(i)),
                    destination,
                );
                installed.push(destination);
            }
            return true;
        } catch (error) {
            // A partial restore is inspection-worthy; do not delete a destination another process may have changed.
            if (installed.length)
                throw new Error(
                    'Dependency restore partially committed; inspect the checkout',
                    { cause: error },
                );
            throw error;
        } finally {
            await removeTree(staging);
        }
    });
}
export async function publishDependencySnapshot(
    store: DependencySnapshotStore,
    key: string,
    checkout: string,
    identity: WorkspaceRootIdentity,
    signal?: AbortSignal,
): Promise<void> {
    const destination = join(store.store, key);
    if (
        await fs.lstat(destination).then(
            () => true,
            (e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOENT') return false;
                throw e;
            },
        )
    )
        return;
    const staging = await fs.mkdtemp(join(store.store, '.staging-'));
    try {
        await cloneTree(
            checkout,
            identity,
            staging,
            await captureWorkspaceRootIdentity(staging),
            store.paths,
            store,
            checkout,
            signal,
        );
        signal?.throwIfAborted();
        await fs.rename(staging, destination);
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}
