import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import {
    assertPrivateStorageAcl,
    assertPrivateStorageAncestors,
} from './private-storage.js';
import {
    BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS,
    BRIDGE_WORKSPACE_COMMAND_MAX_BYTES,
} from './protocol.js';
import type { LocalWorkspaceConfig } from './workspace.js';
import { WorkspaceToolError } from './workspace.js';
import {
    createEnvironmentMountIsolation,
    readEnvironmentMountTable,
} from './environment-mount.js';
import type { WorkspaceToolExecutor } from './workspace.js';
import type { WorkspaceToolRequest, WorkspaceToolResult } from './protocol.js';

export interface CodeEnvironmentDefinition {
    name: string;
    root: string;
    repo?: string;
    ref?: string;
    setup?: { command: string; timeoutMs: number };
    actions?: { name: string; command: string; timeoutMs: number }[];
}

export interface LoadedCodeEnvironment {
    path: string;
    sourceParents?: string[];
    rootPaths?: string[];
    definition: CodeEnvironmentDefinition;
    fingerprint: string;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= max &&
        !value.includes('\0')
    );
}

export function parseCodeEnvironment(
    source: string,
): CodeEnvironmentDefinition {
    if (Buffer.byteLength(source) > 65_536)
        throw new Error('Environment file exceeds 64 KiB');
    const document = parseDocument(source, {
        schema: 'core',
        uniqueKeys: true,
    });
    if (document.errors.length || document.warnings.length) {
        throw new Error('Invalid environment YAML');
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (
        !record(value) ||
        Object.keys(value).some(
            key =>
                !['name', 'root', 'repo', 'ref', 'setup', 'actions'].includes(
                    key,
                ),
        ) ||
        !text(value.name, 64) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.name) ||
        !text(value.root, 4096) ||
        (value.repo !== undefined &&
            (!text(value.repo, 256) ||
                !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo))) ||
        (value.ref !== undefined &&
            (!text(value.ref, 256) || /[\r\n]/.test(value.ref)))
    ) {
        throw new Error(
            'Invalid environment definition: expected name, root, optional repo, ref and setup',
        );
    }
    let setup: CodeEnvironmentDefinition['setup'];
    if (value.setup !== undefined) {
        if (
            !record(value.setup) ||
            Object.keys(value.setup).some(
                key => !['command', 'timeoutMs'].includes(key),
            ) ||
            !text(value.setup.command, 16_384) ||
            Buffer.byteLength(value.setup.command) >
                BRIDGE_WORKSPACE_COMMAND_MAX_BYTES
        ) {
            throw new Error('Invalid environment setup');
        }
        const timeoutMs =
            value.setup.timeoutMs ?? BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS;
        if (
            typeof timeoutMs !== 'number' ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS
        ) {
            throw new Error(
                `Environment setup timeout must be between 1 and ${BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS} ms`,
            );
        }
        setup = { command: value.setup.command, timeoutMs };
    }
    let actions: CodeEnvironmentDefinition['actions'];
    if (value.actions !== undefined) {
        if (!Array.isArray(value.actions) || value.actions.length > 32)
            throw new Error('Invalid environment actions');
        const names = new Set<string>();
        actions = value.actions.map((action: unknown) => {
            if (
                !record(action) ||
                Object.keys(action).some(
                    key => !['name', 'command', 'timeoutMs'].includes(key),
                ) ||
                !text(action.name, 64) ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(action.name) ||
                names.has(action.name) ||
                !text(action.command, 16_384) ||
                Buffer.byteLength(action.command) >
                    BRIDGE_WORKSPACE_COMMAND_MAX_BYTES
            )
                throw new Error('Invalid environment action');
            const timeoutMs = action.timeoutMs ?? 30_000;
            if (
                typeof timeoutMs !== 'number' ||
                !Number.isSafeInteger(timeoutMs) ||
                timeoutMs < 1 ||
                timeoutMs > BRIDGE_WORKSPACE_COMMAND_MAX_TIMEOUT_MS
            )
                throw new Error('Invalid environment action timeout');
            names.add(action.name);
            return { name: action.name, command: action.command, timeoutMs };
        });
    }
    return {
        name: value.name,
        root: value.root,
        ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
        ...(typeof value.ref === 'string' ? { ref: value.ref } : {}),
        ...(setup ? { setup } : {}),
        ...(actions ? { actions } : {}),
    };
}

