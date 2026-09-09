import { constants as fsConstants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import koffi from 'koffi';

const lib = process.platform === 'darwin'
  ? koffi.load('/usr/lib/libSystem.B.dylib')
  : process.platform === 'linux'
    ? koffi.load('libc.so.6')
    : undefined;
const fchmodat = lib?.func(
  'int fchmodat(int dirfd, const char *path, uint32_t mode, int flags)',
);
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x0020 : 0x0100;
const IGNORED_ENTRY_ERRNOS = new Set([
  koffi.os.errno.ENOENT,
  koffi.os.errno.ELOOP,
  koffi.os.errno.ENOTDIR,
  koffi.os.errno.ENOTSUP,
]);

export interface ScratchTraversalHooks {
  /** Test seam for deterministic replacement-race coverage. */
  afterEntryInspected?(directoryFd: number, name: string): Promise<void>;
}

function descriptorPath(fd: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
}

function restoreEntryMode(directoryFd: number, name: string): boolean {
  if (!fchmodat) {
    throw new Error('Descriptor-relative scratch cleanup is unavailable');
  }
  if (fchmodat(directoryFd, name, 0o700, AT_SYMLINK_NOFOLLOW) === 0) {
    return true;
  }
  const errno = koffi.errno();
  if (IGNORED_ENTRY_ERRNOS.has(errno)) return false;
  const error = new Error(
    `Descriptor-relative scratch chmod failed with errno ${errno}`,
  ) as NodeJS.ErrnoException;
  error.errno = errno;
  throw error;
}

/** Restores traversal without resolving a worker-controlled descendant through an ambient path. */
export async function restoreScratchTraversal(
  root: FileHandle,
  hooks: ScratchTraversalHooks = {},
): Promise<void> {
  await root.chmod(0o700);
  const entries = await readdir(descriptorPath(root.fd), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await hooks.afterEntryInspected?.(root.fd, entry.name);
    if (!restoreEntryMode(root.fd, entry.name)) continue;
    let child: FileHandle | undefined;
    try {
      child = await open(
        `${descriptorPath(root.fd)}/${entry.name}`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      if (!(await child.stat()).isDirectory()) continue;
      await restoreScratchTraversal(child, hooks);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(code ?? '')) throw error;
    } finally {
      await child?.close();
    }
  }
}
