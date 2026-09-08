import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { BridgeProtocolError } from './protocol.js';

const MOUNTINFO_MAX_BYTES = 4 * 1024 * 1024;

/** mountinfo describes this process's namespace, including same-device bind mounts. */
export function identityIsMountPoint(mountinfo: string, entryPath: string): boolean {
  const lines = mountinfo.trimEnd().split('\n');
  let mounted = false;
  for (const line of lines) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    const mountpoint = fields[4];
    if (
      separator < 6 || fields.length !== separator + 4 ||
      !/^\d+$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[1] ?? '') ||
      !/^\d+:\d+$/.test(fields[2] ?? '') || !mountpoint?.startsWith('/') ||
      /\\(?!040|011|012|134)/.test(mountpoint)
    ) throw new BridgeProtocolError('Cannot verify identity mount status: malformed /proc/self/mountinfo');
    const decoded = mountpoint.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (decoded === entryPath) mounted = true;
  }
  return mounted;
}

export async function assertIdentityIsNotMountPoint(path: string): Promise<void> {
  // Resolve the parent, not the leaf: rename replaces a leaf symlink itself.
  const entryPath = join(await realpath(dirname(path)), basename(path));
  if (process.platform === 'darwin') {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    // A missing entry cannot be mounted; rename replaces a symlink itself.
    if (metadata === undefined || metadata.isSymbolicLink()) return;
    const { macOsMountPoint } = await import('./macos-storage.js');
    if (await realpath(macOsMountPoint(entryPath)) === entryPath) {
      throw new BridgeProtocolError(`Bridge identity path ${path} is a mount point and cannot be atomically replaced.`);
    }
    return;
  }
  let content: string;
  try {
    const handle = await open('/proc/self/mountinfo', 'r');
    try {
      const buffer = Buffer.alloc(MOUNTINFO_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MOUNTINFO_MAX_BYTES) throw new Error('mount table exceeds limit');
      content = buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  } catch {
    throw new BridgeProtocolError(
      'Cannot verify identity mount status: /proc/self/mountinfo must be readable ' +
        'and no larger than 4 MiB. Use an environment with procfs available.',
    );
  }
  if (identityIsMountPoint(content, entryPath)) {
    throw new BridgeProtocolError(
      `Bridge identity path ${path} is a mount point and cannot be atomically replaced. ` +
        'Mount its containing directory instead, or choose an unmounted identity file.',
    );
  }
}
