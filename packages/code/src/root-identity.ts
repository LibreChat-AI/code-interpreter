import { lstat, realpath } from 'node:fs/promises';

export interface WorkspaceRootIdentity {
    path: string;
    dev: number;
    ino: number;
}

/** Revalidation of a trusted snapshot, never a fresh grant to a replacement. */
export async function matchesWorkspaceRoot(
    root: string,
    identity: WorkspaceRootIdentity
): Promise<boolean> {
    if (root !== identity.path) return false;
    try {
        const current = await lstat(root);
        return (
            current.isDirectory() &&
            !current.isSymbolicLink() &&
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            (await realpath(root)) === identity.path
        );
    } catch {
        return false;
    }
}
