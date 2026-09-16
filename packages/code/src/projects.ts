import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const skipped = new Set(['node_modules', 'vendor']);

export interface LocalProject {
    id: string;
    path: string;
    remote: string | null;
    branch: string | null;
    head: string | null;
}

export interface ProjectInventory {
    projects: LocalProject[];
    truncated: boolean;
    incomplete: boolean;
}

export interface ProjectDiscoveryOptions {
    root: string;
    maxDepth?: number;
    maxProjects?: number;
    maxEntries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** Public repository identity only: never propagate credentials or URL query data. */
export function projectRemote(value: string): string | null {
    let host: string;
    let path: string;
    try {
        const scp = /^(?:[^/@:\s]+@)?([^/:\s]+):([^\s]+)$/.exec(value);
        if (scp && !value.includes('://')) {
            host = scp[1];
            path = scp[2];
        } else {
            const url = new URL(value);
            if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol))
                return null;
            host = url.hostname;
            path = url.pathname.replace(/^\//, '');
        }
        path = path.replace(/\.git$/, '');
        if (
            !/^[A-Za-z0-9.-]+$/.test(host) ||
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)
        )
            return null;
        if (path.split('/').some(part => part === '.' || part === '..'))
            return null;
        return `${host.toLowerCase()}/${path}`;
    } catch {
        return null;
    }
}

function limit(
    value: number | undefined,
    fallback: number,
    maximum: number
): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
        throw new Error('Invalid project discovery limit');
    return resolved;
}

/** Bounded local inventory; it does not grant roots or mutate a checkout. */
export async function discoverProjects(
    options: ProjectDiscoveryOptions
): Promise<ProjectInventory> {
    const maxDepth = limit(options.maxDepth, 3, 16);
    const maxProjects = limit(options.maxProjects, 256, 256);
    const maxEntries = limit(options.maxEntries, 10_000, 100_000);
    const timeoutMs = limit(options.timeoutMs, 10_000, 60_000);
    const root = await realpath(options.root);
    if (!(await lstat(root)).isDirectory())
        throw new Error('Project root must be a directory');
    const deadline = Date.now() + timeoutMs;
    const result: ProjectInventory = {
        projects: [],
        truncated: false,
        incomplete: false,
    };
    let entries = 0;
    const queue = [{ path: root, depth: 0 }];
    const expired = (): boolean => {
        options.signal?.throwIfAborted();
        if (Date.now() < deadline) return false;
        result.truncated = true;
        return true;
    };
    const git = async (
        path: string,
        args: string[]
    ): Promise<string | null> => {
        if (expired()) return null;
        try {
            const { stdout } = await exec(
                'git',
                [
                    '--no-optional-locks',
                    '-C',
                    path,
                    '-c',
                    'core.fsmonitor=false',
                    ...args,
                ],
                {
                    env: {
                        PATH: process.env.PATH,
                        SYSTEMROOT: process.env.SYSTEMROOT,
                        GIT_CONFIG_NOSYSTEM: '1',
                        GIT_CONFIG_GLOBAL: '/dev/null',
                        GIT_TERMINAL_PROMPT: '0',
                        GIT_OPTIONAL_LOCKS: '0',
                        LC_ALL: 'C',
                    },
                    encoding: 'utf8',
                    maxBuffer: 4096,
                    timeout: Math.max(1, Math.min(1500, deadline - Date.now())),
                    signal: options.signal,
                }
            );
            return stdout.trim();
        } catch {
            options.signal?.throwIfAborted();
            return null;
        }
    };
    for (let index = 0; index < queue.length; index++) {
        if (expired()) break;
        const current = queue[index];
        try {
            // Revalidate queued directories; never traverse a replaced symlink.
            if ((await lstat(current.path)).isSymbolicLink()) {
                result.incomplete = true;
                continue;
            }
            const canonical = await realpath(current.path);
            const rel = relative(root, canonical);
            if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
                result.incomplete = true;
                continue;
            }
            const marker = await lstat(resolve(current.path, '.git')).catch(
                () => undefined
            );
            if (marker) {
                // Linked worktrees and submodules need separate shared-gitdir admission.
                if (!marker.isDirectory() || marker.isSymbolicLink()) {
                    result.incomplete = true;
                    continue;
                }
                if (result.projects.length === maxProjects) {
                    result.truncated = true;
                    break;
                }
                const top = await git(current.path, [
                    'rev-parse',
                    '--show-toplevel',
                ]);
                if (
                    !top ||
                    (await realpath(top).catch(() => null)) !== canonical
                ) {
                    result.incomplete = true;
                    continue;
                }
                const remote = await git(current.path, [
                    'config',
                    '--local',
                    '--no-includes',
                    '--get',
                    'remote.origin.url',
                ]);
                const branch = await git(current.path, [
                    'symbolic-ref',
                    '--quiet',
                    '--short',
                    'HEAD',
                ]);
                const head = await git(current.path, [
                    'rev-parse',
                    '--verify',
                    'HEAD',
                ]);
                const path = rel.split(sep).join('/') || '.';
                result.projects.push({
                    id: `project-${createHash('sha256')
                        .update(path)
                        .digest('hex')
                        .slice(0, 32)}`,
                    path,
                    remote: remote ? projectRemote(remote) : null,
                    branch:
                        branch &&
                        branch.length <= 256 &&
                        !/[\x00-\x1f\x7f]/.test(branch)
                            ? branch
                            : null,
                    head:
                        head && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)
                            ? head
                            : null,
                });
                continue;
            }
            if (current.depth === maxDepth) {
                result.truncated = true;
                continue;
            }
            const directory = await opendir(current.path);
            for await (const entry of directory) {
                if (expired() || ++entries > maxEntries) {
                    result.truncated = true;
                    result.projects.sort((a, b) =>
                        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
                    );
                    return result;
                }
                if (
                    entry.isDirectory() &&
                    !entry.name.startsWith('.') &&
                    !skipped.has(entry.name)
                )
                    queue.push({
                        path: resolve(current.path, entry.name),
                        depth: current.depth + 1,
                    });
            }
        } catch {
            options.signal?.throwIfAborted();
            result.incomplete = true;
        }
    }
    result.projects.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    return result;
}