/** Resolve actions only against the worker-owned snapshot, after normal command admission. */
export class EnvironmentWorkspaceTools implements WorkspaceToolExecutor {
    readonly mutationFailuresAreAtomic?: true;
    readonly capabilities: WorkspaceToolExecutor['capabilities'];
    private readonly environments: Map<string, LoadedCodeEnvironment>;

    constructor(
        private readonly delegate: WorkspaceToolExecutor,
        environments: LoadedCodeEnvironment[],
    ) {
        this.mutationFailuresAreAtomic = delegate.mutationFailuresAreAtomic;
        this.environments = new Map(
            environments.map(environment => [
                environment.definition.name,
                environment,
            ]),
        );
        this.capabilities = {
            ...delegate.capabilities,
            workspaces: delegate.capabilities.workspaces.map(workspace => {
                const environment = this.environments.get(workspace.id);
                if (!environment) return workspace;
                const operations =
                    workspace.operations ?? delegate.capabilities.operations;
                return {
                    ...workspace,
                    environment: {
                        fingerprint: environment.fingerprint,
                        ...(environment.definition.repo
                            ? { repo: environment.definition.repo }
                            : {}),
                        ...(environment.definition.ref
                            ? { ref: environment.definition.ref }
                            : {}),
                        actions: operations.includes('execute_command')
                            ? (environment.definition.actions ?? []).map(
                                  action => action.name,
                              )
                            : [],
                    },
                };
            }),
        };
    }

    async execute(
        request: WorkspaceToolRequest,
        signal?: AbortSignal,
    ): Promise<WorkspaceToolResult> {
        if (
            request.operation !== 'execute_command' ||
            !request.environmentAction
        ) {
            return this.delegate.execute(request, signal);
        }
        const environment = this.environments.get(request.workspaceId);
        const action = environment?.definition.actions?.find(
            action => action.name === request.environmentAction?.name,
        );
        if (
            !environment ||
            environment.fingerprint !== request.environmentAction.fingerprint ||
            !action ||
            (request.cwd !== undefined && request.cwd !== '.')
        ) {
            throw new WorkspaceToolError(
                'Environment action is unavailable or its definition changed',
                'INVALID_REQUEST',
            );
        }
        const { environmentAction: _action, ...commandRequest } = request;
        return this.delegate.execute(
            {
                ...commandRequest,
                command: action.command,
                timeoutMs: Math.min(
                    request.timeoutMs ?? action.timeoutMs,
                    action.timeoutMs,
                ),
                cwd: '.',
            },
            signal,
        );
    }
}

