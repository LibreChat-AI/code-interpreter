import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn as spawnProcess } from 'node:child_process';
import { constants, closeSync, fstatSync, readlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type {
    SpawnOptionsWithoutStdio,
    ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { WorkspaceRootIdentity } from './root-identity.js';

type NativeCall = (...args: (string | number | Buffer)[]) => number;
interface NativeLibrary {
    func(signature: string): NativeCall;
}
interface NativeRuntime {
    load(path: null): NativeLibrary;
    errno(): number;
    os: { errno: Record<string, number> };
}
let nativeRuntime: NativeRuntime | undefined;
let library: NativeLibrary | undefined;
function runtime(): NativeRuntime {
    // Code API imports workspace contracts without installing native worker
    // dependencies. Load the POSIX implementation only for selected roots.
    return (nativeRuntime ??= createRequire(import.meta.url)(
        'koffi',
    ) as NativeRuntime);
}
function bind(signature: string): NativeCall | undefined {
    if (!['darwin', 'linux'].includes(process.platform)) return undefined;
    let call: NativeCall | undefined;
    return (...args) => {
        library ??= runtime().load(null);
        call ??= library.func(signature);
        return call(...args);
    };
}
const nativeOpenAt = bind(
    'int openat(int dirfd, const char *path, int flags, ...)',
);
const O_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0x80000;
// Anchors need search, not directory enumeration permission.
const DIRECTORY_ACCESS =
    constants.O_DIRECTORY |
    (process.platform === 'darwin'
        ? 0x40000000 /* O_SEARCH */
        : 0x200000) /* O_PATH */;
const openAt = nativeOpenAt
    ? (fd: number, path: string, flags: number, mode: number): number =>
          nativeOpenAt(fd, path, flags | O_CLOEXEC, 'unsigned int', mode)
    : undefined;
const renameAt = bind(
    'int renameat(int fromfd, const char *from, int tofd, const char *to)',
);
const linkAt = bind(
    'int linkat(int fromfd, const char *from, int tofd, const char *to, int flags)',
);
const unlinkAt = bind('int unlinkat(int dirfd, const char *path, int flags)');
const getPath =
    process.platform === 'darwin'
        ? bind('int fcntl(int fd, int command, ...)')
        : undefined;

function nativeError(): NodeJS.ErrnoException {
    const errno = runtime().errno();
    const code =
        Object.entries(runtime().os.errno).find(
            ([, value]) => value === errno,
        )?.[0] ?? 'EIO';
    return Object.assign(
        new Error(`Workspace descriptor access failed: ${code}`),
        { code },
    );
}

function checked(fd: number): number {
    if (fd < 0) throw nativeError();
    return fd;
}

function descriptorPath(fd: number): string {
    return process.platform === 'linux'
        ? `/proc/self/fd/${fd}`
        : `/dev/fd/${fd}`;
}

function physicalPath(fd: number): string {
    if (process.platform === 'linux') return readlinkSync(descriptorPath(fd));
    const buffer = Buffer.alloc(1024);
    if (!getPath || getPath(fd, 50 /* F_GETPATH */, 'void *', buffer) !== 0)
        throw nativeError();
    return buffer.subarray(0, buffer.indexOf(0)).toString();
}

function offset(root: string, path: string): string {
    const value = relative(root, path);
    if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
        throw Object.assign(new Error('Path is outside the held workspace'), {
            code: 'EACCES',
        });
    }
    return value || '.';
}

/** A request owns one directory descriptor, not a replaceable pathname grant. */
export class WorkspaceRootAccessError extends Error {}
export class WorkspaceRootAccess {
    private constructor(
        readonly path: string,
        readonly handle: fs.FileHandle,
    ) {}

    static async open(
        path: string,
        identity: WorkspaceRootIdentity,
    ): Promise<WorkspaceRootAccess> {
        if (!openAt || path !== identity.path)
            throw new WorkspaceRootAccessError(
                'Selected project root access is unavailable',
            );
        const handle = await fs
            .open(path, DIRECTORY_ACCESS | constants.O_NOFOLLOW)
            .catch(() => {
                throw new WorkspaceRootAccessError(
                    'Selected project changed after admission',
                );
            });
        try {
            const current = await handle.stat({ bigint: true });
            if (
                !current.isDirectory() ||
                current.dev.toString() !== identity.dev ||
                current.ino.toString() !== identity.ino
            ) {
                throw new WorkspaceRootAccessError(
                    'Selected project changed after admission',
                );
            }
            return new WorkspaceRootAccess(path, handle);
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    close(): Promise<void> {
        return this.handle.close();
    }

    directory(path: string): number {
        const fd = checked(
            openAt!(
                this.handle.fd,
                offset(this.path, path),
                DIRECTORY_ACCESS,
                0,
            ),
        );
        try {
            this.assertDirectoryAncestor(fd);
            this.canonical(fd);
            return fd;
        } catch (error) {
            closeSync(fd);
            throw error;
        }
    }

    private canonical(fd: number): string {
        return resolve(
            this.path,
            offset(physicalPath(this.handle.fd), physicalPath(fd)),
        );
    }

    /** Paths are presentation, not proof of ancestry: a renamed root can make
     * an outside symlink target temporarily occupy its old textual prefix. */
    private assertDirectoryAncestor(fd: number): void {
        const root = fstatSync(this.handle.fd, { bigint: true });
        let current = fd;
        try {
            for (let depth = 0; depth <= 128; depth++) {
                const identity = fstatSync(current, { bigint: true });
                if (identity.dev === root.dev && identity.ino === root.ino)
                    return;
                const parent = checked(
                    openAt!(
                        current,
                        '..',
                        DIRECTORY_ACCESS | constants.O_NOFOLLOW,
                        0,
                    ),
                );
                if (current !== fd) closeSync(current);
                current = parent;
                const ancestor = fstatSync(parent, { bigint: true });
                if (
                    ancestor.dev === identity.dev &&
                    ancestor.ino === identity.ino
                )
                    break;
            }
            throw Object.assign(
                new Error(
                    'Directory is outside the held workspace or exceeds its ancestry limit',
                ),
                { code: 'EACCES' },
            );
        } finally {
            if (current !== fd) closeSync(current);
        }
    }

    private parent(path: string): { fd: number; name: string } {
        const local = offset(this.path, path);
        const fd = checked(
            openAt!(this.handle.fd, dirname(local), DIRECTORY_ACCESS, 0),
        );
        try {
            this.assertDirectoryAncestor(fd);
            this.canonical(fd);
            return { fd, name: basename(local) };
        } catch (error) {
            closeSync(fd);
            throw error;
        }
    }

    async openFile(
        path: string,
        flags: number,
        mode = 0o666,
    ): Promise<fs.FileHandle> {
        const parent = this.parent(path);
        let fd: number | undefined;
        try {
            fd = checked(openAt!(parent.fd, parent.name, flags, mode));
            // Node owns the duplicate, so callers retain native FileHandle semantics
            // for asynchronous I/O, fsync, ownership and deterministic close.
            const accessMode = flags & (constants.O_WRONLY | constants.O_RDWR);
            const duplicate = await fs.open(
                descriptorPath(fd),
                accessMode | constants.O_NONBLOCK,
            );
            try {
                const expected = fstatSync(fd, { bigint: true });
                const actual = await duplicate.stat({ bigint: true });
                if (expected.dev !== actual.dev || expected.ino !== actual.ino)
                    throw new Error('Descriptor duplication changed identity');
                return duplicate;
            } catch (error) {
                await duplicate.close();
                throw error;
            }
        } finally {
            if (fd !== undefined) closeSync(fd);
            closeSync(parent.fd);
        }
    }

    stat(path: string, follow = true): ReturnType<typeof fstatSync> {
        const parent = this.parent(path);
        let fd: number | undefined;
        try {
            const flags =
                process.platform === 'linux'
                    ? 0x200000 /* O_PATH */ |
                      (follow ? 0 : constants.O_NOFOLLOW)
                    : 0x8000 /* O_EVTONLY */ |
                      (follow ? 0 : 0x200000); /* O_SYMLINK */
            fd = this.metadataDescriptor(parent.fd, parent.name, flags);
            return fstatSync(fd);
        } finally {
            if (fd !== undefined) closeSync(fd);
            closeSync(parent.fd);
        }
    }

    private metadataDescriptor(
        parent: number,
        name: string,
        flags: number,
    ): number {
        if (process.platform === 'darwin') {
            // O_EVTONLY still requests read permission on a directory. Search-only
            // descriptors preserve known-path metadata/cwd access without enumeration.
            const directory = openAt!(
                parent,
                name,
                DIRECTORY_ACCESS |
                    (flags & 0x200000 /* O_SYMLINK */
                        ? constants.O_NOFOLLOW
                        : 0),
                0,
            );
            if (directory >= 0) return directory;
            const error = nativeError();
            if (error.code !== 'ENOTDIR' && error.code !== 'ELOOP') throw error;
        }
        return checked(openAt!(parent, name, flags, 0));
    }

    realpath(path: string): string {
        const parent = this.parent(path);
        let fd: number | undefined;
        try {
            fd = this.metadataDescriptor(
                parent.fd,
                parent.name,
                process.platform === 'linux'
                    ? 0x200000 /* O_PATH */
                    : 0x8000 /* O_EVTONLY */,
            );
            return this.canonical(fd);
        } finally {
            if (fd !== undefined) closeSync(fd);
            closeSync(parent.fd);
        }
    }

    install(from: string, to: string, link: boolean): void {
        const source = this.parent(from);
        let target: ReturnType<WorkspaceRootAccess['parent']> | undefined;
        try {
            target = this.parent(to);
            const result = link
                ? linkAt!(source.fd, source.name, target.fd, target.name, 0)
                : renameAt!(source.fd, source.name, target.fd, target.name);
            if (result !== 0) throw nativeError();
        } finally {
            closeSync(source.fd);
            if (target) closeSync(target.fd);
        }
    }

    unlink(path: string): void {
        const parent = this.parent(path);
        try {
            if (unlinkAt!(parent.fd, parent.name, 0) !== 0) throw nativeError();
        } finally {
            closeSync(parent.fd);
        }
    }
}

const context = new AsyncLocalStorage<WorkspaceRootAccess>();
export async function withWorkspaceRoot<T>(
    root: string,
    identity: WorkspaceRootIdentity | undefined,
    action: () => Promise<T>,
): Promise<T> {
    if (!identity) return action();
    const access = await WorkspaceRootAccess.open(root, identity);
    try {
        return await context.run(access, action);
    } finally {
        await access.close();
    }
}

type SpawnCommand = (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export function spawnWithinWorkspace(
    spawner: SpawnCommand,
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
    const access = context.getStore();
    if (!access) return spawner(command, args, options);
    if (typeof options.cwd !== 'string')
        throw new Error('Workspace process requires a working directory');
    const fd = access.directory(options.cwd);
    try {
        const env = { ...(options.env ?? process.env) };
        delete env.NODE_OPTIONS;
        delete env.NODE_PATH;
        return spawner(
            process.execPath,
            [
                fileURLToPath(new URL('./root-exec.js', import.meta.url)),
                command,
                ...args,
            ],
            {
                ...options,
                cwd: '/',
                env,
                // The trusted bootstrap consumes fd 3 before exec. Commands receive no
                // root descriptor, bridge socket or new long-lived supervising process.
                stdio: [
                    ...(Array.isArray(options.stdio)
                        ? options.stdio.slice(0, 3)
                        : ['pipe', 'pipe', 'pipe']),
                    fd,
                ],
            } as SpawnOptionsWithoutStdio,
        );
    } finally {
        closeSync(fd);
    }
}

export const spawn = ((
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
) =>
    spawnWithinWorkspace(
        spawnProcess,
        command,
        args,
        options,
    )) as typeof spawnProcess;

// Only workspace filesystem consumers import these adapters. Unselected legacy
// roots retain their existing behavior; concurrent selected roots never share fd state.
export const open = async (
    path: string,
    flags: number | 'r',
    mode?: number,
): Promise<fs.FileHandle> =>
    context
        .getStore()
        ?.openFile(path, flags === 'r' ? constants.O_RDONLY : flags, mode) ??
    fs.open(path, flags, mode);
export const stat = async (path: string) =>
    context.getStore()?.stat(path) ?? fs.stat(path);
export const lstat = async (path: string) =>
    context.getStore()?.stat(path, false) ?? fs.lstat(path);
export const realpath = async (path: string): Promise<string> =>
    context.getStore()?.realpath(path) ?? fs.realpath(path);
export const rename = async (from: string, to: string): Promise<void> => {
    const access = context.getStore();
    if (access) access.install(from, to, false);
    else await fs.rename(from, to);
};
export const link = async (from: string, to: string): Promise<void> => {
    const access = context.getStore();
    if (access) access.install(from, to, true);
    else await fs.link(from, to);
};
export const unlink = async (path: string): Promise<void> => {
    const access = context.getStore();
    if (access) access.unlink(path);
    else await fs.unlink(path);
};
