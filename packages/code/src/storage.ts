import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
  const fileName = readableName === workerId
    ? readableName
    : `${readableName}-${createHash('sha256').update(workerId).digest('hex').slice(0, 16)}`;
  return join(homedir(), '.config', 'librechat', 'code', `${fileName}.json`);
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

export async function loadBridgeIdentity(
  path: string,
): Promise<PairedBridgeWorkerIdentity> {
  const identity = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isPairedIdentity(identity)) {
    throw new BridgeProtocolError(`Invalid bridge identity file: ${path}`);
  }
  return identity;
}
