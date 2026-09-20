import { constants, close, fstat, read } from 'node:fs';
import { mkdir, open, opendir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import type { WorkspaceRootIdentity } from './root-identity.js';

const closeFd = promisify(close);
const statFd = promisify(fstat);
const readFd = promisify(read);
let binding:
  | Promise<{
      openat: (fd: number, name: string, flags: number) => number;
      errno: () => number;
    }>
  | undefined;

async function childFd(
  parent: number,
  name: string
): Promise<number | undefined> {
  if (!name || name === '.' || name === '..' || name.includes('/'))
    throw new Error('Invalid Git metadata entry');
  binding ??= import('koffi').then(({ default: koffi }) => ({
    openat: koffi
      .load(null)
      .func('int openat(int dirfd, const char *path, int flags)'),
    errno: () => koffi.errno(),
  }));
  const native = await binding;
  // Node does not expose O_CLOEXEC. Set it atomically with openat so unrelated
  // concurrent executor spawns cannot inherit privileged source descriptors.
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Git snapshots require a POSIX host');
  const closeOnExec = process.platform === 'darwin' ? 0x1000000 : 0x80000;
  const fd = native.openat(
    parent,
    name,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      closeOnExec
  );
  if (fd >= 0) return fd;
  if (native.errno() === 2) return undefined; // ENOENT on supported POSIX hosts
  throw new Error('Git metadata entry is unavailable or is a symbolic link');
}

async function withDirectory<T>(
  identity: WorkspaceRootIdentity,
  operation: (fd: number) => Promise<T>
): Promise<T> {
  const handle = await open(
    identity.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const current = await handle.stat({ bigint: true });
    if (
      current.dev.toString() !== identity.dev ||
      current.ino.toString() !== identity.ino
    ) {
      throw new Error('Source Git metadata changed after admission');
    }
    return await operation(handle.fd);
  } finally {
    await handle.close();
  }
}

async function textAt(
  parent: number,
  name: string,
  limit = 16 * 1024
): Promise<string | undefined> {
  const fd = await childFd(parent, name);
  if (fd == null) return undefined;
  try {
    const metadata = await statFd(fd);
    if (!metadata.isFile() || metadata.size > limit)
      throw new Error('Invalid Git metadata file');
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await readFd(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!bytesRead) throw new Error('Git metadata changed during snapshot');
      offset += bytesRead;
    }
    return buffer.toString('utf8');
  } finally {
    await closeFd(fd);
  }
}

async function alternatesAt(parent: number): Promise<string | undefined> {
  const fd = await childFd(parent, 'info');
  if (fd == null) return undefined;
  try {
    if (!(await statFd(fd)).isDirectory())
      throw new Error('Invalid Git objects info directory');
    return await textAt(fd, 'alternates');
  } finally {
    await closeFd(fd);
  }
}

/** Copies only regular files/directories through descriptor-relative, no-follow opens.
 * Renaming a parent or replacing a child with a symlink never expands the read grant.
 * No source config, hooks, object alternates, or executable helpers reach Git.
 */
