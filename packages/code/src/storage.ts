import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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
 */
async function groupOrOtherAccessMode(
  path: string,
): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  const mode = (await stat(path)).mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : mode;
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

/**
 * Validate and read through one descriptor. Checking a path and then reading it
 * resolves the name twice, so a symlink retargeted in between would let the file
 * that was judged differ from the file that is read.
 */
async function readGuardedFile(
  path: string,
  exposed: (mode: string) => string,
): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (process.platform !== 'win32') {
      const mode = (await handle.stat()).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new BridgeProtocolError(exposed(mode.toString(8)));
      }
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
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
      /* Tighten every way available before judging, and judge before the key
       * is written, so no private key reaches a world-readable path. */
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
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    /* A partial marker fails every later load, so undoing it has to reach the
     * disk as durably as the write it is undoing. */
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
  let content: string;
  try {
    content = await readGuardedFile(
      path,
      (mode) =>
        `Workspace quarantine ${path} is accessible beyond its owner (mode ${mode}). ` +
        'Another local account could clear or forge it. Keep worker state on a ' +
        'native Linux filesystem.',
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
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
  const identity = JSON.parse(content) as unknown;
  if (!isPairedIdentity(identity)) {
    throw new BridgeProtocolError(`Invalid bridge identity file: ${path}`);
  }
  return identity;
}
