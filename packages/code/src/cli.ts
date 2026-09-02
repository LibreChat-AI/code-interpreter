#!/usr/bin/env node
import { createHash } from 'node:crypto';

import { pairBridgeWorker } from './pairing.js';
import {
  defaultBridgeIdentityPath,
  loadBridgeIdentity,
  saveBridgeIdentity,
} from './storage.js';
import { BridgeWorker } from './worker.js';
import { EndpointRuntimeSupervisor } from './runtime.js';
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
async function run(runtimeSessionId?: string): Promise<void> {
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
  const sandboxEndpoint =
    process.env.LIBRECHAT_CODE_SANDBOX_ENDPOINT ??
    'http://127.0.0.1:2000/api/v2';
  if (statefulWorkspace && !sandboxEndpoint.includes('{runtimeSessionId}')) {
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
  const capabilities = {
    statefulWorkspace,
    sandboxProfile: process.env.LIBRECHAT_CODE_SANDBOX_PROFILE ?? 'nsjail',
    runtimes: list(process.env.LIBRECHAT_CODE_RUNTIMES),
    policyDigest: createHash('sha256').update(policy).digest('hex'),
  };
  if (!isValidBridgeWorkerCapabilities(capabilities)) {
    throw new Error(
      'LIBRECHAT_CODE_SANDBOX_PROFILE or LIBRECHAT_CODE_RUNTIMES is invalid',
    );
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const worker = new BridgeWorker({
    codeApiUrl,
    token: configuredToken,
    identity: workerIdentity,
    workerId,
    runtimeSupervisor: new EndpointRuntimeSupervisor({
      endpoint: sandboxEndpoint,
      statefulWorkspace,
    }),
    capabilities,
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
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
  await run();
}
main().catch((error: Error) => {
  process.stderr.write(`librechat-code: ${error.message}\n`);
  process.exitCode = 1;
});
