import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BucketItemStat } from 'minio';

const CANONICAL_OBJECT_DIRECTORY = '.codeapi-objects';

export function canonicalObjectKey(session: string, id: string): string {
  return `${session}/${CANONICAL_OBJECT_DIRECTORY}/${Buffer.from(id, 'utf8').toString('base64url')}`;
}

export function canonicalObjectId(key: string): string | undefined {
  const parts = key.split('/');
  if (parts.length !== 3 || parts[1] !== CANONICAL_OBJECT_DIRECTORY || parts[2] === '') return undefined;
  try {
    const id = Buffer.from(parts[2], 'base64url').toString('utf8');
    return canonicalObjectKey(parts[0], id) === key ? id : undefined;
  } catch {
    return undefined;
  }
}

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
): string {
  return replacing ? canonicalObjectKey(session, id) : `${session}/${id}${extension}`;
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
    if (key === canonicalObjectKey(session, id)) return true;
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
    for (const prefix of [canonicalObjectKey(session, id), `${session}/${id}`]) {
      for await (const object of this.deps.list(prefix)) {
        if (object.name && this.matches(object.name, session, id)) {
          await this.remember(session, id, object.name, replaceIndex);
          return object.name;
        }
      }
    }
    return undefined;
  }

  /** List every exact storage key for an identity without consulting its
   * locator. Used to collapse legacy siblings and delete the whole identity. */
  async listFresh(session: string, id: string): Promise<string[]> {
    const keys = new Set<string>();
    for (const prefix of [canonicalObjectKey(session, id), `${session}/${id}`]) {
      for await (const object of this.deps.list(prefix)) {
        if (object.name && this.matches(object.name, session, id)) keys.add(object.name);
      }
    }
    return [...keys];
  }

  async resolve(session: string, id: string): Promise<string | undefined> {
    return await this.cached(session, id) ?? await this.findInStorage(session, id, false);
  }

  /** Recover once a cached key is proven missing. Eviction and publication are
   * advisory; the authoritative storage listing determines the replacement. */
  async recover(session: string, id: string, missingKey: string): Promise<string | undefined> {
    await this.forget(session, id, missingKey);
    const [current] = await this.listFresh(session, id);
    if (current) await this.remember(session, id, current);
    return current;
  }

  async metadata(session: string, id: string): Promise<{ key: string; stat: BucketItemStat } | undefined> {
    let key = await this.resolve(session, id);
    if (!key) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { key, stat: await this.deps.stat(key) };
      } catch (error) {
        if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes((error as { code?: string }).code ?? '')) throw error;
        if (attempt === 1) {
          await this.forget(session, id, key);
          return undefined;
        }
        key = await this.recover(session, id, key);
        if (!key) return undefined;
      }
    }
    return undefined;
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
