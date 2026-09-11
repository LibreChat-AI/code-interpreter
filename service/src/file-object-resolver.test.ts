import { describe, expect, test } from 'bun:test';
import { FileObjectResolver, mapObjectDetails } from './file-object-resolver';
import type { BucketItemStat } from 'minio';

describe('storage object resolution', () => {
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
