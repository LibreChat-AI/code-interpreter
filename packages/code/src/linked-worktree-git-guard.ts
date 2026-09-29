import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { WorkspaceToolError } from './workspace.js';

// Match the system-only executable search used for native programmatic tools.
const GIT_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/home/linuxbrew/.linuxbrew/bin',
];
const TRUSTED_GIT_DIRS = [
  ...GIT_BIN_DIRS,
  '/opt/homebrew/Cellar',
  '/usr/local/Cellar',
  '/home/linuxbrew/.linuxbrew/Cellar',
  '/usr/lib/git-core',
];

async function systemGitExecutable(): Promise<string> {
  for (const directory of GIT_BIN_DIRS) {
    try {
      const executable = await realpath(join(directory, 'git'));
      if (!TRUSTED_GIT_DIRS.some(path => executable.startsWith(`${path}${sep}`))) continue;
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, fsConstants.X_OK);
      return executable;
    } catch {
      // A missing system installation is not a reason to run Git from the workspace or PATH.
    }
  }
  throw new WorkspaceToolError('Trusted Git executable is unavailable for linked worktree lanes', 'COMMAND_UNAVAILABLE');
}

/** This guards accidental `git` calls, not absolute executable paths or shell aliases. */
export async function writeLinkedWorktreeGitGuard(directory: string): Promise<void> {
  const git = await systemGitExecutable();
  const quotedGit = `'${git.replaceAll("'", "'\\''")}'`;
  const script = [
    '#!/bin/sh',
    'check() {',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    '      -C|-c|--git-dir|--work-tree|--namespace|--config-env)',
    '        if [ "$#" -lt 2 ]; then echo "git: missing global option argument" >&2; return 2; fi',
    '        shift 2 ;;',
    '      -C?*|-c?*|--git-dir=*|--work-tree=*|--namespace=*|--config-env=*|--exec-path=*)',
    '        shift ;;',
    '      -p|-P|--paginate|--no-pager|--no-replace-objects|--bare|--no-optional-locks)',
    '        shift ;;',
    '      --) shift; break ;;',
    '      -v|--version|-h|--help|--exec-path|--html-path|--man-path|--info-path)',
    '        return 0 ;;',
    '      -*) echo "git: unsupported global option in linked worktree lane" >&2; return 2 ;;',
    '      *) break ;;',
    '    esac',
    '  done',
    '  case "${1:-}" in',
    '    prune|gc|repack|prune-packed|maintenance|multi-pack-index)',
    '      echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '      return 1 ;;',
    '    lfs)',
    '      if [ "${2:-}" = prune ]; then',
    '        echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '        return 1',
    '      fi ;;',
    '  esac',
    '}',
    'check "$@" || exit "$?"',
    `exec ${quotedGit} "$@"`,
    '',
  ].join('\n');
  await writeFile(join(directory, 'git'), script, { flag: 'wx', mode: 0o500 });
  await access(join(directory, 'git'), fsConstants.X_OK);
}
