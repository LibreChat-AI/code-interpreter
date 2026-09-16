import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { discoverProjects } from './projects.js';
import { matchesWorkspaceRoot } from './root-identity.js';
import type { LocalWorkspaceConfig } from './workspace.js';

/** Explicit operator selections, not an automatically expanding execution grant. */
export async function loadProjectRoots(
    directory: string,
    selections: string[]
): Promise<LocalWorkspaceConfig[]> {
    if (!selections.length || selections.length > 32)
        throw new Error('Choose between 1 and 32 projects');
    const root = await realpath(directory);
    const paths = new Set<string>();
    const projects: LocalWorkspaceConfig[] = [];
    for (const selection of selections) {
        if (!selection || isAbsolute(selection) || selection.includes('\0'))
            throw new Error('Project paths must be relative to --project-root');
        const path = resolve(root, selection);
        const rel = relative(root, path);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new Error('Project paths must stay inside --project-root');
        const canonical = await realpath(path);
        const directoryIdentity = await lstat(path);
        if (canonical !== path || !directoryIdentity.isDirectory())
            throw new Error(
                'Selected projects must be directories without symlink traversal'
            );
        if (paths.has(canonical))
            throw new Error('Duplicate project selection');
        paths.add(canonical);
        const commonDirectory = await lstat(
            resolve(canonical, '.git', 'commondir')
        ).catch(error => {
            if (
                !(error instanceof Error) ||
                !('code' in error) ||
                (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
            )
                throw error;
            return undefined;
        });
        if (commonDirectory)
            throw new Error(
                'Selected projects must not share a Git common directory'
            );
        const inventory = await discoverProjects({
            root: canonical,
            maxProjects: 1,
        });
        if (
            inventory.truncated ||
            !inventory.projects.some(project => project.path === '.')
        )
            throw new Error(
                'Select a standalone Git checkout, not a parent directory or linked worktree'
            );
        const portablePath = rel.split(sep).join('/') || '.';
        const identity = {
            path: canonical,
            dev: directoryIdentity.dev,
            ino: directoryIdentity.ino,
        };
        if (!(await matchesWorkspaceRoot(canonical, identity)))
            throw new Error('Selected project changed during admission');
        projects.push({
            identity,
            id: `project-${createHash('sha256')
                .update(`${root}\0${portablePath}`)
                .digest('hex')
                .slice(0, 32)}`,
            name: (portablePath === '.' ? basename(root) : portablePath).slice(
                0,
                64
            ),
            root: canonical,
        });
    }
    return projects;
}

export function projectRootArguments(
    args: string[]
): { root: string; projects: string[] } | undefined {
    let root: string | undefined;
    const projects: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const flag = arg.split('=')[0];
        if (flag !== '--project-root' && flag !== '--project') continue;
        const value = arg.includes('=')
            ? arg.slice(flag.length + 1)
            : args[++index];
        if (!value || value.startsWith('--'))
            throw new Error(`${flag} requires a value`);
        if (flag === '--project') projects.push(value);
        else {
            if (root !== undefined)
                throw new Error('Only one --project-root may be supplied');
            root = value;
        }
    }
    if (root === undefined && !projects.length) return undefined;
    if (root === undefined || !projects.length)
        throw new Error(
            '--project-root requires at least one --project relative/path'
        );
    return { root, projects };
}
