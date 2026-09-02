#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { pairBridgeWorker } from './pairing.js';
import { startFileRelay } from './relay.js';
import { DockerFileRelaySupervisor } from './relay-runtime.js';
import {
  defaultBridgeIdentityPath,
  loadBridgeIdentity,
  saveBridgeIdentity,
} from './storage.js';
import { BridgeWorker } from './worker.js';
import { DockerRuntimeSupervisor, EndpointRuntimeSupervisor } from './runtime.js';
import { LocalWorkspaceTools } from './workspace.js';
import {
  isValidBridgeWorkerCapabilities,
  isValidBridgeWorkerId,
} from './protocol.js';

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
    runtimeMode !== 'docker-macos-nsjail'
  ) {
    throw new Error(
      'LIBRECHAT_CODE_RUNTIME_SUPERVISOR must be endpoint, docker, or docker-macos-nsjail',
    );
  }
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
    runtimeMode === 'docker-macos-nsjail' &&
    runtimeSessionId == null &&
    (fileRelayUpstream?.length ?? 0) > 0;
  const workerDirectory =
    runtimeSessionId == null
      ? option(args, '--worker-dir') ??
        process.env.LIBRECHAT_CODE_WORKER_DIR?.trim()
      : undefined;
  const workspaceId =
    option(args, '--workspace-id') ??
    process.env.LIBRECHAT_CODE_WORKSPACE_ID?.trim() ??
    'primary';
  const workspaceTools = workerDirectory
    ? await LocalWorkspaceTools.create({
        workspaces: [
          {
            id: workspaceId,
            name:
              option(args, '--workspace-name') ??
              process.env.LIBRECHAT_CODE_WORKSPACE_NAME?.trim() ??
              (basename(resolve(workerDirectory)) || workspaceId),
            root: workerDirectory,
          },
        ],
      })
    : undefined;
  const capabilities = {
    statefulWorkspace,
    sandboxProfile:
      process.env.LIBRECHAT_CODE_SANDBOX_PROFILE ??
      (runtimeMode.startsWith('docker') ? 'oci-docker' : 'nsjail'),
    runtimes: list(process.env.LIBRECHAT_CODE_RUNTIMES),
    policyDigest: createHash('sha256').update(policy).digest('hex'),
    ...(fileRelayEnabled ? { requiresReadyConfirmation: true } : {}),
    ...(workspaceTools ? { workspaceTools: workspaceTools.capabilities } : {}),
  };
  if (!isValidBridgeWorkerCapabilities(capabilities)) {
    throw new Error(
      'LIBRECHAT_CODE_SANDBOX_PROFILE or LIBRECHAT_CODE_RUNTIMES is invalid',
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
  const macLaunchProfile =
    runtimeMode === 'docker-macos-nsjail' && runtimeSessionId == null
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
  try {
    const worker = new BridgeWorker({
      codeApiUrl,
      token: configuredToken,
      identity: workerIdentity,
      workerId,
      incarnationId,
      runtimeSupervisor:
        runtimeMode !== 'endpoint'
          ? new DockerRuntimeSupervisor({
              image: runtimeImage,
              ...(runtimeMode === 'docker-macos-nsjail' && runtimeSessionId == null
                ? (() => {
                    const { seccompProfile, packagesPath, profileRevision } =
                      macLaunchProfile!;
                    return {
                      capabilities: MACOS_NSJAIL_CAPABILITIES,
                      securityOptions: [`seccomp=${seccompProfile}`],
                      profileRevision,
                      restartStoppedContainers: false,
                      ...(fileRelayProfile
                        ? { network: fileRelayProfile.network }
                        : {}),
                      bindMounts: [
                        {
                          source: packagesPath,
                          target: '/pkgs',
                          readOnly: true,
                        },
                      ],
                      httpClient: 'bun',
                      environment: {
                        SANDBOX_USE_CGROUPV2: 'false',
                        SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP: 'false',
                        ...(fileRelayProfile
                          ? {
                              EGRESS_GATEWAY_URL: fileRelayProfile.url,
                              SANDBOX_PRIME_CONCURRENCY: String(
                                fileRelayLimits!.maxConcurrentRequests,
                              ),
                              SANDBOX_UPLOAD_CONCURRENCY: String(
                                fileRelayLimits!.maxConcurrentRequests,
                              ),
                              SANDBOX_FILE_RELAY_TOKEN: fileRelayProfile.token,
                              SANDBOX_REQUIRE_EGRESS_MANIFEST: 'true',
                              SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY:
                                executionManifestPublicKey!,
                            }
                          : {}),
                      },
                    };
                  })()
                : {}),
            })
          : new EndpointRuntimeSupervisor({
              endpoint: sandboxEndpoint,
              statefulWorkspace,
            }),
      capabilities,
      workspaceTools,
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
    await fileRelaySupervisor?.stop();
  }
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
  if (args[0] && args[0] !== 'run') {
    throw new Error(`Unknown command: ${args[0]}`);
  }
  await run(undefined, args.slice(1));
}
main().catch((error: Error) => {
  process.stderr.write(`librechat-code: ${error.message}\n`);
  process.exitCode = 1;
});
