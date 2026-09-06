import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { BRIDGE_PROTOCOL_VERSION, BridgeProtocolError } from './protocol.js';

import type { PairedBridgeWorkerIdentity } from './pairing.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPairedIdentity(value: unknown): value is PairedBridgeWorkerIdentity {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === BRIDGE_PROTOCOL_VERSION &&
    typeof value.workerId === 'string' &&
    typeof value.codeApiUrl === 'string' &&
    typeof value.credential === 'string' &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.publicKey === 'string' &&
    typeof value.privateKey === 'string'
  );
}

export function defaultBridgeIdentityPath(workerId: string): string {
  const readableName = workerId.replace(/[^A-Za-z0-9._-]/g, '_');
  const fileName =
    readableName === workerId
      ? readableName
      : `${readableName}-${createHash('sha256')
          .update(workerId)
          .digest('hex')
          .slice(0, 16)}`;
  return join(homedir(), '.config', 'librechat', 'code', `${fileName}.json`);
}

function workspaceStorageName(value: string): string {
  return `id-${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDeploymentUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && 'code' in error && error.code === 'ENOENT';
}

async function ensureDurableDirectory(path: string): Promise<void> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new BridgeProtocolError(
          `Workspace quarantine parent must be a directory: ${current}`,
        );
      }
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) {
    await syncParentDirectory(created);
  }
}

export interface DefaultWorkspacePathOptions {
  codeApiUrl: string;
  securityIdentity: string;
  workerId: string;
  workspaceId: string;
  homeDirectory?: string;
}

export interface WorkspaceMutationQuarantineRecord {
  version: 1;
  workerId: string;
  workspaceId: string;
  ownerId?: string;
  quarantinedAt: string;
  reason: string;
}

export interface DefaultWorkspaceQuarantinePathOptions {
  codeApiUrl: string;
  workerId: string;
  workspaceRoot: string;
  homeDirectory?: string;
}

export function defaultWorkspacePath({
  codeApiUrl,
  securityIdentity,
  workerId,
  workspaceId,
  homeDirectory = homedir(),
}: DefaultWorkspacePathOptions): string {
  const deploymentIdentity = `${codeApiUrl.replace(/\/+$/, '')}\0${securityIdentity}`;
  return join(
    homeDirectory,
    '.local',
    'share',
    'librechat',
    'code',
    'workspaces',
    workspaceStorageName(deploymentIdentity),
    workspaceStorageName(workerId),
    workspaceStorageName(workspaceId),
  );
}

export function defaultWorkspaceQuarantinePath(
  options: DefaultWorkspaceQuarantinePathOptions,
): string {
  return join(
    options.homeDirectory ?? homedir(),
    '.local',
    'state',
    'librechat',
    'code',
    'quarantines',
    workspaceStorageName(canonicalDeploymentUrl(options.codeApiUrl)),
    workspaceStorageName(options.workerId),
    `${workspaceStorageName(resolve(options.workspaceRoot))}.json`,
  );
}

/**
 * Verify a path really is owner-only. `chmod` reports success without effect on
 * mounts that do not implement POSIX permissions - notably WSL2 DrvFs
 * (`/mnt/<drive>`), where the result stays world-accessible - so a credential
 * that cannot be protected must fail closed rather than appear protected.
 *
 * Symlinks are resolved: a link's own mode is always `0777` and ignored by the
 * kernel, so the file the bytes live in is what counts.
 *
 * This reads POSIX mode bits, which is not the whole access story everywhere.
 * A Linux POSIX ACL surfaces its mask in the group bits and so is caught, but
 * a macOS extended ACL inherited from the parent directory is invisible here
 * and survives `chmod`, and Windows is exempt entirely. Establishing owner-only
 * storage on those needs real ACL inspection; until then this verifies what the
 * mode can express and nothing more.
 */
async function groupOrOtherAccessMode(
  path: string,
): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  /* Resolve symlinks: the bytes live at the target, and a link's own mode is
   * always 0777 and ignored by the kernel. */
  const mode = (await stat(path)).mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : mode;
}

/**
 * A `0600` file in a directory other accounts can write is not owner-only in
 * practice: they cannot read it, but they can unlink and substitute it, so a
 * swapped credential or a forged quarantine marker would be trusted. The sticky
 * bit counts as protection, which keeps shared `/tmp`-style parents usable. A
 * writable ancestor above a private directory could still have that directory
 * renamed out from under us, which is broader hardening than this addresses.
 *
 * Deliberately not applied to the registered workspace, which is the user's own
 * project directory and may legitimately be shared.
 */
async function assertDirectoryNotSharedWritable(
  directory: string,
  path: string,
): Promise<void> {
  const metadata = await stat(directory);
  const mode = metadata.mode & 0o7777;
  const uid = process.getuid?.();
  if (uid !== undefined && !isTrustedOwner(metadata.uid, uid)) {
    throw new BridgeProtocolError(
      `Directory ${directory} is owned by another account (uid ${metadata.uid}), ` +
        `which can grant itself write access and replace ${path}. Keep worker ` +
        'credentials in a directory this account owns.',
    );
  }
  if ((mode & 0o022) === 0) return;
  if ((mode & 0o1000) !== 0 && (metadata.uid === uid || metadata.uid === 0)) {
    return;
  }
  throw new BridgeProtocolError(
    `Directory ${directory} is writable by other accounts (mode ${mode.toString(8)}), ` +
      `so ${path} can be replaced even while owner-only. Keep worker credentials ` +
      'in a directory only this account can write.',
  );
}

/** Publishing goes through `rename`, which replaces the named entry itself. */
async function assertWriteContainerPrivate(path: string): Promise<void> {
  if (process.platform === 'win32' || process.getuid === undefined) return;
  await assertDirectoryNotSharedWritable(await realpath(dirname(path)), path);
}

/**
 * Reading follows the link, so both the entry and the file it names are trust
 * boundaries: a writable directory at either end allows a substitution.
 */
async function assertReadPathPrivate(path: string): Promise<void> {
  if (process.platform === 'win32' || process.getuid === undefined) return;
  const entryDirectory = await realpath(dirname(path));
  await assertDirectoryNotSharedWritable(entryDirectory, path);
  const targetDirectory = dirname(await realpath(path));
  if (targetDirectory !== entryDirectory) {
    await assertDirectoryNotSharedWritable(targetDirectory, path);
  }
}

/** Root is the trust root; anyone else holding a credential path is not. */
function isTrustedOwner(uid: number, self: number): boolean {
  return uid === self || uid === 0;
}

/**
 * Mode bits alone do not establish trust. A `0600` file owned by another
 * account is unreadable by others yet fully rewritable by its owner, who then
 * controls the credential the worker loads - or, for a quarantine marker, can
 * delete it and let mutations resume.
 */
async function assertOwnedByWorker(path: string): Promise<void> {
  const self = process.getuid?.();
  if (self === undefined) return;
  const { uid } = await stat(path);
  if (isTrustedOwner(uid, self)) return;
  throw new BridgeProtocolError(
    `${path} is owned by another account (uid ${uid}), which can rewrite it. ` +
      'Keep worker credentials on a path this account owns.',
  );
}

/**
 * Validate and read through one descriptor. Re-resolving the path after a
 * check lets a multi-hop symlink be toggled in between, so the file that was
 * judged need not be the file that is read; holding the descriptor removes the
 * second resolution entirely.
 */
async function readGuardedFile(
  path: string,
  exposed: (mode: string) => string,
): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    const self = process.getuid?.();
    if (self !== undefined && !isTrustedOwner(stats.uid, self)) {
      throw new BridgeProtocolError(
        `${path} is owned by another account (uid ${stats.uid}), which can rewrite it. ` +
          'Keep worker credentials on a path this account owns.',
      );
    }
    if (process.platform !== 'win32') {
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) throw new BridgeProtocolError(exposed(mode.toString(8)));
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function assertOwnerOnlyPath(
  path: string,
  reportedPath: string = path,
): Promise<void> {
  const mode = await groupOrOtherAccessMode(path);
  if (mode === undefined) return;
  throw new BridgeProtocolError(
    `Cannot restrict ${reportedPath} to owner-only access (mode ${mode.toString(8)}). ` +
      'Filesystems that ignore POSIX permissions, such as Windows drives mounted ' +
      'under /mnt, cannot protect worker credentials or workspaces. Use a path on a ' +
      'native Linux filesystem.',
  );
}

export async function ensurePrivateWorkspaceDirectory(
  path: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new BridgeProtocolError('Default workspace path must be a directory');
  }
  await chmod(path, 0o700);
  await assertOwnerOnlyPath(path);
  /* This directory is application-owned by contract; a pre-existing one under
   * another account lets that owner alter workspace inputs and results. */
  await assertOwnedByWorker(path);
}

/**
 * `saveBridgeIdentity` publishes by `rename`, which cannot replace a directory
 * and cannot replace a file this account does not own in a sticky directory.
 * Probing a sibling path alone would miss both, and the failure would land
 * after the code was already spent.
 */
async function assertIdentityDestinationIsReplaceable(
  path: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (metadata.isDirectory()) {
    throw new BridgeProtocolError(
      `Bridge identity path ${path} is a directory. Point --identity at a file.`,
    );
  }
  const uid = process.platform === 'win32' ? undefined : process.getuid?.();
  if (uid === undefined || uid === 0 || metadata.uid === uid) return;
  /* Ownership only blocks `rename` under the sticky bit, and owning the
   * directory is enough there; elsewhere the parent's write bit decides. */
  const parent = await stat(dirname(path));
  if ((parent.mode & 0o1000) === 0 || parent.uid === uid) return;
  throw new BridgeProtocolError(
    `Bridge identity path ${path} is owned by another account (uid ${metadata.uid}) ` +
      `inside the sticky directory ${dirname(path)}, so it cannot be replaced. ` +
      'Choose a path this account owns.',
  );
}

/**
 * Probe the identity destination before a one-time pairing code is redeemed, so
 * a filesystem that cannot hold the credential fails validation instead of
 * burning the code and leaving an orphaned remote pairing.
 */
export interface IdentityPathReservation {
  /** Drop a destination this call created, when pairing does not reach a save. */
  release(): Promise<void>;
}

/**
 * `saveBridgeIdentity` publishes by writing `<path>.<random>.tmp` beside the
 * destination and renaming it over. A directory that holds a readable identity
 * but denies creation - `0500`, say - passes every check on the file itself and
 * still fails the save, so exercise the sibling write rather than infer it.
 */
async function assertSiblingPublishable(path: string): Promise<void> {
  const probePath = `${path}.${randomBytes(8).toString('hex')}.probe`;
  try {
    await (await open(probePath, 'wx', 0o600)).close();
  } catch (error) {
    throw new BridgeProtocolError(
      `Cannot create a temporary file beside ${path} (${
        isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown'
      }), so the identity could not be published there. Choose a writable directory.`,
    );
  } finally {
    await rm(probePath, { force: true });
  }
}

export async function assertIdentityPathIsPrivate(
  path: string,
): Promise<IdentityPathReservation> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertIdentityDestinationIsReplaceable(path);
  let created = false;
  let reservedInode: bigint | undefined;
  try {
    /* Claiming the destination itself, rather than probing a sibling and
     * letting go, is what keeps the verdict true across the pairing request:
     * a shared sticky directory otherwise lets another account take the name
     * in that window, and the save would fail with the code already spent. */
    const reserved = await open(path, 'wx', 0o600);
    try {
      created = true;
      await reserved.chmod(0o600);
      await assertOwnerOnlyPath(path);
      reservedInode = (await reserved.stat({ bigint: true })).ino;
    } finally {
      await reserved.close();
    }
  } catch (error) {
    if (created) {
      await rm(path, { force: true });
      throw error;
    }
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    /* Already present: judge what is there instead of the placeholder, and
     * prove the publish itself is possible - an unwritable parent would
     * otherwise surface as EACCES only after the code was spent. */
    await assertOwnedByWorker(path);
    await assertOwnerOnlyPath(path);
    await assertSiblingPublishable(path);
  }
  try {
    /* After the mode verdict, so a filesystem that cannot hold an owner-only
     * file keeps the more specific diagnosis. */
    await assertWriteContainerPrivate(path);
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
  return {
    async release(): Promise<void> {
      if (!created || reservedInode === undefined) return;
      /* Only ever drop the placeholder this call made. A concurrent `pair`
       * may have published a real identity over the name since, and removing
       * that would destroy a credential whose code is already spent. */
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (
        current === undefined ||
        current.ino !== reservedInode ||
        current.size !== 0n
      ) {
        return;
      }
      await rm(path, { force: true });
    },
  };
}

export async function saveBridgeIdentity(
  path: string,
  identity: PairedBridgeWorkerIdentity,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await assertOwnerOnlyPath(temporaryPath, path);
      await file.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isWorkspaceMutationQuarantineRecord(
  value: unknown,
): value is WorkspaceMutationQuarantineRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.workerId === 'string' &&
    typeof value.workspaceId === 'string' &&
    (value.ownerId == null || typeof value.ownerId === 'string') &&
    typeof value.quarantinedAt === 'string' &&
    Number.isFinite(Date.parse(value.quarantinedAt)) &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  );
}

export async function saveWorkspaceMutationQuarantine(
  path: string,
  record: WorkspaceMutationQuarantineRecord,
): Promise<void> {
  await ensureDurableDirectory(dirname(path));
  const file = await open(path, 'wx', 0o600);
  try {
    try {
      await file.chmod(0o600);
      await assertOwnerOnlyPath(path);
      await assertWriteContainerPrivate(path);
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    /* A partially written marker would fail every later load, so the removal
     * has to reach the disk as durably as the write it is undoing. */
    await rm(path, { force: true });
    try {
      await syncParentDirectory(path);
    } catch {
      /* Surface the original failure, not a cleanup-durability one. */
    }
    throw error;
  }
  await syncParentDirectory(path);
}

export async function loadWorkspaceMutationQuarantine(
  path: string,
): Promise<WorkspaceMutationQuarantineRecord | undefined> {
  /* A marker another account can rewrite is not a control: it could be cleared
   * to resume mutations, or forged to wedge the worker under a foreign owner. */
  let content: string;
  try {
    content = await readGuardedFile(
      path,
      (mode) =>
        `Workspace quarantine ${path} is accessible beyond its owner (mode ${mode}). ` +
        'Another local account could clear or forge it. Keep worker state on a ' +
        'native Linux filesystem.',
    );
    await assertReadPathPrivate(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(content) as unknown;
  } catch {
    throw new BridgeProtocolError(`Invalid workspace quarantine file: ${path}`);
  }
  if (!isWorkspaceMutationQuarantineRecord(record)) {
    throw new BridgeProtocolError(`Invalid workspace quarantine file: ${path}`);
  }
  return record;
}

export async function clearWorkspaceMutationQuarantine(
  path: string,
  ownerId?: string,
): Promise<void> {
  if (ownerId != null) {
    const record = await loadWorkspaceMutationQuarantine(path);
    if (record == null || record.ownerId !== ownerId) {
      throw new BridgeProtocolError(
        'Workspace quarantine is owned by another worker incarnation',
      );
    }
  }
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  await rm(path, { force: true });
  await syncParentDirectory(path);
}

export async function assertWorkspaceMutationQuarantineOwner(
  path: string,
  ownerId: string,
): Promise<void> {
  const record = await loadWorkspaceMutationQuarantine(path);
  if (record == null || record.ownerId !== ownerId) {
    throw new BridgeProtocolError(
      'Workspace quarantine is owned by another worker incarnation',
    );
  }
}

export async function loadBridgeIdentity(
  path: string,
): Promise<PairedBridgeWorkerIdentity> {
  /* An identity written before this check, or by an older release, is still a
   * private key other local accounts can read. Refuse it rather than booting. */
  const content = await readGuardedFile(
    path,
    (mode) =>
      `Bridge identity ${path} is accessible beyond its owner (mode ${mode}). ` +
      'Treat its private key as compromised: revoke the worker and pair again with an ' +
      'identity path on a native Linux filesystem.',
  );
  /* After the file's own verdict, so an exposed mode keeps its diagnosis. */
  await assertReadPathPrivate(path);
  const identity = JSON.parse(content) as unknown;
  if (!isPairedIdentity(identity)) {
    throw new BridgeProtocolError(`Invalid bridge identity file: ${path}`);
  }
  return identity;
}
