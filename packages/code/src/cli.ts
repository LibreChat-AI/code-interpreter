#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { pairBridgeWorker } from './pairing.js';
import { startFileRelay } from './relay.js';
import { DockerFileRelaySupervisor } from './relay-runtime.js';
import {
  assertWorkspaceMutationQuarantineOwner,
  clearWorkspaceMutationQuarantine,
  defaultBridgeIdentityPath,
  defaultWorkspaceQuarantinePath,
  defaultWorkspacePath,
  ensurePrivateWorkspaceDirectory,
  loadBridgeIdentity,
  loadWorkspaceMutationQuarantine,
  saveBridgeIdentity,
  saveWorkspaceMutationQuarantine,
} from './storage.js';
import { BridgeWorker } from './worker.js';
import {
  LocalWorkspaceTools,
  SandboxWorkspaceTools,
} from './workspace.js';
import { DockerRuntimeSupervisor, EndpointRuntimeSupervisor } from './runtime.js';
import { RuntimeWorkspaceCommandSandbox } from './workspace-runtime.js';
import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import type { RuntimeSupervisor } from './runtime.js';
import type { WorkspaceToolExecutor } from './workspace.js';
import {
  BRIDGE_WORKSPACE_NAME_MAX_LENGTH,
  BridgeProtocolError,
  isValidBridgeWorkerCapabilities,
  isValidBridgeWorkerId,
} from './protocol.js';

function workspaceSecurityIdentity(
  pairedPublicKey: string | undefined,
  configuredToken: string | undefined,
): string {
  return (
    pairedPublicKey ?? required('LIBRECHAT_CODE_WORKER_TOKEN', configuredToken)
  );
}

function workspaceQuarantinePath(options: {
  codeApiUrl: string;
  workerId: string;
  workspaceRoot?: string;
}): string {
  const override = process.env.LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE?.trim();
  if (override) return override;
  return defaultWorkspaceQuarantinePath({
    ...options,
    workspaceRoot: required('workspace directory', options.workspaceRoot),
  });
}

function required(name: string, value = process.env[name]): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function list(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value == null || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const MACOS_NSJAIL_CAPABILITIES = [
  'SYS_ADMIN',
  'SYS_CHROOT',
  'SYS_PTRACE',
  'SETUID',
  'SETGID',
  'NET_ADMIN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'CHOWN',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETFCAP',
  'MKNOD',
];

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim().length ? value : undefined;
}

function defaultWorkspaceName(workerDirectory: string, workspaceId: string): string {
  const directoryName = basename(resolve(workerDirectory));
  return directoryName.trim().length > 0 &&
    directoryName.length <= BRIDGE_WORKSPACE_NAME_MAX_LENGTH
    ? directoryName
    : workspaceId;
}

async function pair(args: string[]): Promise<void> {
  const codeApiUrl = required('instance URL', args[1]);
  const code = required('one-time pairing code', args[2]);
  const workerId = required(
    '--worker-id or LIBRECHAT_CODE_WORKER_ID',
    option(args, '--worker-id') ?? process.env.LIBRECHAT_CODE_WORKER_ID,
  );
  const identityPath =
    option(args, '--identity') ??
    process.env.LIBRECHAT_CODE_IDENTITY_FILE ??
    defaultBridgeIdentityPath(workerId);
  const identity = await pairBridgeWorker({ codeApiUrl, workerId, code });
  await saveBridgeIdentity(identityPath, identity);
  process.stdout.write(
    `Paired worker ${workerId}. Identity saved to ${identityPath}\n`,
  );
}

