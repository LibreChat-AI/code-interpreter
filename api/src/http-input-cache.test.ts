import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fetchCachedHttpInput } from './http-input-cache';
import { hasCachedInput, SESSION_INPUT_CACHE_DIR } from './session-inputs';

const keys = new Set<string>();
afterEach(async () => {
  for (const key of keys) {
    await rm(path.join(SESSION_INPUT_CACHE_DIR, key), { force: true });
    await rm(path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`), { force: true });
  }
  keys.clear();
});
function fixture(body = 'input', principal = 'tenant/user') {
  const version = randomUUID();
  const cacheKey = createHash('sha256').update(principal + version).digest('hex');
  keys.add(cacheKey);
  const meta = { cacheable: true, version, cacheKey, size: Buffer.byteLength(body), readOnly: false, name: 'input.txt' };
  let reads = 0;
  let authorizations = 0;
  return {
    meta,
    counts: () => ({ reads, authorizations }),
    args: {
      maxBytes: 8192, maxObjects: 2, maxFileBytes: 8192, maxInflight: 4,
      metadata: async () => { authorizations++; return Response.json(meta); },
      download: async (expected: string, _signal: AbortSignal) => {
        reads++;
        expect(expected).toBe(version);
        return new Response(body, { headers: { 'X-CodeAPI-Input-Version': version } });
      },
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('authorized HTTP input cache', () => {
  test('fresh executions reuse bytes but authorize every hit', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const response = await fetchCachedHttpInput(f.args);
      expect(await response?.text()).toBe('input');
      expect(response?.headers.get('content-disposition')).toContain('input.txt');
    }
    expect(f.counts()).toEqual({ reads: 1, authorizations: 3 });
    expect(await hasCachedInput('', '', f.meta.cacheKey)).toBe(false); // Cannot bypass preflight using a pushed key.
    expect(await hasCachedInput('', '', f.meta.cacheKey, 'http')).toBe(true);
    const denied = await fetchCachedHttpInput({ ...f.args,
      metadata: async () => new Response(null, { status: 403, headers: { 'X-CodeAPI-Error-Code': 'scope_mismatch' } }),
    });
    expect(denied?.status).toBe(403);
    expect(f.counts().reads).toBe(1);
  });

  test('new versions and principals never reuse an existing version key', async () => {
    for (const [body, principal] of [['old', 'tenant/user'], ['new', 'tenant/user'], ['private', 'another-tenant/user']]) {
      const f = fixture(body, principal);
      expect(await (await fetchCachedHttpInput(f.args))?.text()).toBe(body);
      expect(f.counts().reads).toBe(1);
    }
  });

  test('coalesces misses while one cancelled caller leaves the remaining reader intact', async () => {
    const f = fixture();
    const started = gate();
    const finish = gate();
    let downloads = 0;
    let sharedSignal: AbortSignal | undefined;
    const args = { ...f.args, download: async (version: string, signal: AbortSignal) => {
      downloads++; sharedSignal = signal; started.release();
      await finish.promise;
      return f.args.download(version, signal);
    } };
    const controller = new AbortController();
    const first = fetchCachedHttpInput({ ...args, signal: controller.signal });
    const second = fetchCachedHttpInput(args);
    await started.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new Error('first cancelled'));
    await expect(first).rejects.toThrow('first cancelled');
    expect(sharedSignal?.aborted).toBe(false);
    finish.release();
    expect(await (await second)?.text()).toBe('input');
    expect(downloads).toBe(1);
    expect(f.counts().authorizations).toBe(2);
  });

  test('a shared fill does not propagate its creator grant denial to a valid waiter', async () => {
    const f = fixture();
    const started = gate();
    const finish = gate();
    const denied = fetchCachedHttpInput({ ...f.args, download: async () => {
      started.release();
      await finish.promise;
      return new Response(null, { status: 403, headers: { 'X-CodeAPI-Error-Code': 'request_budget_exceeded' } });
    } });
    await started.promise;
    const valid = fetchCachedHttpInput(f.args);
    await Bun.sleep(10);
    finish.release();
    expect((await denied)?.status).toBe(403);
    // Job.fetchInputObject uses the waiter's own normal download on undefined.
    expect(await valid).toBeUndefined();
    expect(await (await f.args.download(f.meta.version, new AbortController().signal)).text()).toBe('input');
    expect(f.counts().authorizations).toBe(2);
  });

  test('last-reader cancellation aborts the upstream fill without publishing', async () => {
    const f = fixture();
    const started = gate();
    const aborted = gate();
    const controller = new AbortController();
    const pending = fetchCachedHttpInput({ ...f.args, signal: controller.signal,
      download: async (_version, signal) => {
        started.release();
        return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => {
          aborted.release(); reject(signal.reason);
        }, { once: true }));
      },
    });
    await started.promise;
    controller.abort(new Error('cancel fill'));
    await expect(pending).rejects.toThrow('cancel fill');
    await aborted.promise;
    expect(await hasCachedInput('', '', f.meta.cacheKey, 'http')).toBe(false);
  });

  test('changed-version and oversized responses are never published', async () => {
    const f = fixture();
    const changed = await fetchCachedHttpInput({ ...f.args, download: async () => new Response('changed', {
      headers: { 'X-CodeAPI-Input-Version': randomUUID() },
    }) });
    expect(changed).toBeUndefined();
    expect(await hasCachedInput('', '', f.meta.cacheKey, 'http')).toBe(false);
    await expect(fetchCachedHttpInput({ ...f.args, download: async () => new Response('too many bytes', {
      headers: { 'X-CodeAPI-Input-Version': f.meta.version },
    }) })).rejects.toThrow();
    expect(await hasCachedInput('', '', f.meta.cacheKey, 'http')).toBe(false);
  });

  test('cache quotas evict old entries and preserve an already-open reader', async () => {
    const first = fixture('a'.repeat(4000));
    const second = fixture('b'.repeat(4000));
    const response = await fetchCachedHttpInput({ ...first.args, maxObjects: 1 });
    expect(await (await fetchCachedHttpInput({ ...second.args, maxObjects: 1 }))?.text()).toBe('b'.repeat(4000));
    expect(await hasCachedInput('', '', first.meta.cacheKey, 'http')).toBe(false);
    expect(await response?.text()).toBe('a'.repeat(4000));
  });

  test('legacy metadata protocols fall back without a cache read or fill', async () => {
    const f = fixture();
    expect(await fetchCachedHttpInput({ ...f.args, metadata: async () => new Response(null, { status: 404 }) })).toBeUndefined();
    expect(await fetchCachedHttpInput({ ...f.args, metadata: async () => Response.json({ cacheable: false }) })).toBeUndefined();
    expect(f.counts().reads).toBe(0);
  });
});
