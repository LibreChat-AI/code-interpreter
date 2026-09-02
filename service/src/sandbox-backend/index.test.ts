import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'path';
import { env } from '../config';
import { HttpSandboxBackend } from './http';
import { getSandboxBackend, setSandboxBackendForTests } from './index';
import type { SandboxBackend } from './types';

const savedBackend = env.SANDBOX_BACKEND;

afterEach(() => {
  env.SANDBOX_BACKEND = savedBackend;
  setSandboxBackendForTests(undefined);
});

describe('getSandboxBackend', () => {
  test('defaults to the http backend and memoizes it', () => {
    const backend = getSandboxBackend();
    expect(backend).toBeInstanceOf(HttpSandboxBackend);
    expect(backend.name).toBe('http');
    expect(getSandboxBackend()).toBe(backend);
  });

  test('selects the lazy lambda-microvm backend when configured', () => {
    env.SANDBOX_BACKEND = 'lambda-microvm';
    const backend = getSandboxBackend();
    expect(backend.name).toBe('lambda-microvm');
  });

  test('selects the outbound remote bridge backend when configured', () => {
    env.SANDBOX_BACKEND = 'remote-bridge';
    const backend = getSandboxBackend();
    expect(backend.name).toBe('remote-bridge');
  });

  test('does not load Lambda-only modules for the HTTP backend', async () => {
    const serviceRoot = path.resolve(import.meta.dir, '../..');
    const probe = Bun.spawn([
      process.execPath,
      '-e',
      `
        process.env.CODEAPI_SANDBOX_BACKEND = 'http';
        const { getSandboxBackend } = await import('./src/sandbox-backend/index.ts');
        if (getSandboxBackend().name !== 'http') process.exit(2);
        const loaded = Object.keys(require.cache).filter((id) =>
          id.includes('/sandbox-backend/lambda-microvm.')
          || id.includes('/runtime-session/checkpoint-store.')
          || id.includes('/@aws-sdk/client-s3/')
          || id.includes('/@aws-sdk/client-lambda-microvms/')
        );
        console.log(JSON.stringify(loaded));
      `,
    ], {
      cwd: serviceRoot,
      env: { ...process.env, CODEAPI_SANDBOX_BACKEND: 'http' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null')).toEqual([]);
  });

  test('test seam replaces the active backend', () => {
    const fake: SandboxBackend = {
      name: 'http',
      execute: () => Promise.reject(new Error('unused')),
    };
    setSandboxBackendForTests(fake);
    expect(getSandboxBackend()).toBe(fake);
    setSandboxBackendForTests(undefined);
    expect(getSandboxBackend()).toBeInstanceOf(HttpSandboxBackend);
  });
});
