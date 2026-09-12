import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BucketItemStat } from 'minio';

export interface ObjectResolverDependencies {
  bucket: string;
  list(prefix: string): AsyncIterable<{ name?: string }>;
  stat(key: string): Promise<BucketItemStat>;
  onIndexError?(operation: 'get' | 'set' | 'forget', error: unknown): void;
  index?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, replace: boolean): Promise<unknown>;
    forget(key: string, value: string): Promise<unknown>;
  };
}

/** Caller-supplied identities keep one stable storage key across replacement
 * filenames. This gives concurrent PUTs one last-writer-wins S3 object without
 * requiring a distributed lock or leaving extension-keyed siblings behind. */
export function storageKeyForUpload(
  session: string,
  id: string,
  extension: string,
  replacing: boolean,
  current?: string,
): string {
  return current ?? `${session}/${id}${replacing ? '' : extension}`;
}

/** Storage-key index is a hint, never metadata or authorization. A fresh HEAD
 * proves existence and supplies the current version even on index/cache hits. */
export class FileObjectResolver {
  constructor(private readonly deps: ObjectResolverDependencies) {}

  private reportIndexError(operation: 'get' | 'set' | 'forget', error: unknown): void {
    this.deps.onIndexError?.(operation, error);
  }

  private indexKey(session: string, id: string): string {
    return `codeapi:file-key:${createHash('sha256').update(JSON.stringify([this.deps.bucket, session, id])).digest('hex')}`;
  }

  private matches(key: string, session: string, id: string): boolean {
    return path.posix.dirname(key) === session &&
      (path.posix.basename(key) === id || path.posix.basename(key, path.posix.extname(key)) === id);
  }

  async remember(session: string, id: string, key: string, replace = true): Promise<void> {
    if (!this.matches(key, session, id)) throw new Error('Object key does not match storage identity');
    try {
      await this.deps.index?.set(this.indexKey(session, id), key, replace);
    } catch (error) {
      this.reportIndexError('set', error);
    }
  }

  /** Evict a cached locator once its object is known to be gone. Scoped to the
   * requested identity, and conditional on the stored value so a replacement
   * key published concurrently for the same identity is never dropped. */
  async forget(session: string, id: string, key: string): Promise<void> {
    if (!this.matches(key, session, id)) return;
    try {
      await this.deps.index?.forget(this.indexKey(session, id), key);
    } catch (error) {
      this.reportIndexError('forget', error);
    }
  }

  private async cached(session: string, id: string): Promise<string | undefined> {
    try {
      const key = await this.deps.index?.get(this.indexKey(session, id));
      return key && this.matches(key, session, id) ? key : undefined;
    } catch (error) {
      this.reportIndexError('get', error);
      return undefined;
    }
  }

  private async findInStorage(session: string, id: string, replaceIndex: boolean): Promise<string | undefined> {
    for await (const object of this.deps.list(`${session}/${id}`)) {
      if (object.name && this.matches(object.name, session, id)) {
        await this.remember(session, id, object.name, replaceIndex);
        return object.name;
      }
    }
    return undefined;
  }

  async resolve(session: string, id: string): Promise<string | undefined> {
    return await this.cached(session, id) ?? await this.findInStorage(session, id, false);
  }

  /** Resolve against storage even when the advisory index contains a match.
   * Destructive operations use this so an idempotent delete cannot succeed
   * against a stale key while leaving the current object untouched. */
  async resolveFresh(session: string, id: string): Promise<string | undefined> {
    const cached = await this.cached(session, id);
    const current = await this.findInStorage(session, id, true);
    if (!current && cached) await this.forget(session, id, cached);
    return current;
  }

  async metadata(session: string, id: string): Promise<{ key: string; stat: BucketItemStat } | undefined> {
    const key = await this.resolve(session, id);
    if (!key) return undefined;
    try {
      return { key, stat: await this.deps.stat(key) };
    } catch (error) {
      if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes((error as { code?: string }).code ?? '')) throw error;
      await this.forget(session, id, key);
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
