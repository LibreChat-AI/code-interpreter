import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
let binding:
  | Promise<{
      flock: (fd: number, operation: number) => number;
      eagain: number;
      errno: () => number;
    }>
  | undefined;

async function lockBinding() {
  binding ??= import('koffi').then(({ default: koffi }) => ({
    flock: koffi.load(null).func('int flock(int fd, int operation)'),
    eagain: koffi.os.errno.EAGAIN,
    errno: () => koffi.errno(),
  }));
  return await binding;
}

/** Process-lifetime advisory lock; the kernel releases it on crash or restart. */
export async function withProcessLock<T>(
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Conversation worktree locking requires a POSIX host');
  }
  const native = await lockBinding();
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  );
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (native.flock(handle.fd, LOCK_EX | LOCK_NB) === 0) break;
      const errno = native.errno();
      if (errno !== native.eagain) {
        throw new Error(
          `Conversation worktree lock failed with errno ${errno}`
        );
      }
      await delay(50, undefined, { signal });
    }
    signal?.throwIfAborted();
    return await operation();
  } finally {
    native.flock(handle.fd, LOCK_UN);
    await handle.close();
  }
}
