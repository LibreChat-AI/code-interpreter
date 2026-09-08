import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../config';
import { Job } from '../job';
import { loadPackage } from '../runtime';
import router from './v2';

let server: Server;
let url: string;
let directory: string;
const language = 'runtime-timeout-cap-test';
const originalPrime = Job.prototype.prime;
const originalExecute = Job.prototype.execute;
const originalCleanup = Job.prototype.cleanup;
const requireManifest = config.require_execution_manifest;
const observed: number[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runtime-timeout-'));
  await writeFile(join(directory, 'pkg-info.json'), JSON.stringify({
    language, version: '1.0.0', aliases: [],
    limit_overrides: { run_timeout: 15000, compile_timeout: 5000 },
  }));
  loadPackage(directory);
  const app = express();
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/execute`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => {
  Job.prototype.prime = originalPrime;
  Job.prototype.execute = originalExecute;
  Job.prototype.cleanup = originalCleanup;
  config.require_execution_manifest = requireManifest;
  observed.length = 0;
});

test('caps execution at the effective language runtime limit without rejecting larger caller caps', async () => {
  config.require_execution_manifest = false;
  Job.prototype.prime = async function () { observed.push(this.timeouts.run); };
  Job.prototype.execute = async function () { return {} as Awaited<ReturnType<Job['execute']>>; };
  Job.prototype.cleanup = async function () {};
  for (const [input, expected] of [[25000, 15000], [15000, 15000], [1000, 1000], [null, 15000], [undefined, 15000]]) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, version: '1.0.0', run_timeout: input, files: [{ name: 'main.txt', content: 'test' }] }),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(observed.at(-1)).toBe(expected);
  }
});

test('invalid runtime types and compile limit violations still fail before priming', async () => {
  config.require_execution_manifest = false;
  Job.prototype.prime = async function () { observed.push(this.timeouts.run); };
  for (const limits of [{ run_timeout: '1000' }, { run_timeout: -1 }, { compile_timeout: 6000 }]) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, version: '1.0.0', ...limits, files: [{ name: 'main.txt', content: 'test' }] }),
    });
    expect(response.status).toBe(400);
  }
  expect(observed).toEqual([]);
});
