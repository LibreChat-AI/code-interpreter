import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

import { aggregateBashExtras } from './job';
import { execute, type NsJailResult } from './nsjail';
import { getLatestRuntimeMatchingLanguageVersion } from './runtime';
import type { Runtime } from './runtime';

const COMMAND_MAX_BYTES = 32 * 1024;
const COMMAND_MAX_TIMEOUT_MS = 5 * 60_000;
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const REQUEST_KEYS = new Set([
  'command',
  'cwd',
  'timeoutMs',
  'maxOutputBytes',
]);

export interface WorkspaceCommandBody {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface WorkspaceCommandResponse {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export class WorkspaceCommandRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceCommandRequestError';
  }
}

export interface WorkspaceCommandExecutionOptions {
  workspaceRoot: string;
  executeNsJail?: typeof execute;
  runtime?: Runtime;
}

function safePortablePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    value !== '..' &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((segment) => segment === '..') &&
    Buffer.from(value).toString('utf8') === value
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function hasWorkspaceCommandToken(
  expected: string,
  supplied: string | undefined,
): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied ?? '');
  return (
    expectedBytes.length >= 32 &&
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function validateBody(value: unknown): WorkspaceCommandBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceCommandRequestError('Command request must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    throw new WorkspaceCommandRequestError('Command request contains unexpected fields');
  }
  if (
    typeof body.command !== 'string' ||
    body.command.trim().length === 0 ||
    body.command.includes('\0') ||
    Buffer.from(body.command).toString('utf8') !== body.command ||
    Buffer.byteLength(body.command) > COMMAND_MAX_BYTES
  ) {
    throw new WorkspaceCommandRequestError('Command is invalid or exceeds its size limit');
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !safePortablePath(body.cwd))) {
    throw new WorkspaceCommandRequestError('Command working directory is invalid');
  }
  if (
    body.timeoutMs !== undefined &&
    !integerInRange(body.timeoutMs, 1, COMMAND_MAX_TIMEOUT_MS)
  ) {
    throw new WorkspaceCommandRequestError('Command timeout is invalid');
  }
  if (
    body.maxOutputBytes !== undefined &&
    !integerInRange(body.maxOutputBytes, 1, COMMAND_MAX_OUTPUT_BYTES)
  ) {
    throw new WorkspaceCommandRequestError('Command output limit is invalid');
  }
  return body as unknown as WorkspaceCommandBody;
}

function takeUtf8(value: string, budget: number): { value: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= budget) {
    return { value, bytes: encoded.byteLength, truncated: false };
  }
  let end = budget;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const bounded = encoded.subarray(0, end).toString('utf8');
  return { value: bounded, bytes: Buffer.byteLength(bounded), truncated: true };
}

function boundedResult(result: NsJailResult, maxOutputBytes: number): WorkspaceCommandResponse {
  const stdout = takeUtf8(result.stdout, maxOutputBytes);
  const stderr = takeUtf8(result.stderr, maxOutputBytes - stdout.bytes);
  const timedOut = result.status === 'TO' || /time limit/i.test(result.message ?? '');
  return {
    exitCode: result.signal || timedOut ? null : (result.code ?? 1),
    ...(result.signal ? { signal: result.signal } : {}),
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated || result.status === 'OL',
    timedOut,
  };
}

export async function executeWorkspaceCommand(
  rawBody: unknown,
  options: WorkspaceCommandExecutionOptions,
): Promise<WorkspaceCommandResponse> {
  const body = validateBody(rawBody);
  if (
    !path.isAbsolute(options.workspaceRoot) ||
    path.parse(options.workspaceRoot).root === options.workspaceRoot
  ) {
    throw new WorkspaceCommandRequestError('Configured workspace is unavailable');
  }
  const workspaceRoot = await fsp.realpath(options.workspaceRoot);
  const rootStat = await fsp.stat(workspaceRoot);
  if (!rootStat.isDirectory()) {
    throw new WorkspaceCommandRequestError('Configured workspace is unavailable');
  }
  const cwd = await fsp.realpath(path.resolve(workspaceRoot, body.cwd ?? '.'))
    .catch(() => { throw new WorkspaceCommandRequestError('Command working directory is unavailable'); });
  if (!isWithin(workspaceRoot, cwd) || !(await fsp.stat(cwd)).isDirectory()) {
    throw new WorkspaceCommandRequestError('Command working directory is unavailable');
  }
  const runtime = options.runtime ?? getLatestRuntimeMatchingLanguageVersion('bash', '*');
  if (!runtime) throw new Error('Bash runtime is unavailable');
  const envVars = {
    ...runtime.env_vars,
    HOME: '/mnt/data',
    SANDBOX_LANGUAGE: 'bash',
  };
  const extraPkgdirs = aggregateBashExtras(runtime.pkgdir, envVars);
  const relativeCwd = path.relative(workspaceRoot, cwd).split(path.sep).join('/');
  const result = await (options.executeNsJail ?? execute)({
    command: [
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      'cd -- "$1" && exec /bin/bash --noprofile --norc -c "$2"',
      'librechat-code',
      relativeCwd ? `/mnt/data/${relativeCwd}` : '/mnt/data',
      body.command,
    ],
    envVars,
    submissionDir: workspaceRoot,
    pkgdir: runtime.pkgdir,
    timeout: body.timeoutMs ?? 30_000,
    memoryLimit: runtime.memory_limits.run,
    outputMaxSize: body.maxOutputBytes ?? 256 * 1024,
    extraPkgdirs,
    identity: {
      slot: 0,
      uid: rootStat.uid,
      gid: rootStat.gid,
      perJobUid: true,
    },
  });
  return boundedResult(result, body.maxOutputBytes ?? 256 * 1024);
}