async function relay(): Promise<void> {
  const handle = await startFileRelay({
    host: process.env.LIBRECHAT_CODE_FILE_RELAY_HOST?.trim() || '0.0.0.0',
    port: positiveInteger(
      'LIBRECHAT_CODE_FILE_RELAY_PORT',
      process.env.LIBRECHAT_CODE_FILE_RELAY_PORT,
      3000,
    ),
    upstreamUrl: required('LIBRECHAT_CODE_FILE_RELAY_UPSTREAM'),
    token: required('LIBRECHAT_CODE_FILE_RELAY_TOKEN'),
    maxBytes: positiveInteger(
      'LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES',
      process.env.LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES,
      16 * 1024 * 1024,
    ),
    timeoutMs: positiveInteger(
      'LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS',
      process.env.LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS,
      30_000,
    ),
    maxConcurrentRequests: positiveInteger(
      'LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS',
      process.env.LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS,
      8,
    ),
  });
  process.stdout.write(`librechat-code: file relay listening at ${handle.url}\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await handle.close();
}

async function run(runtimeSessionId?: string, args: string[] = []): Promise<void> {
  const configuredWorkerId = process.env.LIBRECHAT_CODE_WORKER_ID?.trim();
  const configuredIdentityPath = process.env.LIBRECHAT_CODE_IDENTITY_FILE?.trim();
  const configuredToken = process.env.LIBRECHAT_CODE_WORKER_TOKEN?.trim();
  const identityPath =
    configuredIdentityPath ??
    (configuredWorkerId && !configuredToken
      ? defaultBridgeIdentityPath(configuredWorkerId)
      : undefined);
  const pairedIdentity = identityPath
    ? await loadBridgeIdentity(identityPath)
    : undefined;
  const workerId = required(
    'LIBRECHAT_CODE_WORKER_ID',
    configuredWorkerId ?? pairedIdentity?.workerId,
  );
  if (!isValidBridgeWorkerId(workerId)) {
    throw new Error(
      'LIBRECHAT_CODE_WORKER_ID must match the bridge worker ID format',
    );
  }
  if (pairedIdentity && pairedIdentity.workerId !== workerId) {
    throw new Error(
      `Identity belongs to ${pairedIdentity.workerId}, not configured worker ${workerId}`,
    );
  }
  const codeApiUrl = required(
    'LIBRECHAT_CODE_URL',
    process.env.LIBRECHAT_CODE_URL ?? pairedIdentity?.codeApiUrl,
  );
  const policy = process.env.LIBRECHAT_CODE_POLICY ?? 'default-deny';
  const statefulWorkspace =
    process.env.LIBRECHAT_CODE_STATEFUL_WORKSPACE?.trim().toLowerCase() ===
    'true';
  const runtimeMode =
    process.env.LIBRECHAT_CODE_RUNTIME_SUPERVISOR?.trim().toLowerCase() ?? 'endpoint';
  if (
    runtimeMode !== 'endpoint' &&
    runtimeMode !== 'docker' &&
    runtimeMode !== 'docker-nsjail' &&
    runtimeMode !== 'docker-macos-nsjail'
  ) {
    throw new Error(
      'LIBRECHAT_CODE_RUNTIME_SUPERVISOR must be endpoint, docker, docker-nsjail, or docker-macos-nsjail',
    );
  }
  const nsjailDockerMode =
    runtimeMode === 'docker-nsjail' || runtimeMode === 'docker-macos-nsjail';
  const sandboxEndpoint =
    process.env.LIBRECHAT_CODE_SANDBOX_ENDPOINT ??
    'http://127.0.0.1:2000/api/v2';
  if (
    runtimeMode === 'endpoint' &&
    statefulWorkspace &&
    !sandboxEndpoint.includes('{runtimeSessionId}')
  ) {
    throw new Error(
      'LIBRECHAT_CODE_STATEFUL_WORKSPACE requires LIBRECHAT_CODE_SANDBOX_ENDPOINT to contain {runtimeSessionId}',
    );
  }
  const workerIdentity = pairedIdentity
    ? {
        privateKey: pairedIdentity.privateKey,
        credential: pairedIdentity.credential,
        expiresAt: pairedIdentity.expiresAt,
      }
    : undefined;
  const fileRelayUpstream =
    process.env.LIBRECHAT_CODE_FILE_RELAY_UPSTREAM?.trim();
  const fileRelayEnabled =
    nsjailDockerMode &&
    runtimeSessionId == null &&
    (fileRelayUpstream?.length ?? 0) > 0;
  const workspaceId =
    option(args, '--workspace-id') ??
    process.env.LIBRECHAT_CODE_WORKSPACE_ID?.trim() ??
    'primary';
  const explicitWorkerDirectory =
    runtimeSessionId == null
      ? nonEmpty(
          option(args, '--worker-dir') ??
            process.env.LIBRECHAT_CODE_WORKER_DIR?.trim(),
        )
      : undefined;
  const useDefaultWorkspace =
    runtimeSessionId == null &&
    (args.includes('--default-workspace') ||
      process.env.LIBRECHAT_CODE_DEFAULT_WORKSPACE?.trim().toLowerCase() ===
        'true');
  const allowWorkspaceWrites =
    runtimeSessionId == null &&
    (args.includes('--allow-workspace-writes') ||
      process.env.LIBRECHAT_CODE_ALLOW_WORKSPACE_WRITES?.trim().toLowerCase() ===
        'true');
  const allowWorkspaceCommands =
    runtimeSessionId == null &&
    (args.includes('--allow-workspace-commands') ||
      process.env.LIBRECHAT_CODE_ALLOW_WORKSPACE_COMMANDS?.trim().toLowerCase() ===
        'true');
  const commandSandboxMode =
    option(args, '--command-sandbox') ??
    process.env.LIBRECHAT_CODE_COMMAND_SANDBOX?.trim().toLowerCase() ??
    (nsjailDockerMode ? 'runtime' : 'native-srt');
  if (commandSandboxMode !== 'native-srt' && commandSandboxMode !== 'runtime') {
    throw new Error(
      'LIBRECHAT_CODE_COMMAND_SANDBOX must be native-srt or runtime',
    );
  }
  const commandAllowedDomains = [
    ...new Set(list(process.env.LIBRECHAT_CODE_COMMAND_ALLOWED_DOMAINS)),
  ].sort();
  if (explicitWorkerDirectory && useDefaultWorkspace) {
    throw new Error(
      '--worker-dir and --default-workspace cannot be used together',
    );
  }
  const workerDirectory =
    explicitWorkerDirectory ??
    (useDefaultWorkspace
      ? defaultWorkspacePath({
          codeApiUrl,
          securityIdentity: workspaceSecurityIdentity(
            pairedIdentity?.publicKey,
            configuredToken,
          ),
          workerId,
          workspaceId,
        })
      : undefined);
  if (useDefaultWorkspace && workerDirectory) {
    await ensurePrivateWorkspaceDirectory(workerDirectory);
  }
  let canonicalWorkerDirectory: string | undefined;
  if (workerDirectory) {
    try {
      canonicalWorkerDirectory = await realpath(workerDirectory);
    } catch {
      throw new Error('Invalid workspace registration');
    }
  }
  const mutationQuarantinePath =
    (allowWorkspaceWrites || allowWorkspaceCommands) && canonicalWorkerDirectory
      ? workspaceQuarantinePath({
          codeApiUrl,
          workerId,
          workspaceRoot: canonicalWorkerDirectory,
        })
      : undefined;
  let workspaceTools: WorkspaceToolExecutor | undefined = workerDirectory
    ? await LocalWorkspaceTools.create({
        workspaces: [
          {
            id: workspaceId,
            name:
              option(args, '--workspace-name') ??
              process.env.LIBRECHAT_CODE_WORKSPACE_NAME?.trim() ??
              (useDefaultWorkspace
                ? workspaceId
                : defaultWorkspaceName(workerDirectory, workspaceId)),
            root: workerDirectory,
            writable: allowWorkspaceWrites,
          },
        ],
      })
    : undefined;
  if (allowWorkspaceCommands && !canonicalWorkerDirectory) {
    throw new Error('Workspace commands require a registered directory');
  }
  if (
    allowWorkspaceCommands &&
    commandSandboxMode === 'runtime' &&
    !nsjailDockerMode
  ) {
    throw new Error(
      'The runtime command sandbox requires the docker-nsjail runtime supervisor',
    );
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const incarnationId = randomBytes(18).toString('base64url');
  const runtimeImage =
    runtimeMode !== 'endpoint'
      ? runtimeSessionId == null
        ? required('LIBRECHAT_CODE_RUNTIME_IMAGE')
        : process.env.LIBRECHAT_CODE_RUNTIME_IMAGE?.trim()
      : undefined;
  const nsjailLaunchProfile =
    nsjailDockerMode && runtimeSessionId == null
      ? (() => {
          const seccompProfile = resolve(
            required('LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE'),
          );
          const packagesPath = resolve(
            required('LIBRECHAT_CODE_DOCKER_PACKAGES_PATH'),
          );
          return {
            seccompProfile,
            packagesPath,
            profileRevision: createHash('sha256')
              .update(readFileSync(seccompProfile))
              .digest('hex'),
          };
        })()
      : undefined;
  const executionManifestPublicKey = fileRelayEnabled
    ? required('LIBRECHAT_CODE_EXECUTION_MANIFEST_PUBLIC_KEY')
    : undefined;
  const fileRelayLimits = fileRelayEnabled
    ? {
        maxBytes: positiveInteger(
          'LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES',
          process.env.LIBRECHAT_CODE_FILE_RELAY_MAX_BYTES,
          16 * 1024 * 1024,
        ),
        timeoutMs: positiveInteger(
          'LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS',
          process.env.LIBRECHAT_CODE_FILE_RELAY_TIMEOUT_MS,
          30_000,
        ),
        maxConcurrentRequests: positiveInteger(
          'LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS',
          process.env.LIBRECHAT_CODE_FILE_RELAY_MAX_CONCURRENT_REQUESTS,
          8,
        ),
      }
    : undefined;
  const fileRelaySupervisor =
    fileRelayEnabled && fileRelayUpstream
      ? new DockerFileRelaySupervisor({
          workerId,
          incarnationId,
          image: required('LIBRECHAT_CODE_FILE_RELAY_IMAGE'),
          upstreamUrl: fileRelayUpstream,
          ...fileRelayLimits,
          token: createHmac(
            'sha256',
            pairedIdentity?.privateKey ??
              required('LIBRECHAT_CODE_WORKER_TOKEN', configuredToken),
          )
            .update('librechat-code-file-relay-v1')
            .digest('hex'),
        })
      : undefined;
  const fileRelayProfile = await fileRelaySupervisor?.prepare(
    controller.signal,
  );
  const workspaceMount =
    allowWorkspaceCommands &&
    commandSandboxMode === 'runtime' &&
    canonicalWorkerDirectory
      ? {
          source: canonicalWorkerDirectory,
          target: '/mnt/workspace',
        }
      : undefined;
  const workspaceCommandToken =
    allowWorkspaceCommands && commandSandboxMode === 'runtime'
      ? createHmac(
          'sha256',
          pairedIdentity?.privateKey ??
            required('LIBRECHAT_CODE_WORKER_TOKEN', configuredToken),
        )
          .update(
            `librechat-code-workspace-command-v1\0${canonicalWorkerDirectory}`,
          )
          .digest('base64url')
      : undefined;
  const runtimeSupervisor: RuntimeSupervisor =
    runtimeMode !== 'endpoint'
      ? new DockerRuntimeSupervisor({
          image: runtimeImage,
          ...(nsjailDockerMode && runtimeSessionId == null
            ? (() => {
                const { seccompProfile, packagesPath, profileRevision } =
                  nsjailLaunchProfile!;
                return {
                  capabilities: MACOS_NSJAIL_CAPABILITIES,
                  securityOptions: [`seccomp=${seccompProfile}`],
                  profileRevision,
                  restartStoppedContainers: false,
                  ...(fileRelayProfile ? { network: fileRelayProfile.network } : {}),
                  bindMounts: [
                    { source: packagesPath, target: '/pkgs', readOnly: true },
                    ...(workspaceMount ? [workspaceMount] : []),
                  ],
                  httpClient: 'bun' as const,
                  environment: {
                    SANDBOX_USE_CGROUPV2: 'false',
                    SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP: 'false',
                    ...(workspaceMount
                      ? {
                          SANDBOX_EXTERNAL_WORKSPACE_ENABLED: 'true',
                          SANDBOX_EXTERNAL_WORKSPACE_ROOT: workspaceMount.target,
                          SANDBOX_EXTERNAL_WORKSPACE_TOKEN: workspaceCommandToken!,
                        }
                      : {}),
                    ...(fileRelayProfile
                      ? {
                          EGRESS_GATEWAY_URL: fileRelayProfile.url,
                          SANDBOX_PRIME_CONCURRENCY: String(fileRelayLimits!.maxConcurrentRequests),
                          SANDBOX_UPLOAD_CONCURRENCY: String(fileRelayLimits!.maxConcurrentRequests),
                          SANDBOX_FILE_RELAY_TOKEN: fileRelayProfile.token,
                          SANDBOX_REQUIRE_EGRESS_MANIFEST: 'true',
                          SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: executionManifestPublicKey!,
                        }
                      : {}),
                  },
                };
              })()
            : workspaceMount
              ? {
                  bindMounts: [workspaceMount],
                  environment: {
                    SANDBOX_EXTERNAL_WORKSPACE_ENABLED: 'true',
                    SANDBOX_EXTERNAL_WORKSPACE_ROOT: workspaceMount.target,
                    SANDBOX_EXTERNAL_WORKSPACE_TOKEN: workspaceCommandToken!,
                  },
                }
              : {}),
        })
      : new EndpointRuntimeSupervisor({
          endpoint: sandboxEndpoint,
          statefulWorkspace,
        });
  const nativeCommandSandbox =
    allowWorkspaceCommands && commandSandboxMode === 'native-srt'
      ? new NativeSrtWorkspaceCommandSandbox({
          workspaceRoot: canonicalWorkerDirectory!,
          protectedPaths: [identityPath, mutationQuarantinePath].filter(
            (path): path is string => path != null,
          ),
          allowedDomains: commandAllowedDomains,
        })
      : undefined;
  try {
    await nativeCommandSandbox?.prepare();
  } catch (error) {
    await fileRelaySupervisor?.stop().catch(() => undefined);
    throw error;
  }
  if (allowWorkspaceCommands && workspaceTools) {
    workspaceTools = new SandboxWorkspaceTools({
      workspaceTools,
      commandWorkspaces: [workspaceId],
      commandSandbox:
        nativeCommandSandbox ??
        new RuntimeWorkspaceCommandSandbox({
          runtimeSupervisor,
          workerId,
          incarnationId,
        }),
    });
  }
  const capabilities = {
    statefulWorkspace,
    sandboxProfile:
      process.env.LIBRECHAT_CODE_SANDBOX_PROFILE ??
      (allowWorkspaceCommands && commandSandboxMode === 'native-srt'
        ? 'anthropic-srt'
        : runtimeMode.startsWith('docker')
          ? 'oci-docker'
          : 'nsjail'),
    runtimes: list(process.env.LIBRECHAT_CODE_RUNTIMES),
    policyDigest: createHash('sha256')
      .update(policy)
      .update(
        allowWorkspaceCommands && commandSandboxMode === 'native-srt'
          ? `\0native-srt\0${commandAllowedDomains.join('\0')}`
          : '',
      )
      .digest('hex'),
    ...(fileRelayEnabled ? { requiresReadyConfirmation: true } : {}),
    ...(workspaceTools ? { workspaceTools: workspaceTools.capabilities } : {}),
  };
  if (!isValidBridgeWorkerCapabilities(capabilities)) {
    throw new Error(
      'LIBRECHAT_CODE_SANDBOX_PROFILE or LIBRECHAT_CODE_RUNTIMES is invalid',
    );
  }
  try {
    const worker = new BridgeWorker({
      codeApiUrl,
      token: configuredToken,
      identity: workerIdentity,
      workerId,
      incarnationId,
      runtimeSupervisor,
      capabilities,
      workspaceTools,
      workspaceMutationQuarantine: mutationQuarantinePath
        ? {
            async assertAvailable() {
              const record = await loadWorkspaceMutationQuarantine(
                mutationQuarantinePath,
              );
              if (record != null) {
                throw new BridgeProtocolError(
                  `Workspace mutations are quarantined since ${record.quarantinedAt}: ${record.reason}. Inspect or restore the workspace, then run librechat-code clear-workspace-quarantine`,
                  undefined,
                  'WORKER_QUARANTINED',
                );
              }
            },
            async arm(reason) {
              await saveWorkspaceMutationQuarantine(mutationQuarantinePath, {
                version: 1,
                workerId,
                workspaceId,
                ownerId: incarnationId,
                quarantinedAt: new Date().toISOString(),
                reason,
              });
            },
            async clear() {
              await clearWorkspaceMutationQuarantine(
                mutationQuarantinePath,
                incarnationId,
              );
            },
            async quarantine() {
              await assertWorkspaceMutationQuarantineOwner(
                mutationQuarantinePath,
                incarnationId,
              );
            },
          }
        : undefined,
      onIdentityChange:
        pairedIdentity && identityPath
          ? async (identity) => {
              await saveBridgeIdentity(identityPath, {
                ...pairedIdentity,
                credential: identity.credential,
                expiresAt: identity.expiresAt,
              });
            }
          : undefined,
      onRegistered: fileRelaySupervisor
        ? async (registration) => {
            if (
              registration.registrationGeneration == null ||
              !Number.isSafeInteger(registration.registrationGeneration) ||
              registration.registrationGeneration < 1
            ) {
              throw new Error(
                'Code API does not support registration-ordered file relay activation',
              );
            }
            await fileRelaySupervisor.activate(
              registration.registrationGeneration,
              controller.signal,
            );
          }
        : undefined,
      onError: (error) => {
        const message =
          error instanceof Error ? error.message : 'unknown bridge error';
        process.stderr.write(`librechat-code: reconnecting after ${message}\n`);
      },
    });
    if (runtimeSessionId !== undefined) {
      await worker.refreshCredential(controller.signal);
      await worker.register(controller.signal);
      await worker.resetWorkspace(runtimeSessionId, controller.signal);
      process.stdout.write(
        `librechat-code: reset acknowledged for ${runtimeSessionId}\n`,
      );
      return;
    }
    await worker.run(controller.signal);
  } finally {
    await nativeCommandSandbox?.close();
    await fileRelaySupervisor?.stop();
  }
}

async function clearMutationQuarantine(args: string[]): Promise<void> {
  const configuredWorkerId = process.env.LIBRECHAT_CODE_WORKER_ID?.trim();
  const configuredIdentityPath = process.env.LIBRECHAT_CODE_IDENTITY_FILE?.trim();
  const configuredToken = process.env.LIBRECHAT_CODE_WORKER_TOKEN?.trim();
  const identityPath =
    configuredIdentityPath ??
    (configuredWorkerId && !configuredToken
      ? defaultBridgeIdentityPath(configuredWorkerId)
      : undefined);
  const pairedIdentity = identityPath
    ? await loadBridgeIdentity(identityPath)
    : undefined;
  const workerId = required(
    'LIBRECHAT_CODE_WORKER_ID',
    configuredWorkerId ?? pairedIdentity?.workerId,
  );
  const codeApiUrl = required(
    'LIBRECHAT_CODE_URL',
    process.env.LIBRECHAT_CODE_URL ?? pairedIdentity?.codeApiUrl,
  );
  const workspaceId =
    option(args, '--workspace-id') ??
    process.env.LIBRECHAT_CODE_WORKSPACE_ID?.trim() ??
    'primary';
  const explicitWorkerDirectory = nonEmpty(
    option(args, '--worker-dir') ?? process.env.LIBRECHAT_CODE_WORKER_DIR?.trim(),
  );
  const useDefaultWorkspace =
    args.includes('--default-workspace') ||
    process.env.LIBRECHAT_CODE_DEFAULT_WORKSPACE?.trim().toLowerCase() ===
      'true';
  if (explicitWorkerDirectory && useDefaultWorkspace) {
    throw new Error(
      '--worker-dir and --default-workspace cannot be used together',
    );
  }
  const workerDirectory =
    explicitWorkerDirectory ??
    (useDefaultWorkspace
      ? defaultWorkspacePath({
          codeApiUrl,
          securityIdentity: workspaceSecurityIdentity(
            pairedIdentity?.publicKey,
            configuredToken,
          ),
          workerId,
          workspaceId,
        })
      : undefined);
  const path = workspaceQuarantinePath({
    codeApiUrl,
    workerId,
    workspaceRoot: workerDirectory
      ? await realpath(workerDirectory)
      : undefined,
  });
  await clearWorkspaceMutationQuarantine(path);
  process.stdout.write(
    `librechat-code: cleared workspace mutation quarantine for ${workspaceId}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'relay') {
    await relay();
    return;
  }
  if (args[0] === 'pair') {
    await pair(args);
    return;
  }
  if (args[0] === 'reset-workspace') {
    const runtimeSessionId = args[1]?.trim();
    if (!runtimeSessionId) {
      throw new Error(
        'Usage: librechat-code reset-workspace <runtime-session-id>',
      );
    }
    await run(runtimeSessionId);
    return;
  }
  if (args[0] === 'clear-workspace-quarantine') {
    await clearMutationQuarantine(args.slice(1));
    return;
  }
  if (args[0] && args[0] !== 'run') {
    throw new Error(`Unknown command: ${args[0]}`);
  }
  await run(undefined, args.slice(1));
}
main().catch((error: Error) => {
  process.stderr.write(`librechat-code: ${error.message}\n`);
  process.exitCode = 1;
});
