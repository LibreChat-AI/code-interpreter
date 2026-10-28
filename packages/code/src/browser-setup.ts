import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createBridgeIdentity } from './identity.js';
import { recoverWorkerCredential } from './credential-recovery.js';
import {
  browserSetupRequestHash,
  signBrowserSetupProof,
  signEnrollmentRedemption,
  isBrowserEnrollmentRedemptionContract,
} from './browser-enrollment-protocol.js';
import type {
  BrowserSetupRequest,
  BrowserSetupProof,
  EnrollmentRedemption,
} from './browser-enrollment-protocol.js';
import { assertPrivateStorageSupported } from './private-storage.js';
import { withProcessLock } from './process-lock.js';
import {
  assertIdentityPathIsPrivate,
  loadBridgeIdentity,
  ensurePrivateWorkspaceDirectory,
  readPrivateJson,
  saveBridgeIdentity,
  savePrivateJson,
} from './storage.js';
import { checkSetupCommands, setupCodeApiUrl, setupWorkspaceDirectory } from './setup.js';
import {
  assertWorkerProfileIsolation,
  defaultWorkerProfilePath,
  loadWorkerProfile,
  saveWorkerProfile,
  workerProfileArguments,
} from './worker-profile.js';
import type { WorkerProfile } from './worker-profile.js';
import type { PairedBridgeWorkerIdentity } from './pairing.js';

export interface BrowserSetupAttempt {
  version: 1;
  request: BrowserSetupRequest;
  privateKey: string;
  profile: WorkerProfile;
  approval?: BrowserSetupApproval;
  identity?: PairedBridgeWorkerIdentity;
  completed?: true;
}

export type BrowserSetupApproval = EnrollmentRedemption & { codeApiUrl: string };

export interface BrowserSetupOptions {
  instance: string;
  machineName: string;
  profilePath?: string;
  identityPath?: string;
  workspaceDirectory?: string;
  allowWorkspaceWrites: boolean;
  allowWorkspaceCommands: boolean;
  signal?: AbortSignal;
}

interface SetupStatus {
  version: 1;
  status: 'pending' | 'approved' | 'completed' | 'denied' | 'cancelled' | 'expired';
  expiresAt: string;
  verificationUrl: string;
  verificationCode: string;
  approval?: BrowserSetupApproval;
  credential?: { protocolVersion: 1; workerId: string; credential: string; expiresAt: string };
}

