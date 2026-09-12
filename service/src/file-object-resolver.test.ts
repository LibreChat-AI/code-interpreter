import { describe, expect, test } from 'bun:test';
import { canonicalObjectId, FileObjectResolver, mapObjectDetails, storageKeyForUpload } from './file-object-resolver';
import type { BucketItemStat } from 'minio';

describe('storage object resolution', () => {
  test('replacement uploads converge on one stable object key', () => {
    expect(storageKeyForUpload('s', 'id', '.csv', true)).toBe('s/.codeapi-objects/aWQ');
    expect(storageKeyForUpload('s', 'id', '.pdf', true)).toBe('s/.codeapi-objects/aWQ');
    expect(canonicalObjectId(storageKeyForUpload('s', 'report.csv', '', true))).toBe('report.csv');
    expect(storageKeyForUpload('s', 'generated', '.csv', false)).toBe('s/generated.csv');
  });

  test('canonical dotted identities cannot match another legacy identity', async () => {
    const dottedKey = storageKeyForUpload('s', 'report.csv', '', true);
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { yield { name: dottedKey }; },
      stat: async () => ({ metaData: {} } as BucketItemStat),
    });

    expect(await resolver.listFresh('s', 'report.csv')).toEqual([dottedKey]);
    expect(await resolver.listFresh('s', 'report')).toEqual([]);
  });

  test('indexes exact identities while reading fresh version metadata on every request', async () => {
    const index = new Map<string, string>();
    let lists = 0;
    let heads = 0;
    let version = 'first';
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { lists++; yield { name: 's/identifier.txt' }; yield { name: 's/id.txt' }; },
      stat: async key => { heads++; expect(key).toBe('s/id.txt'); return { size: 5, etag: 'etag', lastModified: new Date(), metaData: { 'codeapi-version': version } } as BucketItemStat; },
      index: { get: async k => index.get(k) ?? null, set: async (k, v) => index.set(k, v), forget: async k => index.delete(k) },
    });
    expect((await resolver.metadata('s', 'id'))?.stat.metaData['codeapi-version']).toBe('first');
    version = 'second';
    expect((await resolver.metadata('s', 'id'))?.stat.metaData['codeapi-version']).toBe('second');
    expect(lists).toBe(1);
    expect(heads).toBe(2);
  });

  test('ignores foreign-session index entries and does not cache absence', async () => {
    let present = false;
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { yield { name: 's2/id.txt' }; if (present) yield { name: 's/id.txt' }; },
      stat: async () => ({ metaData: {} } as BucketItemStat),
      index: { get: async () => 's2/id.txt', set: async () => {}, forget: async () => {} },
    });
    expect(await resolver.resolve('s', 'id')).toBeUndefined();
    present = true;
    expect(await resolver.resolve('s', 'id')).toBe('s/id.txt');
  });

  test('falls back to storage when the advisory index is unavailable', async () => {
    const failures: string[] = [];
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { yield { name: 's/id.txt' }; },
      stat: async () => ({ metaData: {} } as BucketItemStat),
      onIndexError: operation => failures.push(operation),
      index: {
        get: async () => { throw new Error('redis unavailable'); },
        set: async () => { throw new Error('redis unavailable'); },
        forget: async () => { throw new Error('redis unavailable'); },
      },
    });

    expect(await resolver.resolve('s', 'id')).toBe('s/id.txt');
    expect(await resolver.listFresh('s', 'id')).toEqual(['s/id.txt']);
    expect(failures).toEqual(['get', 'set']);
  });

  test('fresh listing ignores a stale locator and returns every exact sibling', async () => {
    const index = new Map([['locator', 's/id.txt']]);
    let lists = 0;
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () {
        lists++;
        yield { name: 's/identifier.txt' };
        yield { name: 's/id.csv' };
        yield { name: 's/id.pdf' };
      },
      stat: async () => ({ metaData: {} } as BucketItemStat),
      index: {
        get: async () => index.get('locator') ?? null,
        set: async (_key, value) => index.set('locator', value),
        forget: async (_key, value) => { if (index.get('locator') === value) index.delete('locator'); },
      },
    });

    expect(await resolver.listFresh('s', 'id')).toEqual(['s/id.csv', 's/id.pdf']);
    expect(index.get('locator')).toBe('s/id.txt');
    expect(lists).toBe(2);
  });

  test('metadata re-resolves storage after a cached locator is missing', async () => {
    const index = new Map([['locator', 's/id.txt']]);
    let heads = 0;
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { yield { name: 's/.codeapi-objects/aWQ' }; },
      stat: async key => {
        heads++;
        if (key === 's/id.txt') throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
        return {
          size: 1,
          etag: 'current',
          lastModified: new Date(),
          metaData: { 'codeapi-version': 'current' },
        } as BucketItemStat;
      },
      index: {
        get: async () => index.get('locator') ?? null,
        set: async (_key, value) => index.set('locator', value),
        forget: async (_key, value) => { if (index.get('locator') === value) index.delete('locator'); },
      },
    });

    const metadata = await resolver.metadata('s', 'id');
    expect(metadata?.key).toBe('s/.codeapi-objects/aWQ');
    expect(metadata?.stat.metaData['codeapi-version']).toBe('current');
    expect(index.get('locator')).toBe('s/.codeapi-objects/aWQ');
    expect(heads).toBe(2);
  });

  test('forgets a deleted locator so a replacement key for the same identity resolves', async () => {
    const index = new Map<string, string>();
    const stored = new Set(['s/id.txt']);
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* (prefix) { for (const name of stored) if (name.startsWith(prefix)) yield { name }; },
      stat: async () => ({ metaData: {} } as BucketItemStat),
      index: {
        get: async k => index.get(k) ?? null,
        set: async (k, v, replace) => { if (replace || !index.has(k)) index.set(k, v); },
        forget: async (k, v) => { if (index.get(k) === v) index.delete(k); },
      },
    });

    expect(await resolver.resolve('s', 'id')).toBe('s/id.txt');
    stored.delete('s/id.txt');
    await resolver.forget('s', 'id', 's/id.txt');
    expect(index.size).toBe(0);

    stored.add('s/id.csv');
    expect(await resolver.resolve('s', 'id')).toBe('s/id.csv');
  });

  test('eviction is scoped to the identity and never drops a newer cached key', async () => {
    const index = new Map<string, string>();
    let lists = 0;
    const resolver = new FileObjectResolver({
      bucket: 'files',
      list: async function* () { lists++; yield { name: 's/id.txt' }; },
      stat: async () => ({ metaData: {} } as BucketItemStat),
      index: {
        get: async k => index.get(k) ?? null,
        set: async (k, v, replace) => { if (replace || !index.has(k)) index.set(k, v); },
        forget: async (k, v) => { if (index.get(k) === v) index.delete(k); },
      },
    });

    expect(await resolver.resolve('s', 'id')).toBe('s/id.txt');
    // A concurrent upload republished the identity before the delete evicted it.
    await resolver.remember('s', 'id', 's/id.csv');
    await resolver.forget('s', 'id', 's/id.txt');
    // Keys outside the identity can never reach its entry.
    await resolver.forget('s', 'id', 's2/id.txt');
    await resolver.forget('s', 'id', 's/other.txt');

    expect(await resolver.resolve('s', 'id')).toBe('s/id.csv');
    expect(lists).toBe(1);
  });
});

test('metadata listing stays bounded and ordered across 240 objects', async () => {
  let active = 0;
  let maximum = 0;
  async function* objects() { for (let i = 0; i < 240; i++) yield i; }
  const result = await mapObjectDetails(objects(), async value => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, value % 3));
    active--;
    return value;
  }, 8);
  expect(maximum).toBe(8);
  expect(result).toEqual(Array.from({ length: 240 }, (_, i) => i));
});