export async function loadCodeEnvironment(
    path: string,
): Promise<LoadedCodeEnvironment> {
    const sourcePath = resolve(path);
    const sourceParents = await assertPrivateStorageAncestors(sourcePath);
    const canonicalPath = await realpath(sourcePath);
    const handle = await open(
        canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let definition: CodeEnvironmentDefinition;
    try {
        const metadata = await handle.stat();
        const self = process.getuid?.();
        if (
            metadata.nlink !== 1 ||
            (metadata.mode & 0o022) !== 0 ||
            (self !== undefined && metadata.uid !== self && metadata.uid !== 0)
        ) {
            throw new Error(
                'Environment definitions must have one link, a trusted owner and no group or other write permissions',
            );
        }
        await assertPrivateStorageAcl(handle, canonicalPath);
        if (!metadata.isFile() || metadata.size > 65_536)
            throw new Error('Invalid environment file');
        const buffer = Buffer.alloc(65_537);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await handle.read(
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        const after = await handle.stat();
        if (
            bytesRead !== metadata.size ||
            after.size !== metadata.size ||
            after.mtimeMs !== metadata.mtimeMs ||
            after.ctimeMs !== metadata.ctimeMs
        ) {
            throw new Error('Environment definition changed while reading');
        }
        definition = parseCodeEnvironment(
            new TextDecoder('utf-8', { fatal: true }).decode(
                buffer.subarray(0, bytesRead),
            ),
        );
    } finally {
        await handle.close();
    }
    const rootPath = resolve(dirname(canonicalPath), definition.root);
    const rootPaths = await assertPrivateStorageAncestors(rootPath);
    const root = await realpath(rootPath);
    if (!(await stat(root)).isDirectory())
        throw new Error('Environment root must be a directory');
    definition = { ...definition, root };
    return {
        path: canonicalPath,
        sourceParents,
        rootPaths,
        definition,
        fingerprint: createHash('sha256')
            .update(JSON.stringify(definition))
            .digest('hex'),
    };
}

/** A workspace must never be able to rewrite a definition used on the next startup. */
export async function assertEnvironmentDefinitionsOutsideRoots(
    environments: readonly LoadedCodeEnvironment[],
    roots: readonly LocalWorkspaceConfig[],
): Promise<void> {
    if (!environments.length) return;
    const mountTable = await readEnvironmentMountTable();
    if (mountTable !== undefined) {
        const assertMountIsolation =
            createEnvironmentMountIsolation(mountTable);
        assertMountIsolation(
            environments.flatMap(environment => [
                environment.path,
                ...(environment.sourceParents ?? []),
            ]),
            roots.map(root => root.root),
        );
        for (const environment of environments) {
            assertMountIsolation(
                environment.rootPaths ?? [],
                roots
                    .filter(root => root.id !== environment.definition.name)
                    .map(root => root.root),
            );
            assertMountIsolation(
                (environment.rootPaths ?? []).filter(
                    path => path !== environment.definition.root,
                ),
                roots
                    .filter(root => root.id === environment.definition.name)
                    .map(root => root.root),
            );
        }
    }
    const identities = new Map<string, Promise<string>>();
    const identity = (path: string): Promise<string> => {
        let result = identities.get(path);
        if (!result) {
            result = stat(path).then(
                metadata => `${metadata.dev}:${metadata.ino}`,
            );
            identities.set(path, result);
        }
        return result;
    };
    // The entry's parent, not its symlink target, determines who can replace it.
    // Compare ancestor identities so casing and directory aliases cannot make a
    // workspace-controlled entry look external on case-insensitive filesystems.
    const canonicalParents = new Map<string, Promise<string>>();
    const controlsEntry = async (component: string, rootIdentity: string): Promise<boolean> => {
        const directory = dirname(component);
        let canonical = canonicalParents.get(directory);
        if (!canonical) {
            canonical = realpath(directory);
            canonicalParents.set(directory, canonical);
        }
        let parent = await canonical;
        while (true) {
            if ((await identity(parent)) === rootIdentity) return true;
            const next = dirname(parent);
            if (next === parent) return false;
            parent = next;
        }
    };
    for (const environment of environments) {
        for (const root of roots) {
            const rootIdentity = await identity(root.root);
            // No granted workspace may control how this root resolves on restart.
            {
                for (const component of environment.rootPaths ?? []) {
                    const path = relative(root.root, component);
                    const sameRoot = (await identity(component)) === rootIdentity;
                    const controlled = await controlsEntry(component, rootIdentity);
                    // A trusted external alias may select its own root, but a
                    // link beneath that root is still writable by the workspace.
                    if (sameRoot && !controlled && root.id === environment.definition.name)
                        continue;
                    if (
                        controlled || sameRoot ||
                        path === '' ||
                        (!isAbsolute(path) &&
                            path !== '..' &&
                            !path.startsWith(`..${sep}`))
                    ) {
                        throw new Error(
                            'Environment root traversal crosses a workspace-controlled component',
                        );
                    }
                }
            }
            for (const controlPath of [
                environment.path,
                ...(environment.sourceParents ?? []),
            ]) {
                const path = relative(root.root, controlPath);
                if (
                    (await controlsEntry(controlPath, rootIdentity)) ||
                    (await identity(controlPath)) === rootIdentity ||
                    path === '' ||
                    (!isAbsolute(path) &&
                        path !== '..' &&
                        !path.startsWith(`..${sep}`))
                ) {
                    throw new Error(
                        'Environment definitions must be outside every registered workspace root',
                    );
                }
            }
        }
    }
}