interface BrowserSetupDependencies {
  fetchImpl?: typeof fetch;
  checkCommands?: typeof checkSetupCommands;
  onVerification?: (status: Pick<SetupStatus, 'verificationUrl' | 'verificationCode' | 'expiresAt'>) => void | Promise<void>;
  pollIntervalMs?: number;
  saveProfile?: typeof saveWorkerProfile;
  saveIdentity?: typeof saveBridgeIdentity;
  recoverCredential?: typeof recoverWorkerCredential;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function setupInstanceUrl(value: string): string {
  return setupCodeApiUrl(value);
}

export function browserSetupAttemptPath(profilePath: string): string {
  return join(`${resolve(profilePath)}.setup`, 'attempt.json');
}

export function browserSetupProtectedPaths(attemptPath: string | undefined): string[] {
  if (attemptPath === undefined) return [];
  const directory = dirname(attemptPath);
  if (basename(attemptPath) !== 'attempt.json' || !directory.endsWith('.setup'))
    throw new Error('Unsupported setup journal location; preserve the original identity and journal');
  // Directory protection includes atomic-write temporaries, even after SIGKILL.
  return [directory];
}

export async function loadBrowserSetupAttempt(profilePath: string): Promise<BrowserSetupAttempt | undefined> {
  // The earlier, unreleased draft stored journals beside profiles. Never rekey them silently.
  const previous = await lstat(`${resolve(profilePath)}.setup.json`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous) throw new Error('An older draft setup journal exists; preserve its key and attempt instead of starting a new enrollment');
  let value: unknown;
  try { value = await readPrivateJson(browserSetupAttemptPath(profilePath), 32 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!record(value) || value.version !== 1 || !record(value.request) || !record(value.profile))
    throw new Error('Invalid saved setup attempt; preserve it and choose another profile, do not replace its machine key');
  const attempt = value as unknown as BrowserSetupAttempt;
  workerProfileArguments(attempt.profile);
  if (attempt.completed === true) {
    attempt.identity = await loadBridgeIdentity(attempt.profile.identityPath);
    attempt.privateKey = attempt.identity.privateKey;
  }
  if (typeof attempt.privateKey !== 'string') throw new Error('Saved setup key is unavailable; preserve the original identity');
  if (setupInstanceUrl(attempt.request.instance) !== attempt.request.instance ||
      createPublicKey(createPrivateKey(attempt.privateKey)).export({ type: 'spki', format: 'pem' }) !== attempt.request.publicKey)
    throw new Error('Saved setup key does not match its request');
  // The shared canonicalizer validates the immutable request before it is signed.
  browserSetupRequestHash(attempt.request);
  if (attempt.approval && (!isBrowserEnrollmentRedemptionContract(attempt.approval) ||
      attempt.approval.instance !== attempt.request.instance || attempt.approval.attemptId !== attempt.request.attemptId ||
      attempt.approval.requestHash !== browserSetupRequestHash(attempt.request) ||
      setupCodeApiUrl(attempt.approval.codeApiUrl) !== attempt.approval.codeApiUrl ||
      new URL(attempt.approval.codeApiUrl).origin !== attempt.approval.serverId))
    throw new Error('Saved approval does not match its setup request');
  if (attempt.identity && (!attempt.approval || attempt.identity.protocolVersion !== 1 ||
      attempt.identity.publicKey !== attempt.request.publicKey || attempt.identity.privateKey !== attempt.privateKey ||
      attempt.identity.workerId !== attempt.approval.workerId || attempt.identity.codeApiUrl !== attempt.approval.codeApiUrl ||
      typeof attempt.identity.credential !== 'string' || attempt.identity.credential.length < 32 ||
      attempt.identity.credential.length > 4096 || !Number.isFinite(Date.parse(attempt.identity.expiresAt))))
    throw new Error('Saved completion does not match its approved machine key');
  return attempt;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LibreChat returned an empty setup response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024) throw new Error('LibreChat setup response exceeds 32 KiB');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new Error('LibreChat returned an invalid setup response'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function requestJson(instance: string, path: string, body: unknown, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${instance}/api/code-environments/setup/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if ([404, 405, 501].includes(response.status))
      throw new Error('This LibreChat instance does not support browser-approved machine setup. Update compatible servers first, or explicitly use the existing manual pairing flow');
    throw new Error(`LibreChat setup request failed (HTTP ${response.status}). Your saved key and attempt are unchanged; rerun the same setup command to resume`);
  }
  return boundedJson(response);
}

function machineBody(attempt: BrowserSetupAttempt, operation: BrowserSetupProof['operation']): object {
  const proof: BrowserSetupProof = {
    operation,
    instance: attempt.request.instance,
    attemptId: attempt.request.attemptId,
    requestHash: browserSetupRequestHash(attempt.request),
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
  };
  return {
    request: attempt.request,
    proof,
    signature: signBrowserSetupProof(attempt.privateKey, proof),
    ...(operation === 'setup.complete' && attempt.approval ? {
      redemptionSignature: signEnrollmentRedemption(attempt.privateKey, attempt.approval),
    } : {}),
  };
}

function parseStatus(value: unknown, attempt: BrowserSetupAttempt): SetupStatus {
  if (!record(value) || value.version !== 1 ||
      !['pending', 'approved', 'completed', 'denied', 'cancelled', 'expired'].includes(String(value.status)) ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) > Date.parse(attempt.request.createdAt) + 10 * 60_000 ||
      typeof value.verificationUrl !== 'string' || typeof value.verificationCode !== 'string' ||
      !/^[A-Z0-9-]{6,20}$/.test(value.verificationCode))
    throw new Error('LibreChat returned an invalid setup session');
  let url: URL;
  try { url = new URL(value.verificationUrl); }
  catch { throw new Error('LibreChat returned an invalid approval destination'); }
  if (url.href !== `${attempt.request.instance}/code/setup/${attempt.request.attemptId}` ||
      url.username || url.password || url.search || url.hash)
    throw new Error('LibreChat returned an unexpected approval destination');
  if (value.approval !== undefined) {
    const approval = value.approval as BrowserSetupApproval;
    if (!isBrowserEnrollmentRedemptionContract(approval) || approval.operation !== 'enrollment.redeem' ||
        approval.instance !== attempt.request.instance || approval.attemptId !== attempt.request.attemptId ||
        approval.requestHash !== browserSetupRequestHash(attempt.request) ||
        approval.expiresAt !== value.expiresAt || typeof approval.workerId !== 'string' ||
        typeof approval.codeApiUrl !== 'string' || setupCodeApiUrl(approval.codeApiUrl) !== approval.codeApiUrl ||
        new URL(approval.codeApiUrl).origin !== approval.serverId)
      throw new Error('LibreChat approval does not match this setup attempt');
    if (attempt.approval && JSON.stringify(attempt.approval) !== JSON.stringify(approval))
      throw new Error('LibreChat changed the saved approval; refusing to replace the machine binding');
  }
  return value as unknown as SetupStatus;
}

async function assertEmptyOrMatching(path: string, expected: unknown, load: (path: string) => Promise<unknown>, same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)): Promise<boolean> {
  const metadata = await lstat(path);
  if (metadata.isFile() && metadata.size === 0) return false;
  if (!same(await load(path), expected))
    throw new Error('Existing profile or identity differs from the saved setup attempt; refusing to replace it');
  return true;
}

