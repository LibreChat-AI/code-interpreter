import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  quarantinedAt: string;
  reason: string;
}

export interface DefaultWorkspaceQuarantinePathOptions {
  codeApiUrl: string;
  workerId: string;
  workspaceId: string;
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
    `${workspaceStorageName(options.workspaceId)}.json`,
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncParentDirectory(path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadWorkspaceMutationQuarantine(
  path: string,
): Promise<WorkspaceMutationQuarantineRecord | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (
      isRecord(error) &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
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
): Promise<void> {
  await rm(path, { force: true });
}

export async function loadBridgeIdentity(
  path: string,
): Promise<PairedBridgeWorkerIdentity> {
  const identity = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isPairedIdentity(identity)) {
    throw new BridgeProtocolError(`Invalid bridge identity file: ${path}`);
  }
  return identity;
}
