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

/** This guards accidental `git` calls, not absolute executable paths or caller shell aliases. */
export async function writeLinkedWorktreeGitGuard(directory: string): Promise<void> {
  try {
    await access('/bin/bash', fsConstants.X_OK);
  } catch {
    throw new WorkspaceToolError('Linked worktree Git guard requires /bin/bash', 'COMMAND_UNAVAILABLE');
  }
  const git = await systemGitExecutable();
  const quotedGit = `'${git.replaceAll("'", "'\\''")}'`;
  const script = [
    // Bash arrays preserve global option arguments when checking the same
    // effective Git configuration without eval or interpreting alias contents.
    '#!/bin/bash',
    'check() {',
    '  local -a globals=() forwarded=()',
    '  local aliasStatus=0',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    '      -C|-c|--git-dir|--work-tree|--namespace|--config-env)',
    '        if [ "$#" -lt 2 ]; then echo "git: missing global option argument" >&2; return 2; fi',
    '        globals+=("$1" "$2"); forwarded+=("$1" "$2"); shift 2 ;;',
    '      -C?*|-c?*|--git-dir=*|--work-tree=*|--namespace=*|--config-env=*)',
    '        globals+=("$1"); forwarded+=("$1"); shift ;;',
    '      --bare)',
    '        globals+=("$1"); forwarded+=("$1"); shift ;;',
    '      -p|-P|--paginate|--no-pager|--no-replace-objects|--no-optional-locks|--exec-path=*)',
    '        forwarded+=("$1"); shift ;;',
    '      --literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)',
    '        forwarded+=("$1"); shift ;;',
    '      --) forwarded+=("$1"); shift; break ;;',
    '      -v|--version|-h|--help|--exec-path|--html-path|--man-path|--info-path)',
    '        return 0 ;;',
    '      -*) echo "git: unsupported global option in linked worktree lane" >&2; return 2 ;;',
    '      *) break ;;',
    '    esac',
    '  done',
    '  case "${1:-}" in',
    '    worktree)',
    '      if [ "${2:-}" != list ]; then',
    '        echo "git: worktree registration changes require checkout admission or the lifecycle API" >&2',
    '        return 1',
    '      fi ;;',

    '    prune|gc|repack|prune-packed|maintenance|multi-pack-index|for-each-repo)',
    '      echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '      return 1 ;;',
    '    fetch|pull)',
    '      for option in "${@:2}"; do',
    '        case "$option" in',
    '          --auto-maintenance|--auto-maintenance=*|--auto-gc|--auto-gc=*)',
    '            echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '            return 1 ;;',
    '        esac',
    '      done ;;',
    '    lfs)',
    '      if [ "${2:-}" = prune ]; then',
    '        echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '        return 1',
    '      fi',
    '      if [ "${2:-}" = fetch ] || [ "${2:-}" = pull ]; then',
    '        for option in "${@:3}"; do',
    '          case "$option" in',
    '            --prune|--prune=*|-p|-p?*|-[!-]*p*)',
    '              echo "git: run storage maintenance from the checkout, not a linked worktree lane" >&2',
    '              return 1 ;;',
    '          esac',
    '        done',
    '      fi ;;',
    '  esac',
    '  if [ "$#" -eq 0 ]; then return 0; fi',
    // Git itself loads local config, -C, -c, includes and --config-env, so an
    // alias from any of those sources is rejected even when it hides a prune.
    // Reject all aliases, including harmless ones: Git shell aliases and nested
    // aliases cannot be proven safe by inspecting the first token.
    `  ${quotedGit} "\${globals[@]}" config --get "alias.\${1}" >/dev/null 2>&1 || aliasStatus=$?`,
    '  case "$aliasStatus" in',
    '    0) echo "git: Git aliases are unavailable in linked worktree lanes; run the underlying command or use the checkout" >&2; return 1 ;;',
    '    1) ;;',
    '    *) echo "git: cannot verify Git aliases in linked worktree lane" >&2; return 2 ;;',
    '  esac',
    // Command-line -c values override both Git config files and GIT_CONFIG_COUNT.
    // Add these after every caller global option: fetch can start maintenance
    // internally without invoking the PATH guard a second time.
    `  exec ${quotedGit} "\${forwarded[@]}" -c maintenance.auto=false -c gc.auto=0 -c help.autocorrect=0 "$@"`,
    '}',
    'check "$@" || exit "$?"',
    `exec ${quotedGit} "$@"`,
    '',
  ].join('\n');
  await writeFile(join(directory, 'git'), script, { flag: 'wx', mode: 0o500 });
  await access(join(directory, 'git'), fsConstants.X_OK);
}
