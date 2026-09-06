import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import semver from 'semver';

import type { Runtime } from './runtime';
import {
  executeWorkspaceCommand,
  hasWorkspaceCommandToken,
  WorkspaceCommandRequestError,
} from './workspace-command';
import type { WorkspaceCommandExecutionOptions } from './workspace-command';

const runtime: Runtime = {
  language: 'bash',
  version: new semver.SemVer('5.2.0'),
  aliases: [],
  pkgdir: '/pkgs/bash/5.2.0',
  compiled: false,
  env_vars: { PATH: '/usr/bin:/bin' },
  timeouts: { compile: 30_000, run: 30_000 },
  cpu_times: { compile: 30_000, run: 30_000 },
  memory_limits: { compile: 256_000_000, run: 256_000_000 },
  max_process_count: 64,
  max_open_files: 2048,
  max_file_size: 10_000_000,
  output_max_size: 1024,
};

describe('sandboxed workspace commands', () => {
  test('requires an exact high-entropy runner capability', () => {
    const token = 'a'.repeat(32);
    expect(hasWorkspaceCommandToken(token, token)).toBe(true);
    expect(hasWorkspaceCommandToken(token, `${token}x`)).toBe(false);
    expect(hasWorkspaceCommandToken(token, undefined)).toBe(false);
    expect(hasWorkspaceCommandToken('short', 'short')).toBe(false);
  });

  test('passes command and canonical cwd as arguments to NsJail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      await mkdir(join(root, 'src'));
      let captured: Parameters<NonNullable<WorkspaceCommandExecutionOptions['executeNsJail']>>[0] | undefined;
      const response = await executeWorkspaceCommand({
        command: 'printf ok',
        cwd: 'src',
        timeoutMs: 1234,
        maxOutputBytes: 64,
      }, {
        workspaceRoot: root,
        runtime,
        executeNsJail: async (options) => {
          captured = options;
          return {
            stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
            memory: null, message: null, status: null, cpu_time: null, wall_time: 1,
          };
        },
      });

      expect(captured?.command).toEqual([
        '/bin/bash', '--noprofile', '--norc', '-c',
        'cd -- "$1" && exec /bin/bash --noprofile --norc -c "$2"',
        'librechat-code', '/mnt/data/src', 'printf ok',
      ]);
      expect(captured?.submissionDir).toBe(await realpath(root));
      expect(captured?.timeout).toBe(1234);
      expect(captured?.outputMaxSize).toBe(64);
      expect(response).toEqual({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a cwd symlink that escapes the mounted workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      const root = join(parent, 'root');
      await mkdir(root);
      await symlink(parent, join(root, 'escape'));
      await expect(executeWorkspaceCommand({
        command: 'pwd',
        cwd: 'escape',
      }, { workspaceRoot: root, runtime, executeNsJail: async () => { throw new Error('must not run'); } }))
        .rejects.toBeInstanceOf(WorkspaceCommandRequestError);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('rejects malformed requests before starting NsJail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      for (const body of [
        { command: '' },
        { command: 'pwd', cwd: '../outside' },
        { command: 'pwd', timeoutMs: 300_001 },
        { command: 'pwd', unexpected: true },
      ]) {
        await expect(executeWorkspaceCommand(body, {
          workspaceRoot: root,
          runtime,
          executeNsJail: async () => { throw new Error('must not run'); },
        })).rejects.toBeInstanceOf(WorkspaceCommandRequestError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds aggregate UTF-8 output and maps timeout state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      const response = await executeWorkspaceCommand({
        command: 'run',
        maxOutputBytes: 5,
      }, {
        workspaceRoot: root,
        runtime,
        executeNsJail: async () => ({
          stdout: '€€', stderr: 'tail', code: null, signal: 'SIGKILL', output: '',
          memory: null, message: 'Time limit exceeded', status: 'TO', cpu_time: null, wall_time: 1,
        }),
      });
      expect(Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr)).toBeLessThanOrEqual(5);
      expect(response).toEqual({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '€',
        stderr: 'ta',
        truncated: true,
        timedOut: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
