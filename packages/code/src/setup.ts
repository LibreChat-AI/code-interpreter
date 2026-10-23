import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { pairBridgeWorker } from './pairing.js';
import { isValidBridgeWorkerId } from './protocol.js';
import { assertPrivateStorageSupported } from './private-storage.js';
import {
  assertIdentityPathIsPrivate,
  defaultBridgeIdentityPath,
  saveBridgeIdentity,
} from './storage.js';
import {
  assertWorkerProfileIsolation,
  defaultWorkerProfilePath,
  loadWorkerProfile,
  saveWorkerProfile,
  workerProfileArguments,
} from './worker-profile.js';
import type { WorkerProfile } from './worker-profile.js';

export interface SetupWorkerOptions {
  codeApiUrl: string;
  workerId: string;
  code: string;
  profilePath?: string;
  identityPath?: string;
  workspaceDirectory?: string;
  allowWorkspaceWrites: boolean;
  allowWorkspaceCommands: boolean;
  signal?: AbortSignal;
}

export function setupCodeApiUrl(value: string): string {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      'Enter a Code API HTTPS URL without credentials, query, or fragment',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Enter a valid Code API HTTPS URL, including its /v1 prefix',
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Code API requires HTTPS; HTTP is allowed only on loopback, without credentials, query, or fragment',
    );
  }
  return url.href.replace(/\/+$/, '');
}

export async function checkSetupCommands(): Promise<void> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(
      'Native sandbox commands require a supported macOS or Linux host',
    );
  }
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length) {
    throw new Error(
      `Install the native sandbox prerequisites before pairing: ${dependencies.errors.join('; ')}`,
    );
  }
  await access('/bin/bash', constants.X_OK);
}

export async function setupWorkspaceDirectory(value: string): Promise<string> {
  if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Choose an existing project directory');
  }
  const path = await realpath(resolve(value));
  if (!(await stat(path)).isDirectory())
    throw new Error('Workspace must be a directory');
  const home = await realpath(homedir());
  const homeRelative = relative(path, home);
  if (
    homeRelative === '' ||
    (!isAbsolute(homeRelative) &&
      homeRelative !== '..' &&
      !homeRelative.startsWith(`..${sep}`))
  ) {
    throw new Error(
      'Do not expose your home directory or a directory containing it; choose a project or a private workspace',
    );
  }
  return path;
}

export async function setupWorker(
  options: SetupWorkerOptions,
  dependencies: {
    pair?: typeof pairBridgeWorker;
    checkCommands?: typeof checkSetupCommands;
  } = {},
): Promise<{ profilePath: string; profile: WorkerProfile }> {
  options.signal?.throwIfAborted();
  assertPrivateStorageSupported();
  const codeApiUrl = setupCodeApiUrl(options.codeApiUrl);
  if (!isValidBridgeWorkerId(options.workerId))
    throw new Error('Enter the worker ID supplied by LibreChat');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(options.code))
    throw new Error('Enter a valid one-time pairing code from LibreChat');
  const profilePath = resolve(
    options.profilePath ?? defaultWorkerProfilePath(),
  );
  const identityPath = resolve(
    options.identityPath ?? defaultBridgeIdentityPath(options.workerId),
  );
  if (
    [profilePath, identityPath].some(
      path => Buffer.byteLength(path) > 4096 || /[\x00-\x1f\x7f]/.test(path),
    )
  ) {
    throw new Error(
      'Profile and identity paths must contain no control characters and be at most 4096 bytes',
    );
  }
  if (
    typeof options.allowWorkspaceWrites !== 'boolean' ||
    typeof options.allowWorkspaceCommands !== 'boolean'
  ) {
    throw new Error(
      'Workspace permissions must be explicitly enabled or disabled',
    );
  }
  const workspaceDirectory =
    options.workspaceDirectory == null
      ? undefined
      : await setupWorkspaceDirectory(options.workspaceDirectory);
  const profile: WorkerProfile = {
    version: 1,
    identityPath,
    workspace:
      workspaceDirectory == null
        ? { type: 'private' }
        : { type: 'directory', path: workspaceDirectory },
    allowWorkspaceWrites: options.allowWorkspaceWrites,
    allowWorkspaceCommands: options.allowWorkspaceCommands,
  };
  if (profile.allowWorkspaceCommands)
    await (dependencies.checkCommands ?? checkSetupCommands)();
  options.signal?.throwIfAborted();
  const profileReservation = await assertIdentityPathIsPrivate(
    profilePath,
    true,
  );
  try {
    const identityReservation = await assertIdentityPathIsPrivate(
      identityPath,
      true,
    );
    try {
      await assertWorkerProfileIsolation(
        profilePath,
        identityPath,
        workspaceDirectory,
      );
      const identity = await (dependencies.pair ?? pairBridgeWorker)({
        codeApiUrl,
        workerId: options.workerId,
        code: options.code,
        signal:
          options.signal == null
            ? AbortSignal.timeout(30_000)
            : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
      });
      await saveBridgeIdentity(identityPath, identity);
      try {
        await saveWorkerProfile(profilePath, profile);
      } catch {
        throw new Error(
          `Machine paired and identity saved to ${identityPath}, but the profile could not be saved. Keep this identity and use LIBRECHAT_CODE_IDENTITY_FILE with the existing run command; do not pair again automatically.`,
        );
      }
      return { profilePath, profile };
    } finally {
      await identityReservation.release();
    }
  } finally {
    await profileReservation.release();
  }
}

export interface ProfileRunConfiguration {
  args: string[];
  profilePath?: string;
  profile?: WorkerProfile;
}

export async function profileRunConfiguration(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProfileRunConfiguration> {
  const profileArgs = args.filter(
    arg => arg === '--profile' || arg.startsWith('--profile='),
  );
  if (profileArgs.length > 1) throw new Error('Supply --profile only once');
  let profilePath = environment.LIBRECHAT_CODE_PROFILE_FILE?.trim();
  if (profileArgs.length) {
    const flag = profileArgs[0];
    const value =
      flag === '--profile'
        ? args[args.indexOf(flag) + 1]
        : flag.slice('--profile='.length);
    if (!value || value.startsWith('--'))
      throw new Error('--profile requires a file');
    profilePath = value;
    args = args.filter(
      (_, index) =>
        index !== args.indexOf(flag) &&
        (flag !== '--profile' || index !== args.indexOf(flag) + 1),
    );
  }
  const legacyConfiguration = Object.entries(environment).some(
    ([key, value]) =>
      key.startsWith('LIBRECHAT_CODE_') &&
      key !== 'LIBRECHAT_CODE_PROFILE_FILE' &&
      value?.trim(),
  );
  if (legacyConfiguration) {
    if (profilePath)
      throw new Error(
        'Saved profiles cannot be combined with LIBRECHAT_CODE_* settings; unset them or use the existing run configuration',
      );
    return { args };
  }
  const path = resolve(profilePath ?? defaultWorkerProfilePath());
  const profile = await loadWorkerProfile(path);
  if (!profile) {
    if (profilePath)
      throw new Error(
        'Saved profile not found; run librechat-code setup first',
      );
    return { args };
  }
  if (args.length)
    throw new Error(
      'Saved profiles cannot be combined with run options; use a separate profile or the existing environment-variable configuration',
    );
  return { profilePath: path, profile, args: workerProfileArguments(profile) };
}
