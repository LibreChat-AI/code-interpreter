import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { assertPrivateStorageAncestors } from './private-storage.js';
import { BridgeProtocolError } from './protocol.js';
import { readPrivateJson, savePrivateJson } from './storage.js';

const MAX_PROFILE_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4096;

export interface WorkerProfile {
  version: 1;
  identityPath: string;
  workspace: { type: 'private' } | { type: 'directory'; path: string };
  allowWorkspaceWrites: boolean;
  allowWorkspaceCommands: boolean;
}

function hasExactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

function assertProfilePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new BridgeProtocolError(
      'Worker profile paths must be absolute, contain no control characters, and be at most 4096 bytes',
    );
  }
}

function parseWorkerProfile(value: unknown): WorkerProfile {
  if (
    !hasExactKeys(value, [
      'version',
      'identityPath',
      'workspace',
      'allowWorkspaceWrites',
      'allowWorkspaceCommands',
    ]) ||
    value.version !== 1 ||
    typeof value.allowWorkspaceWrites !== 'boolean' ||
    typeof value.allowWorkspaceCommands !== 'boolean'
  ) {
    throw new BridgeProtocolError(
      'Invalid worker profile fields or unsupported version',
    );
  }
  assertProfilePath(value.identityPath);
  let workspace: WorkerProfile['workspace'];
  if (
    hasExactKeys(value.workspace, ['type']) &&
    value.workspace.type === 'private'
  ) {
    workspace = { type: 'private' };
  } else if (
    hasExactKeys(value.workspace, ['type', 'path']) &&
    value.workspace.type === 'directory'
  ) {
    assertProfilePath(value.workspace.path);
    workspace = { type: 'directory', path: value.workspace.path };
  } else {
    throw new BridgeProtocolError('Invalid worker profile workspace');
  }
  return {
    version: 1,
    identityPath: value.identityPath,
    workspace,
    allowWorkspaceWrites: value.allowWorkspaceWrites,
    allowWorkspaceCommands: value.allowWorkspaceCommands,
  };
}

export function defaultWorkerProfilePath(): string {
  return join(
    homedir(),
    '.config',
    'librechat',
    'code',
    'profiles',
    'default.json',
  );
}

export async function loadWorkerProfile(
  path: string,
): Promise<WorkerProfile | undefined> {
  assertProfilePath(path);
  let value: unknown;
  try {
    value = await readPrivateJson(path, MAX_PROFILE_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling leaf symlink is not an absent profile.
    const entry = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return undefined;
      throw failure;
    });
    if (entry !== undefined) throw error;
    return undefined;
  }
  return parseWorkerProfile(value);
}

export async function saveWorkerProfile(
  path: string,
  profile: WorkerProfile,
): Promise<void> {
  assertProfilePath(path);
  const value = parseWorkerProfile(profile);
  if (
    Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8') >
    MAX_PROFILE_BYTES
  ) {
    throw new BridgeProtocolError('Worker profile exceeds the 16 KiB limit');
  }
  await savePrivateJson(path, value);
}

export function workerProfileArguments(profile: WorkerProfile): string[] {
  const value = parseWorkerProfile(profile);
  const args =
    value.workspace.type === 'private'
      ? ['--default-workspace']
      : ['--worker-dir', value.workspace.path];
  if (value.allowWorkspaceWrites) args.push('--allow-workspace-writes');
  if (value.allowWorkspaceCommands) args.push('--allow-workspace-commands');
  return args;
}

function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

export async function assertWorkerProfileIsolation(
  profilePath: string,
  identityPath: string,
  workspaceRoot?: string,
): Promise<void> {
  assertProfilePath(profilePath);
  assertProfilePath(identityPath);
  if (workspaceRoot !== undefined) assertProfilePath(workspaceRoot);
  const [profileAncestors, identityAncestors] = await Promise.all([
    assertPrivateStorageAncestors(profilePath),
    assertPrivateStorageAncestors(identityPath),
  ]);
  const [profile, identity, profileMetadata, identityMetadata] =
    await Promise.all([
      realpath(profilePath),
      realpath(identityPath),
      stat(profilePath, { bigint: true }),
      stat(identityPath, { bigint: true }),
    ]);
  if (!profileMetadata.isFile() || !identityMetadata.isFile()) {
    throw new BridgeProtocolError(
      'Worker profile and identity paths must be regular files',
    );
  }
  if (
    profile === identity ||
    (profileMetadata.dev === identityMetadata.dev &&
      profileMetadata.ino === identityMetadata.ino)
  ) {
    throw new BridgeProtocolError(
      'Worker profile and identity must use separate files, not aliases',
    );
  }
  if (workspaceRoot === undefined) return;
  const root = await realpath(workspaceRoot);
  if (!(await stat(root)).isDirectory()) {
    throw new BridgeProtocolError('Worker workspace root must be a directory');
  }
  if (
    [profile, identity, ...profileAncestors, ...identityAncestors].some(path =>
      isWithin(root, path),
    )
  ) {
    throw new BridgeProtocolError(
      'Worker profile, identity, and their storage ancestry must stay outside the workspace',
    );
  }
}
