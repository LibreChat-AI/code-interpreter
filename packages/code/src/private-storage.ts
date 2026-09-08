import { lstat, open, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { BridgeProtocolError } from './protocol.js';

/** Linux exposes POSIX ACL masks in mode bits; macOS needs native ACL calls. */
export function assertPrivateStorageSupported(): void {
  if (!['linux', 'darwin'].includes(process.platform) || process.getuid === undefined) {
    throw new BridgeProtocolError(
      'Owner-only storage ACL verification is unavailable on this platform. ' +
      'Native Windows is unsupported until DACL removal and verification are implemented. ' +
      'Use macOS or Linux (including WSL2 with a native Linux filesystem, not /mnt).',
    );
  }
}

async function macOsStorage() {
  try {
    return await import('./macos-storage.js');
  } catch {
    throw new BridgeProtocolError('macOS ACL verification is unavailable: reinstall @librechat/code with its Koffi native dependency.');
  }
}

export async function assertPrivateStorageAcl(
  handle: FileHandle, path: string, directory = false,
): Promise<void> {
  if (process.platform === 'darwin') {
    (await macOsStorage()).verifyMacOsAcl(handle.fd, path, directory);
  }
}

/** Only application-owned files/directories may have their ACLs removed. */
export async function removePrivateStorageAcl(handle: FileHandle, path: string): Promise<void> {
  if (process.platform === 'darwin') {
    (await macOsStorage()).removeMacOsAcl(handle.fd, path);
  }
}

/**
 * Walk from the trust root before touching a descendant. Checking only a
 * canonical parent misses replaceable ancestors and symlink entries. Resolve
 * links one component at a time so even intermediate link targets are checked.
 * Other local accounts cannot replace a checked entry: its parent is either
 * non-writable or sticky and the entry belongs to this account or root.
 */
export async function assertPrivateStorageAncestors(
  path: string,
  allowMissing = false,
): Promise<void> {
  assertPrivateStorageSupported();
  const uid = process.getuid!();
  let current = '/';
  const pending = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split('/');
  let links = 0;
  while (true) {
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata === undefined) return;
    if (metadata.uid !== uid && metadata.uid !== 0) {
      throw new BridgeProtocolError(
        `${current} is owned by another account (uid ${metadata.uid}), ` +
          `which can replace ${path}. Keep worker storage on paths this account or root owns.`,
      );
    }
    if (metadata.isSymbolicLink()) {
      if (++links > 40) throw new BridgeProtocolError(`Too many storage symlinks: ${path}`);
      const target = await readlink(current);
      current = isAbsolute(target) ? '/' : dirname(current);
      pending.unshift(...target.split('/'));
      continue;
    }
    if (metadata.isDirectory()) {
      if (process.platform === 'darwin') {
        const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
            throw new BridgeProtocolError(`Storage directory changed during ACL verification: ${current}`);
          }
          await assertPrivateStorageAcl(handle, current, true);
        } finally {
          await handle.close();
        }
      }
      const mode = metadata.mode & 0o7777;
      if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
        throw new BridgeProtocolError(
          `Directory ${current} is writable by other accounts (mode ${mode.toString(8)}), ` +
            `so ${path} can be replaced even while owner-only.`,
        );
      }
    } else if (pending.some((part) => part !== '' && part !== '.')) {
      throw new BridgeProtocolError(`Storage ancestor must be a directory: ${current}`);
    }
    let next = pending.shift();
    while (next === '' || next === '.') next = pending.shift();
    if (next === undefined) return;
    current = next === '..' ? dirname(current) : `${current === '/' ? '' : current}/${next}`;
  }
}
