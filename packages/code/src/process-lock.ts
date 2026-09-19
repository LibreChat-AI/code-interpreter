import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import koffi from 'koffi';

const lib = koffi.load(null);
const flock = lib.func('int flock(int fd, int operation)');
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Process-lifetime advisory lock; the kernel releases it on crash or restart. */
export async function withProcessLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Conversation worktree locking requires a POSIX host');
  }
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (;;) {
      if (flock(handle.fd, LOCK_EX | LOCK_NB) === 0) break;
      const errno = koffi.errno();
      if (errno !== koffi.os.errno.EAGAIN) {
        throw new Error(`Conversation worktree lock failed with errno ${errno}`);
      }
      await delay(50);
    }
    return await operation();
  } finally {
    flock(handle.fd, LOCK_UN);
    await handle.close();
  }
}
