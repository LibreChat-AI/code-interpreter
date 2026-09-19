import { lstat, realpath } from 'node:fs/promises';

export interface WorkspaceRootIdentity {
    path: string;
    dev: string;
    ino: string;
}

/** Capture the inode-bound identity of a canonical workspace grant. */
export async function captureWorkspaceRootIdentity(
    root: string,
): Promise<WorkspaceRootIdentity> {
    const canonical = await realpath(root);
    const current = await lstat(canonical, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()) {
        throw new Error('Workspace root must be a real directory');
    }
    return {
        path: canonical,
        dev: current.dev.toString(),
        ino: current.ino.toString(),
    };
}

/** Revalidation of a trusted snapshot, never a fresh grant to a replacement. */
export async function matchesWorkspaceRoot(
    root: string,
    identity: WorkspaceRootIdentity
): Promise<boolean> {
    if (root !== identity.path) return false;
    try {
        const current = await lstat(root, { bigint: true });
        return (
            current.isDirectory() &&
            !current.isSymbolicLink() &&
            current.dev.toString() === identity.dev &&
            current.ino.toString() === identity.ino &&
            (await realpath(root)) === identity.path
        );
    } catch {
        return false;
    }
}
