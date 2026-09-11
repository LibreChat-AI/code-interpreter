import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BucketItemStat } from 'minio';

export interface ObjectResolverDependencies {
  bucket: string;
  list(prefix: string): AsyncIterable<{ name?: string }>;
  stat(key: string): Promise<BucketItemStat>;
  index?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, replace: boolean): Promise<unknown>;
    forget(key: string, value: string): Promise<unknown>;
  };
}

/** Storage-key index is a hint, never metadata or authorization. A fresh HEAD
 * proves existence and supplies the current version even on index/cache hits. */
export class FileObjectResolver {
  constructor(private readonly deps: ObjectResolverDependencies) {}

  private indexKey(session: string, id: string): string {
    return `codeapi:file-key:${createHash('sha256').update(JSON.stringify([this.deps.bucket, session, id])).digest('hex')}`;
  }

  private matches(key: string, session: string, id: string): boolean {
    return path.posix.dirname(key) === session &&
      (path.posix.basename(key) === id || path.posix.basename(key, path.posix.extname(key)) === id);
  }

  async remember(session: string, id: string, key: string, replace = true): Promise<void> {
    if (!this.matches(key, session, id)) throw new Error('Object key does not match storage identity');
    await this.deps.index?.set(this.indexKey(session, id), key, replace);
  }

  async resolve(session: string, id: string): Promise<string | undefined> {
    const cached = await this.deps.index?.get(this.indexKey(session, id));
    if (cached && this.matches(cached, session, id)) return cached;
    for await (const object of this.deps.list(`${session}/${id}`)) {
      if (object.name && this.matches(object.name, session, id)) {
        await this.remember(session, id, object.name, false);
        return object.name;
      }
    }
    return undefined;
  }

  async metadata(session: string, id: string): Promise<{ key: string; stat: BucketItemStat } | undefined> {
    const key = await this.resolve(session, id);
    if (!key) return undefined;
    try {
      return { key, stat: await this.deps.stat(key) };
    } catch (error) {
      if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes((error as { code?: string }).code ?? '')) throw error;
      await this.deps.index?.forget(this.indexKey(session, id), key);
      // Do not cache absence: a later upload can publish this identity again.
      return undefined;
    }
  }
}

/** Bound storage metadata requests while preserving listing order. */
export async function mapObjectDetails<T, R>(objects: AsyncIterable<T>, describe: (object: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = [];
  const batch: T[] = [];
  const width = Math.max(1, Math.min(64, Math.floor(concurrency) || 1));
  for await (const object of objects) {
    batch.push(object);
    if (batch.length === width) {
      results.push(...await Promise.all(batch.map(describe)));
      batch.length = 0;
    }
  }
  results.push(...await Promise.all(batch.map(describe)));
  return results;
}
