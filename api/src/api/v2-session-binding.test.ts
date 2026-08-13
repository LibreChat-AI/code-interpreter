import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import * as fsp from 'fs/promises';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import { Job } from '../job';
import { loadPackage } from '../runtime';
import { ValidationError } from '../validation';
import {
  getBoundSessionWorkspace,
  resetSessionWorkspaceStateForTests,
  type SessionWorkspace,
} from '../session-workspace';
import v2Router from './v2';

let server: Server;
let baseUrl: string;
let packageDir: string;
const savedSessionWorkspaceEnabled = config.session_workspace_enabled;
const savedRequireExecutionManifest = config.require_execution_manifest;
const testLanguage = 'headerless-session-regression';
const testVersion = '1.0.0';

beforeAll(async () => {
  packageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'headerless-runtime-'));
  await fsp.writeFile(path.join(packageDir, 'pkg-info.json'), JSON.stringify({
    language: testLanguage,
    version: testVersion,
    aliases: [],
  }));
  loadPackage(packageDir);

  const app = express();
  app.use('/api/v2', v2Router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(packageDir, { recursive: true, force: true });
});

afterEach(() => {
  config.session_workspace_enabled = savedSessionWorkspaceEnabled;
  config.require_execution_manifest = savedRequireExecutionManifest;
  resetSessionWorkspaceStateForTests();
});

const execute = (runtimeSessionId?: string) =>
  fetch(`${baseUrl}/api/v2/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(runtimeSessionId ? { 'X-Runtime-Session-Id': runtimeSessionId } : {}),
    },
    body: JSON.stringify({
      language: testLanguage,
      version: testVersion,
      files: [{ name: 'main.txt', content: 'test' }],
    }),
  });

describe('per-request session binding', () => {
  test('a headerless execute does not inherit the runner session bound by a prior request', async () => {
    config.session_workspace_enabled = true;
    config.require_execution_manifest = false;

    const observedSessions: Array<SessionWorkspace | undefined> = [];
    const originalPrime = Job.prototype.prime;
    const originalExecute = Job.prototype.execute;
    const originalCleanup = Job.prototype.cleanup;

    Job.prototype.prime = async function primeWithoutFilesystem(): Promise<void> {
      observedSessions.push(
        (this as unknown as { session?: SessionWorkspace }).session,
      );
    };
    Job.prototype.execute = async function executeWithoutSandbox() {
      return {} as Awaited<ReturnType<Job['execute']>>;
    };
    Job.prototype.cleanup = async function cleanupWithoutFilesystem(): Promise<void> {};

    try {
      expect((await execute('rt_bound_once')).status).toBe(200);
      const bound = getBoundSessionWorkspace();
      expect(bound?.runtimeSessionId).toBe('rt_bound_once');

      expect((await execute()).status).toBe(200);
      expect(observedSessions).toEqual([bound, undefined]);
      expect(getBoundSessionWorkspace()).toBe(bound);
    } finally {
      Job.prototype.prime = originalPrime;
      Job.prototype.execute = originalExecute;
      Job.prototype.cleanup = originalCleanup;
    }
  });

  test('a different session receives a typed conflict so the control plane can recycle the runner', async () => {
    config.session_workspace_enabled = true;
    config.require_execution_manifest = false;

    const originalPrime = Job.prototype.prime;
    const originalExecute = Job.prototype.execute;
    const originalCleanup = Job.prototype.cleanup;

    Job.prototype.prime = async function primeWithoutFilesystem(): Promise<void> {};
    Job.prototype.execute = async function executeWithoutSandbox() {
      return {} as Awaited<ReturnType<Job['execute']>>;
    };
    Job.prototype.cleanup = async function cleanupWithoutFilesystem(): Promise<void> {};

    try {
      expect((await execute('rt_bound_once')).status).toBe(200);

      const response = await execute('rt_different_session');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'session_workspace_dirty',
        message: 'Runner is bound to a different runtime session',
      });
      expect(getBoundSessionWorkspace()?.runtimeSessionId).toBe('rt_bound_once');
    } finally {
      Job.prototype.prime = originalPrime;
      Job.prototype.execute = originalExecute;
      Job.prototype.cleanup = originalCleanup;
    }
  });

  test('a request with nothing runnable is rejected BEFORE anything is primed', async () => {
    config.session_workspace_enabled = true;
    config.require_execution_manifest = false;

    const originalPrime = Job.prototype.prime;
    const originalExecute = Job.prototype.execute;
    const originalCleanup = Job.prototype.cleanup;

    let primed = false;
    Job.prototype.prime = async function trackPrime(): Promise<void> {
      primed = true;
    };
    Job.prototype.execute = async function executeWithoutSandbox() {
      return {} as Awaited<ReturnType<Job['execute']>>;
    };
    Job.prototype.cleanup = async function cleanupWithoutFilesystem(): Promise<void> {};

    try {
      /* A lone `.dirkeep` plus a binary input satisfied the old gate (it only
       * asked for "some utf8 file"), so the request primed its writes into the
       * session workspace and only then failed the stricter check inside
       * execute. Session cleanup deliberately preserves the workspace, so those
       * writes stayed visible to the next execution. */
      const response = await fetch(`${baseUrl}/api/v2/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Runtime-Session-Id': 'rt_nothing_runnable',
        },
        body: JSON.stringify({
          language: testLanguage,
          version: testVersion,
          files: [
            { name: '.dirkeep', content: '' },
            { name: 'blob.bin', content: 'AA==', encoding: 'base64' },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      expect(body.error).toBeUndefined();
      expect(body.message).toContain('runnable source file');
      /* The point of the fix: the workspace was never touched. */
      expect(primed).toBe(false);
    } finally {
      Job.prototype.prime = originalPrime;
      Job.prototype.execute = originalExecute;
      Job.prototype.cleanup = originalCleanup;
    }
  });

  test('a post-prime failure still reports the workspace as dirty', async () => {
    config.session_workspace_enabled = true;
    config.require_execution_manifest = false;

    const originalPrime = Job.prototype.prime;
    const originalExecute = Job.prototype.execute;
    const originalCleanup = Job.prototype.cleanup;

    Job.prototype.prime = async function primeWithoutFilesystem(): Promise<void> {};
    Job.prototype.execute = async function executeFailingAfterPrime() {
      throw new ValidationError('files must include at least one runnable source file');
    };
    Job.prototype.cleanup = async function cleanupWithoutFilesystem(): Promise<void> {};

    try {
      /* Once priming has written to the workspace, ANY later failure leaves
       * state the next execute must not inherit silently — so the dirty signal
       * outranks the 400 here, even for a validation error. */
      const response = await execute('rt_dirty_after_prime');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'session_workspace_dirty',
        message: 'Session workspace must be restored before another execute',
      });
    } finally {
      Job.prototype.prime = originalPrime;
      Job.prototype.execute = originalExecute;
      Job.prototype.cleanup = originalCleanup;
    }
  });
});