function sameEnrolledKey(left: unknown, right: unknown): boolean {
  return record(left) && record(right) && ['protocolVersion', 'workerId', 'codeApiUrl', 'publicKey', 'privateKey', 'setupAttemptPath']
    .every(key => left[key] === right[key]);
}

/** Every remote mutation follows a durable, private key and immutable local request. */
export async function setupBrowserWorker(options: BrowserSetupOptions, dependencies: BrowserSetupDependencies = {}): Promise<{ profilePath: string; profile: WorkerProfile }> {
  options.signal?.throwIfAborted();
  assertPrivateStorageSupported();
  const instance = setupInstanceUrl(options.instance);
  const profilePath = resolve(options.profilePath ?? defaultWorkerProfilePath());
  const attemptPath = browserSetupAttemptPath(profilePath);
  await ensurePrivateWorkspaceDirectory(dirname(attemptPath));
  // This stable inode is deliberately retained. Removing an advisory lock can split its holders.
  await assertIdentityPathIsPrivate(`${attemptPath}.lock`);
  return withProcessLock(`${attemptPath}.lock`, async () => {
    let attempt = await loadBrowserSetupAttempt(profilePath);
    const workspaceDirectory = options.workspaceDirectory === undefined ? undefined : await setupWorkspaceDirectory(options.workspaceDirectory);
    const profile: WorkerProfile = {
      version: 1,
      identityPath: resolve(options.identityPath ?? `${profilePath}.identity.json`),
      workspace: workspaceDirectory ? { type: 'directory', path: workspaceDirectory } : { type: 'private' },
      allowWorkspaceWrites: options.allowWorkspaceWrites,
      allowWorkspaceCommands: options.allowWorkspaceCommands,
    };
    workerProfileArguments(profile);
    if (attempt && (attempt.request.instance !== instance || attempt.request.machineName !== options.machineName || JSON.stringify(attempt.profile) !== JSON.stringify(profile)))
      throw new Error('Setup choices differ from the saved attempt. Resume its original instance and permissions, or explicitly select another profile');
    if (profile.allowWorkspaceCommands) await (dependencies.checkCommands ?? checkSetupCommands)();
    const reservations = [];
    try {
      reservations.push(await assertIdentityPathIsPrivate(profilePath, !attempt));
      reservations.push(await assertIdentityPathIsPrivate(profile.identityPath, !attempt));
      reservations.push(await assertIdentityPathIsPrivate(attemptPath, !attempt));
      await assertWorkerProfileIsolation(profilePath, profile.identityPath, workspaceDirectory);
      await assertWorkerProfileIsolation(attemptPath, profilePath, workspaceDirectory);
      await assertWorkerProfileIsolation(attemptPath, profile.identityPath, workspaceDirectory);
      if (!attempt) {
        const key = createBridgeIdentity();
        attempt = {
          version: 1,
          request: {
            version: 1, instance, attemptId: randomBytes(32).toString('base64url'),
            createdAt: new Date().toISOString(), publicKey: key.publicKey,
            machineName: options.machineName, workspace: { type: profile.workspace.type },
            allowWorkspaceWrites: profile.allowWorkspaceWrites, allowWorkspaceCommands: profile.allowWorkspaceCommands,
          },
          privateKey: key.privateKey, profile,
        };
        browserSetupRequestHash(attempt.request);
        await savePrivateJson(attemptPath, attempt);
      }
      const persist = () => savePrivateJson(attemptPath, attempt);
      const publish = async () => {
        if (!await assertEmptyOrMatching(profile.identityPath, attempt!.identity, loadBridgeIdentity, sameEnrolledKey))
          await (dependencies.saveIdentity ?? saveBridgeIdentity)(profile.identityPath, attempt!.identity!);
        if (!attempt!.completed) {
          await savePrivateJson(attemptPath, { version: 1, request: attempt!.request, profile, approval: attempt!.approval, completed: true });
          attempt!.completed = true;
        }
        const profileSaved = await assertEmptyOrMatching(profilePath, profile, loadWorkerProfile);
        try { if (!profileSaved) await (dependencies.saveProfile ?? saveWorkerProfile)(profilePath, profile); }
        catch { throw new Error(`Machine enrolled and identity saved, but profile persistence failed. Rerun setup with this same profile to resume: ${profilePath}`); }
        return { profilePath, profile };
      };
      if (attempt.identity) return await publish();
      const fetchImpl = dependencies.fetchImpl ?? fetch;
      if (attempt.approval && Date.now() >= Date.parse(attempt.approval.expiresAt)) {
        // Session expiry cannot undo enrollment. Recovery proves only existing trust.
        const credential = await (dependencies.recoverCredential ?? recoverWorkerCredential)({
          codeApiUrl: attempt.approval.codeApiUrl, workerId: attempt.approval.workerId,
          privateKey: attempt.privateKey, fetchImpl, validThroughMs: Date.now() + 60_000,
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        attempt.identity = { ...credential, codeApiUrl: attempt.approval.codeApiUrl,
          publicKey: attempt.request.publicKey, privateKey: attempt.privateKey, setupAttemptPath: attemptPath };
        await persist();
        return await publish();
      }
      const capabilities = await requestJson(instance, 'capabilities', undefined, options.signal, fetchImpl);
      if (!record(capabilities) || capabilities.browserEnrollmentVersion !== 1)
        throw new Error('This instance lacks compatible key-bound browser enrollment. Update compatible servers first; setup will not downgrade to manual pairing');
      let status = parseStatus(await requestJson(instance, 'start', machineBody(attempt, 'setup.start'), options.signal, fetchImpl), attempt);
      await dependencies.onVerification?.(status);
      for (;;) {
        options.signal?.throwIfAborted();
        if (['denied', 'cancelled', 'expired'].includes(status.status)) throw new Error(`Machine setup ${status.status}. The original key and attempt were preserved; choose another profile only for an intentional new enrollment`);
        if (status.approval) { attempt.approval = status.approval; await persist(); }
        if (status.status === 'approved' || status.status === 'completed') {
          if (!attempt.approval) throw new Error('LibreChat did not supply the key-bound approval contract');
          const completed = parseStatus(await requestJson(instance, 'complete', machineBody(attempt, 'setup.complete'), options.signal, fetchImpl), attempt);
          const credential = completed.credential;
          if (completed.status !== 'completed' || !credential || credential.protocolVersion !== 1 ||
              credential.workerId !== attempt.approval.workerId || typeof credential.credential !== 'string' ||
              credential.credential.length < 32 || credential.credential.length > 4096 ||
              !Number.isFinite(Date.parse(credential.expiresAt))) throw new Error('LibreChat returned an invalid enrollment credential');
          attempt.identity = { protocolVersion: 1, workerId: credential.workerId, credential: credential.credential, expiresAt: credential.expiresAt,
            codeApiUrl: attempt.approval.codeApiUrl, publicKey: attempt.request.publicKey, privateKey: attempt.privateKey, setupAttemptPath: attemptPath };
          // Keep replayable local state even if either final file cannot be published.
          await persist();
          return await publish();
        }
        if (Date.now() >= Date.parse(status.expiresAt)) throw new Error('Machine setup expired; the saved key and attempt were preserved');
        await delay(dependencies.pollIntervalMs ?? 2000, undefined, { signal: options.signal });
        status = parseStatus(await requestJson(instance, 'poll', machineBody(attempt, 'setup.poll'), options.signal, fetchImpl), attempt);
      }
    } finally { for (const reservation of reservations.reverse()) await reservation.release(); }
  }, options.signal, false);
}

export async function cancelBrowserSetup(profilePath: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  const attempt = await loadBrowserSetupAttempt(profilePath);
  if (!attempt) throw new Error('No saved setup attempt exists for this profile');
  if (attempt.identity) throw new Error('This machine is already enrolled; revoke it through LibreChat instead');
  await requestJson(attempt.request.instance, 'cancel', machineBody(attempt, 'setup.cancel'), signal, fetchImpl);
}
