import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import {
    assertPrivateStorageAcl,
    assertPrivateStorageAncestors,
} from './private-storage.js';
import {
    captureWorkspaceRootIdentity,
    matchesWorkspaceRoot,
} from './root-identity.js';
import type { WorkspaceRootIdentity } from './root-identity.js';
import {
    createEnvironmentMountIsolation,
    readEnvironmentMountTable,
} from './environment-mount.js';

export type EnvironmentResourceKind =
    | 'npm-cache'
    | 'uv-cache'
    | 'playwright-browsers';
export interface EnvironmentResource {
    kind: EnvironmentResourceKind;
    path: string;
    access: 'read-only' | 'read-write';
}
export interface LoadedEnvironmentResource extends EnvironmentResource {
    identity: WorkspaceRootIdentity;
    controlPaths: string[];
}
export const RESOURCE_ENVIRONMENT_NAMES: Record<
    EnvironmentResourceKind,
    string
> = {
    'npm-cache': 'npm_config_cache',
    'uv-cache': 'UV_CACHE_DIR',
    'playwright-browsers': 'PLAYWRIGHT_BROWSERS_PATH',
};

export function parseEnvironmentResources(
    value: unknown,
): EnvironmentResource[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3)
        throw new Error('Invalid environment resources');
    const kinds = new Set<string>();
    return value.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('Invalid environment resource');
        const entry = raw as Record<string, unknown>;
        if (
            Object.keys(entry).some(
                key => !['kind', 'path', 'access'].includes(key),
            ) ||
            typeof entry.kind !== 'string' ||
            !Object.hasOwn(RESOURCE_ENVIRONMENT_NAMES, entry.kind) ||
            kinds.has(entry.kind) ||
            typeof entry.path !== 'string' ||
            !isAbsolute(entry.path) ||
            entry.path.length > 4096 ||
            /[\0\r\n]/.test(entry.path) ||
            (entry.access !== 'read-only' && entry.access !== 'read-write')
        )
            throw new Error('Invalid environment resource');
        kinds.add(entry.kind);
        return {
            kind: entry.kind as EnvironmentResourceKind,
            path: entry.path,
            access: entry.access,
        };
    });
}

/** Operator-owned roots only. Resource contents are still untrusted tool data. */
export async function loadEnvironmentResource(
    resource: EnvironmentResource,
): Promise<LoadedEnvironmentResource> {
    const controlPaths = await assertPrivateStorageAncestors(resource.path);
    if ((await lstat(resource.path)).isSymbolicLink())
        throw new Error('Environment resource root cannot be a symlink');
    const path = await realpath(resource.path);
    const identity = await captureWorkspaceRootIdentity(path);
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
        const metadata = await handle.stat({ bigint: true });
        if (
            (metadata.mode & 0o077n) !== 0n ||
            metadata.dev.toString() !== identity.dev ||
            metadata.ino.toString() !== identity.ino
        )
            throw new Error(
                'Environment resource directory must be stable and owner-only',
            );
        await assertPrivateStorageAcl(handle, path, true);
    } finally {
        await handle.close();
    }
    return { ...resource, path, identity, controlPaths };
}

export async function assertEnvironmentResourcesStable(
    resources: readonly LoadedEnvironmentResource[],
): Promise<void> {
    for (const resource of resources) {
        if (!(await matchesWorkspaceRoot(resource.path, resource.identity)))
            throw new Error(
                'Environment resource root changed after admission',
            );
    }
}

export function environmentResourceVariables(
    resources: readonly EnvironmentResource[],
): Record<string, string> {
    return Object.fromEntries(
        resources.map(resource => [
            RESOURCE_ENVIRONMENT_NAMES[resource.kind],
            resource.path,
        ]),
    );
}

export function assertEnvironmentResourceSeparation(
    resources: readonly EnvironmentResource[],
    roots: readonly string[],
): void {
    const contains = (parent: string, child: string) => {
        const path = relative(parent, child);
        return (
            path === '' ||
            (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
        );
    };
    for (const resource of resources) {
        if (
            roots.some(
                root =>
                    contains(root, resource.path) ||
                    contains(resource.path, root),
            )
        )
            throw new Error(
                'Environment resources must not overlap any registered workspace',
            );
    }
}

export async function assertEnvironmentResourceIsolation(
    resources: readonly EnvironmentResource[],
    roots: readonly string[],
    controls: readonly string[],
): Promise<void> {
    if (!resources.length) return;
    assertEnvironmentResourceSeparation(resources, [...roots, ...controls]);
    const table = await readEnvironmentMountTable();
    if (table !== undefined) {
        const check = createEnvironmentMountIsolation(table);
        const stores = resources.map(resource => resource.path);
        check(stores, roots);
        check([...roots, ...controls], stores);
    }
}