async function copyEntry(
  parent: number,
  name: string,
  destination: string,
  signal: AbortSignal | undefined,
  depth = 0
): Promise<void> {
  signal?.throwIfAborted();
  if (depth > 64)
    throw new Error('Git metadata nesting exceeds snapshot limit');
  const fd = await childFd(parent, name);
  if (fd == null) return;
  try {
    const metadata = await statFd(fd);
    if (metadata.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const directory = await opendir(`/dev/fd/${fd}`);
      for await (const entry of directory) {
        await copyEntry(
          fd,
          entry.name,
          join(destination, entry.name),
          signal,
          depth + 1
        );
      }
    } else if (metadata.isFile()) {
      const target = await open(destination, 'w', 0o600);
      try {
        const buffer = Buffer.alloc(128 * 1024);
        let offset = 0;
        while (offset < metadata.size) {
          signal?.throwIfAborted();
          const { bytesRead } = await readFd(
            fd,
            buffer,
            0,
            Math.min(buffer.length, metadata.size - offset),
            offset
          );
          if (!bytesRead)
            throw new Error('Git metadata changed during snapshot');
          await target.writeFile(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally {
        await target.close();
      }
    } else {
      throw new Error('Git snapshot requires regular files and directories');
    }
  } finally {
    await closeFd(fd);
  }
}

export class GitSourceSnapshot {
  private constructor(
    private readonly source: WorkspaceRootIdentity,
    private readonly gitDirectory: WorkspaceRootIdentity,
    private readonly common: WorkspaceRootIdentity,
    private readonly gitfile: string | undefined,
    private readonly commondir: string | undefined,
    private readonly objects: Array<{
      identity: WorkspaceRootIdentity;
      alternates: string | undefined;
    }>
  ) {}

  get fingerprint(): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.gitDirectory,
          this.common,
          this.gitfile,
          this.commondir,
          this.objects,
        ])
      )
      .digest('hex');
  }

  static async admit(
    source: WorkspaceRootIdentity
  ): Promise<GitSourceSnapshot> {
    let gitfile: string | undefined;
    await withDirectory(source, async (fd) => {
      const git = await childFd(fd, '.git');
      if (git == null)
        throw new Error('Source workspace is not a Git repository');
      try {
        if (!(await statFd(git)).isDirectory())
          gitfile = await textAt(fd, '.git');
      } finally {
        await closeFd(git);
      }
    });
    if (gitfile != null && !/^gitdir: .+\n?$/.test(gitfile))
      throw new Error('Invalid source Git directory pointer');
    const gitDirectory = await captureWorkspaceRootIdentity(
      gitfile == null
        ? join(source.path, '.git')
        : resolve(source.path, gitfile.slice(8).trim())
    );
    const commondir = await withDirectory(gitDirectory, (fd) =>
      textAt(fd, 'commondir')
    );
    const common =
      commondir == null
        ? gitDirectory
        : await captureWorkspaceRootIdentity(
            resolve(gitDirectory.path, commondir.trim())
          );
    const objects: Array<{
      identity: WorkspaceRootIdentity;
      alternates: string | undefined;
    }> = [];
    const visit = async (path: string): Promise<void> => {
      const identity = await captureWorkspaceRootIdentity(path);
      if (objects.some((entry) => entry.identity.path === identity.path))
        return;
      if (objects.length >= 32)
        throw new Error('Too many source Git object stores');
      const alternates = await withDirectory(identity, alternatesAt);
      objects.push({ identity, alternates });
      for (const alternate of alternates?.split('\n').filter(Boolean) ?? []) {
        if (alternate.startsWith('"'))
          throw new Error('Quoted Git alternate paths are unsupported');
        await visit(resolve(identity.path, alternate));
      }
    };
    await visit(join(common.path, 'objects'));
    const admitted = new GitSourceSnapshot(
      source,
      gitDirectory,
      common,
      gitfile,
      commondir,
      objects
    );
    await admitted.validate();
    return admitted;
  }

  async validate(): Promise<void> {
    await withDirectory(this.source, async (fd) => {
      if (this.gitfile != null) {
        if ((await textAt(fd, '.git')) !== this.gitfile)
          throw new Error('Source Git metadata changed after admission');
      } else {
        // Compare the directory reached from the admitted root, not just its name.
        const child = await childFd(fd, '.git');
        if (child == null)
          throw new Error('Source Git metadata changed after admission');
        try {
          const current = await promisify(fstat)(child, {
            bigint: true,
          });
          if (
            current.dev.toString() !== this.gitDirectory.dev ||
            current.ino.toString() !== this.gitDirectory.ino
          ) {
            throw new Error('Source Git metadata changed after admission');
          }
        } finally {
          await closeFd(child);
        }
      }
    });
    await withDirectory(this.gitDirectory, async (fd) => {
      if ((await textAt(fd, 'commondir')) !== this.commondir)
        throw new Error('Source Git metadata changed after admission');
    });
    await withDirectory(this.common, async () => {});
    for (const entry of this.objects) {
      await withDirectory(entry.identity, async (fd) => {
        if ((await alternatesAt(fd)) !== entry.alternates)
          throw new Error('Source Git alternates changed after admission');
      });
    }
  }

  async copyTo(destination: string, signal?: AbortSignal): Promise<void> {
    await this.validate();
    await mkdir(destination, { mode: 0o700 });
    await mkdir(join(destination, 'objects'), { mode: 0o700 });
    await mkdir(join(destination, 'refs'), { mode: 0o700 });
    await withDirectory(this.gitDirectory, (fd) =>
      copyEntry(fd, 'HEAD', join(destination, 'HEAD'), signal)
    );
    await withDirectory(this.common, async (fd) => {
      for (const name of ['refs', 'packed-refs', 'shallow'])
        await copyEntry(fd, name, join(destination, name), signal);
      // Kept outside Git's config name; caller may query origin with --no-includes.
      const config = await textAt(fd, 'config', 1024 * 1024);
      if (config != null)
        await writeFile(join(destination, 'source-config'), config, {
          mode: 0o600,
        });
    });
    for (const entry of [...this.objects].reverse()) {
      await withDirectory(entry.identity, async (fd) => {
        const directory = await opendir(`/dev/fd/${fd}`);
        for await (const child of directory) {
          // Object info (notably alternates) never crosses into private staging.
          if (child.name === 'pack' || /^[a-f0-9]{2}$/.test(child.name)) {
            await copyEntry(
              fd,
              child.name,
              join(destination, 'objects', child.name),
              signal
            );
          }
        }
      });
    }
    await writeFile(
      join(destination, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = true\n',
      { mode: 0o600 }
    );
    await this.validate();
    signal?.throwIfAborted();
  }
}
