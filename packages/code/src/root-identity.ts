import { lstat, realpath } from 'node:fs/promises';

export interface WorkspaceRootIdentity {
    path: string;
    dev: string;
    ino: string;
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
