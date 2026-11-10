import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { resetSandboxDrainForTests, sandboxDrainSnapshot, startSandboxDrain } from '../drain';
import { validateDrainConfiguration } from './drain';
import { RUNNER_DRAIN_MESSAGE } from '../../../shared/drain-contract';
import v2Router from './v2';

let server: Server;
let baseUrl: string;
const originalMinDelay = config.drain_min_delay_ms;
const originalEnabled = config.graceful_drain_enabled;
const originalPublicKey = config.drain_public_key;
let stateDirectory: string;
const hostScript = join(__dirname, '../../../docker/sandbox-runner-drain.sh');

async function runHostHook(mode?: string): Promise<string> {
  const child = Bun.spawn(['bash', hostScript, ...(mode ? [mode] : [])], {
    env: { ...process.env, SANDBOX_DRAIN_STATE_DIR: stateDirectory, PORT: new URL(baseUrl || 'http://localhost:2000').port },
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(error);
  return output;
}

beforeAll(async () => {
  config.drain_min_delay_ms = 0;
  config.graceful_drain_enabled = true;
  stateDirectory = await mkdtemp(join(tmpdir(), 'runner-drain-'));
  await runHostHook('init');
  config.drain_public_key = await readFile(join(stateDirectory, 'public.b64'), 'utf8');
  validateDrainConfiguration();
  const app = express();
  app.use('/api/v2', v2Router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  baseUrl = `http://127.0.0.1:${address.port}/api/v2`;
});

afterEach(() => {
  resetSandboxDrainForTests();
  config.graceful_drain_enabled = true;
  config.drain_min_delay_ms = 0;
});

afterAll(async () => {
  config.drain_min_delay_ms = originalMinDelay;
  config.graceful_drain_enabled = originalEnabled;
  config.drain_public_key = originalPublicKey;
  resetSandboxDrainForTests();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(stateDirectory, { recursive: true, force: true });
});

describe('sandbox drain routes', () => {
  test('does not activate drain when the feature is disabled', async () => {
    config.graceful_drain_enabled = false;
    expect((await fetch(`${baseUrl}/drain`, { method: 'POST' })).status).toBe(404);
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).not.toBe(503);
  });
  test('rejects unsigned and foreign-pod drain requests without changing admission', async () => {
    expect((await fetch(`${baseUrl}/drain`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/drain`, { method: 'POST' })).status).toBe(403);
    const foreign = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(RUNNER_DRAIN_MESSAGE), foreign.privateKey).toString('base64');
    expect((await fetch(`${baseUrl}/drain`, {
      method: 'POST', headers: { 'X-CodeAPI-Drain-Signature': signature },
    })).status).toBe(403);
    expect(sandboxDrainSnapshot().draining).toBe(false);
  });
  test('advertises enough delay for endpoint propagation and validates the retry bound', async () => {
    config.drain_min_delay_ms = 5000;
    validateDrainConfiguration();
    startSandboxDrain();
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.headers.get('retry-after')).toBe('5');
    config.drain_min_delay_ms = 5001;
    expect(validateDrainConfiguration).toThrow('5-second');
  });
  test('fails readiness and rejects execution before validation after drain begins', async () => {
    // Run the actual host signer and curl hook against the real guest route.
    expect(JSON.parse(await runHostHook())).toEqual({ status: 'drained', activeExecutions: 0 });

    const readyResponse = await fetch(`${baseUrl}/ready`);
    expect(readyResponse.status).toBe(503);
    expect(await readyResponse.json()).toEqual({ status: 'draining', activeExecutions: 0 });

    const executeResponse = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(executeResponse.status).toBe(503);
    expect(executeResponse.headers.get('retry-after')).toBe(String(config.drain_retry_after_seconds));
    expect(executeResponse.headers.get('connection')).toBe('close');
    expect(await executeResponse.json()).toEqual({
      error: 'runner_draining',
      message: 'Sandbox runner is draining for shutdown',
    });
  });
});
