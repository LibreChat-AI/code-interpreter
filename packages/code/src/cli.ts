#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { BridgeWorker } from './worker.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const policy = process.env.LIBRECHAT_CODE_POLICY ?? 'default-deny';
const statefulWorkspace =
  process.env.LIBRECHAT_CODE_STATEFUL_WORKSPACE?.trim().toLowerCase() === 'true';
const sandboxEndpoint =
  process.env.LIBRECHAT_CODE_SANDBOX_ENDPOINT ??
  'http://127.0.0.1:2000/api/v2';
if (statefulWorkspace && !sandboxEndpoint.includes('{runtimeSessionId}')) {
  throw new Error(
    'LIBRECHAT_CODE_STATEFUL_WORKSPACE requires LIBRECHAT_CODE_SANDBOX_ENDPOINT to contain {runtimeSessionId}',
  );
}
const worker = new BridgeWorker({
  codeApiUrl: required('LIBRECHAT_CODE_URL'),
  token: required('LIBRECHAT_CODE_WORKER_TOKEN'),
  workerId: required('LIBRECHAT_CODE_WORKER_ID'),
  sandboxEndpoint,
  capabilities: {
    statefulWorkspace,
    sandboxProfile: process.env.LIBRECHAT_CODE_SANDBOX_PROFILE ?? 'nsjail',
    runtimes: list(process.env.LIBRECHAT_CODE_RUNTIMES),
    policyDigest: createHash('sha256').update(policy).digest('hex'),
  },
  onError: (error) => {
    const message = error instanceof Error ? error.message : 'unknown bridge error';
    process.stderr.write(`librechat-code: reconnecting after ${message}\n`);
  },
});

worker.run(controller.signal).catch((error: Error) => {
  process.stderr.write(`librechat-code: ${error.message}\n`);
  process.exitCode = 1;
});
