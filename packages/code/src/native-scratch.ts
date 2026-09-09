import { constants as fsConstants } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import koffi from 'koffi';

import { removePrivateStorageAcl } from './private-storage.js';

const POSIX_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux']);
const lib = POSIX_PLATFORMS.has(process.platform) ? koffi.load(null) : undefined;
const openat = lib?.func('int openat(int dirfd, const char *path, int flags, uint32_t mode)');
const closeFd = lib?.func('int close(int fd)');
const fchmod = lib?.func('int fchmod(int fd, uint32_t mode)');
const fchmodat = lib?.func(
  'int fchmodat(int dirfd, const char *path, uint32_t mode, int flags)',
);
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x0020 : 0x0100;
const O_EVTONLY = 0x8000;
// Recovery is a last-resort shutdown path over an attacker-controlled tree.
// Keep both its memory use and its descriptor-relative reopen work bounded.
const MAX_SCRATCH_DIRECTORIES = 10_000;
const MAX_SCRATCH_ENTRIES = 100_000;
const MAX_SCRATCH_DEPTH = 128;
const MAX_SCRATCH_COMPONENT_VISITS = 16_384;
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

function requirePosixBindings(): void {
  if (!openat || !closeFd || !fchmod || !fchmodat) {
    throw new Error('Descriptor-relative scratch cleanup is unavailable');
  }
}

function ignoredEntryError(): boolean {
  return IGNORED_ENTRY_ERRNOS.has(koffi.errno());
}

function restoreEntryMode(directoryFd: number, name: string): boolean {
  requirePosixBindings();
  if (fchmodat!(directoryFd, name, 0o700, AT_SYMLINK_NOFOLLOW) === 0) return true;
  if (ignoredEntryError()) return false;
  throw new Error(`Descriptor-relative scratch chmod failed with errno ${koffi.errno()}`);
}

function openDirectoryAt(directoryFd: number, name: string): number | undefined {
  requirePosixBindings();
  const commonFlags = fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const repairFlags = process.platform === 'darwin'
    ? commonFlags | O_EVTONLY
    : commonFlags | fsConstants.O_RDONLY;
  const fd = openat!(directoryFd, name, repairFlags, 0);
  if (fd >= 0) return fd;
  if (ignoredEntryError()) return undefined;
  throw new Error(`Descriptor-relative scratch open failed with errno ${koffi.errno()}`);
}

function closeDirectory(fd: number): void {
  requirePosixBindings();
  if (closeFd!(fd) !== 0) {
    throw new Error(`Descriptor-relative scratch close failed with errno ${koffi.errno()}`);
  }
}

async function repairDirectory(fd: number, label: string): Promise<void> {
  requirePosixBindings();
  if (fchmod!(fd, 0o700) !== 0) {
    throw new Error(`Descriptor-relative scratch chmod failed with errno ${koffi.errno()}`);
  }
  await removePrivateStorageAcl({ fd }, label);
}

async function openRelativeDirectory(
  rootFd: number,
  components: string[],
  hooks: ScratchTraversalHooks,
  consumeComponentVisit: () => void,
): Promise<number | undefined> {
  let currentFd = rootFd;
  try {
    for (const component of components) {
      consumeComponentVisit();
      await hooks.afterEntryInspected?.(currentFd, component);
      if (!restoreEntryMode(currentFd, component)) {
        if (currentFd !== rootFd) {
          const closingFd = currentFd;
          currentFd = rootFd;
          closeDirectory(closingFd);
        }
        return undefined;
      }
      const childFd = openDirectoryAt(currentFd, component);
      if (currentFd !== rootFd) {
        const closingFd = currentFd;
        currentFd = rootFd;
        closeDirectory(closingFd);
      }
      if (childFd === undefined) return undefined;
      currentFd = childFd;
      await repairDirectory(currentFd, `scratch directory ${components.join('/')}`);
    }
    return currentFd;
  } catch (error) {
    if (currentFd !== rootFd) closeDirectory(currentFd);
    throw error;
  }
}

/**
 * Restores traversal without resolving worker-controlled descendants through
 * ambient paths. Relative component lists retain no descriptors; reopening a
 * path holds at most two descriptors and refuses replacement symlinks.
 */
export async function restoreScratchTraversal(
  root: FileHandle,
  hooks: ScratchTraversalHooks = {},
): Promise<void> {
  await root.chmod(0o700);
  await removePrivateStorageAcl(root, 'native sandbox scratch root');
  const pending: string[][] = [[]];
  let componentVisits = 0;
  const consumeComponentVisit = () => {
    componentVisits += 1;
    if (componentVisits > MAX_SCRATCH_COMPONENT_VISITS) {
      throw new Error('Native sandbox scratch cleanup exceeded its work limit');
    }
  };
  let entriesInspected = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const components = pending[index];
    const directoryFd = components.length === 0
      ? root.fd
      : await openRelativeDirectory(
          root.fd,
          components,
          hooks,
          consumeComponentVisit,
        );
    if (directoryFd === undefined) continue;
    try {
      const directory = await opendir(descriptorPath(directoryFd));
      for await (const entry of directory) {
        entriesInspected += 1;
        if (entriesInspected > MAX_SCRATCH_ENTRIES) {
          throw new Error('Native sandbox scratch cleanup exceeded its entry limit');
        }
        if (!entry.isDirectory()) continue;
        if (components.length >= MAX_SCRATCH_DEPTH) {
          throw new Error('Native sandbox scratch cleanup exceeded its depth limit');
        }
        if (pending.length >= MAX_SCRATCH_DIRECTORIES) {
          throw new Error('Native sandbox scratch cleanup exceeded its directory limit');
        }
        pending.push([...components, entry.name]);
      }
    } finally {
      if (directoryFd !== root.fd) closeDirectory(directoryFd);
    }
  }
}
