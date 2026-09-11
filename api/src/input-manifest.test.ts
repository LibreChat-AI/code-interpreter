import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from './config';
import { Job } from './job';
import { SESSION_INPUT_CACHE_DIR } from './session-inputs';
import { fallbackSandboxIdentity } from './workspace-isolation';

const originalFetch = globalThis.fetch;
const originalConfig = { http_input_cache_enabled: config.http_input_cache_enabled, egress_gateway_url: config.egress_gateway_url };
const dirs: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  Object.assign(config, originalConfig);
  await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
  await Promise.all(keys.splice(0).flatMap(key => [key, `${key}.json`]).map(key => fsp.rm(path.join(SESSION_INPUT_CACHE_DIR, key), { force: true })));
});

async function fixture(count: number, mode: 'batch' | 'legacy' | 'race' = 'batch') {
  config.http_input_cache_enabled = true;
  config.egress_gateway_url = 'http://manifest.test';
  let manifests = 0, singlePreflights = 0, downloads = 0;
  const version = randomUUID();
  const freshVersion = randomUUID();
  const metadata = (id: string, v = version) => {
    const key = createHash('sha256').update(id + v).digest('hex');
    keys.push(key);
    return { cacheable: true, cacheKey: key, version: v, size: 5, readOnly: false };
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith('/objects')) return Response.json([]);
    if (pathname === '/input-manifest') {
      manifests++;
      if (mode === 'legacy') return new Response(null, { status: 404 });
      const request = JSON.parse(init!.body as string) as { files: { objectHandle: string }[] };
      expect(request.files).toHaveLength(count);
      return Response.json({ files: request.files.map(file => metadata(file.objectHandle)) });
    }
    if (pathname.endsWith('/metadata')) {
      singlePreflights++;
      return Response.json(metadata(pathname.split('/').slice(-2)[0], mode === 'race' ? freshVersion : version));
    }
    downloads++;
    if (mode === 'race' && new Headers(init?.headers).get('X-CodeAPI-Input-Version') === version) {
      return new Response(null, { status: 409 });
    }
    return new Response('bytes', { headers: { 'X-CodeAPI-Input-Version': mode === 'race' ? freshVersion : version } });
  }) as typeof fetch;
  async function prime(egressGrant = 'test-grant') {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'manifest-prime-'));
    dirs.push(dir);
    const session = {
      runtimeSessionId: 'test', acquire: async () => ({ dir, workspaceId: 'test', identity: fallbackSandboxIdentity() }),
      primedInputId: () => undefined, markPrimed: () => {}, markDirty: () => {},
    };
    const job = new Job({
      session_id: 'test', egress_grant: egressGrant, runtime: { language: 'bash', version: '5.0.0', aliases: [] },
      files: Array.from({ length: count }, (_, i) => ({ id: `f${i}`, storage_session_id: 's', name: `file${i}.txt` })),
      args: [], stdin: '', timeouts: { run: 5000, compile: 5000 }, cpu_times: { run: 5000, compile: 5000 },
      memory_limits: { run: 128e6, compile: 128e6 }, session,
    } as never);
    (job as unknown as { log: { level: string } }).log.level = 'silent';
    await job.prime();
    expect(await fsp.readFile(path.join(dir, 'file0.txt'), 'utf8')).toBe('bytes');
  }
  return { prime, counts: () => ({ manifests, singlePreflights, downloads }) };
}

test('240 inputs use one authorized manifest per fresh workspace and reuse only content', async () => {
  const f = await fixture(240);
  await f.prime();
  await f.prime();
  expect(f.counts()).toEqual({ manifests: 2, singlePreflights: 0, downloads: 240 });
}, 30000);

test('an older gateway falls back to independently authorized preflights', async () => {
  const f = await fixture(2, 'legacy');
  await f.prime();
  expect(f.counts()).toEqual({ manifests: 1, singlePreflights: 2, downloads: 2 });
});

test('a raced version consumes the batch entry and retries against fresh metadata', async () => {
  const f = await fixture(1, 'race');
  await f.prime();
  expect(f.counts()).toEqual({ manifests: 1, singlePreflights: 1, downloads: 2 });
});


test('one execution grant denial cannot fail a coalesced execution with its own valid grant', async () => {
  const f = await fixture(1);
  const underlying = globalThis.fetch;
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const creatorStarted = new Promise<void>(resolve => { started = resolve; });
  let deniedDownloads = 0, validDownloads = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/objects/f0')) {
      if (new Headers(init?.headers).get('X-CodeAPI-Egress-Grant') === 'denied') {
        deniedDownloads++;
        started(); await blocked;
        return new Response(null, { status: 403, headers: { 'X-CodeAPI-Error-Code': 'scope_mismatch' } });
      }
      validDownloads++;
    }
    return underlying(url, init);
  }) as typeof fetch;
  const creator = f.prime('denied');
  void creator.catch(() => {});
  await creatorStarted;
  const waiter = f.prime('valid');
  try {
    while (f.counts().manifests < 2) await Bun.sleep(1);
    await Bun.sleep(20);
  } finally { release(); }
  const result = await Promise.allSettled([creator, waiter]);
  expect(result.map(item => item.status)).toEqual(['rejected', 'fulfilled']);
  expect(deniedDownloads).toBe(1);
  expect(validDownloads).toBe(1);
});
