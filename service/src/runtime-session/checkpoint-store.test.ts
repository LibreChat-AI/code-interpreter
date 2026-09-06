import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import { Readable } from 'node:stream';
import { env } from '../config';
import {
  MemoryCheckpointStore,
  MinioCheckpointStore,
  CheckpointTooLargeError,
  checkpointObjectKey,
  checkpointPrefixFor,
  resolveS3Endpoint,
} from './checkpoint-store';

const BIG = 1_000_000;

test('adds retention tags only for hosted-enabled checkpoint writers', async () => {
  const previous = env.HOSTED_APPS_ENABLED;
  const tags: Array<string | undefined> = [];
  const store = new MinioCheckpointStore({
    async send(command: unknown) {
      tags.push((command as { input: { Tagging?: string } }).input.Tagging);
      return {};
    },
  }, { bucket: 'test' });
  try {
    env.HOSTED_APPS_ENABLED = false;
    await store.put('source', 1, Buffer.from('workspace'));
    await store.commit('source', 1);
    env.HOSTED_APPS_ENABLED = true;
    await store.put('source', 2, Buffer.from('workspace'));
    await store.commit('source', 2);
    expect(tags).toEqual([undefined, undefined, 'codeapi-retention=rolling', 'codeapi-retention=rolling']);
  } finally { env.HOSTED_APPS_ENABLED = previous; }
});

test('stores create-only durable revision manifests and fails closed on storage errors', async () => {
  const objects = new Map<string, string>();
  let outage = false;
  const store = new MinioCheckpointStore({
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: any };
      if (outage) throw new Error('storage unavailable');
      if (c.constructor.name === 'PutObjectCommand') {
        expect(c.input.IfNoneMatch).toBe('*');
        expect(c.input.Tagging).toBe('codeapi-retention=hosted');
        if (objects.has(c.input.Key)) throw { $metadata: { httpStatusCode: 412 } };
        objects.set(c.input.Key, c.input.Body);
        return {};
      }
      const data = objects.get(c.input.Key);
      if (!data) throw { name: 'NoSuchKey' };
      return { Body: Readable.from([data]) };
    },
  }, { bucket: 'test' });
  const revision = { tenantId: 'tenant', canonicalUserId: 'user', sourceRuntimeSessionId: 'source',
    revision: 'rev1', specFingerprint: 'fingerprint', checkpointKey: 'snapshot' };
  expect(await store.readHostedAppRevision('app', 'rev1')).toBeNull();
  await store.retainHostedAppRevision('app', revision);
  expect(await store.retainHostedAppRevision('app', { ...revision, checkpointKey: 'later' })).toEqual(revision);
  expect(await store.readHostedAppRevision('app', 'rev1')).toEqual(revision);
  expect(await store.readHostedAppRevision('different-app', 'rev1')).toBeNull();
  outage = true;
  await expect(store.readHostedAppRevision('app', 'rev1')).rejects.toThrow('storage unavailable');
});

test('retained hosted snapshots survive subsequent source checkpoint pruning', async () => {
  const objects = new Map<string, string>();
  const source = checkpointObjectKey('rt_source', 1);
  objects.set(source, 'immutable revision');
  const store = new MinioCheckpointStore({
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: any };
      if (c.constructor.name === 'CopyObjectCommand') {
        expect(c.input.TaggingDirective).toBe('REPLACE');
        expect(c.input.Tagging).toBe('codeapi-retention=hosted');
        objects.set(c.input.Key, objects.get(decodeURIComponent(c.input.CopySource).slice(5))!);
      } else if (c.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [...objects.keys()].map(Key => ({ Key })) };
      } else if (c.constructor.name === 'DeleteObjectsCommand') {
        for (const { Key } of c.input.Delete.Objects) objects.delete(Key);
      }
      return {};
    },
  }, { bucket: 'test' });
  const retained = await store.retainForHostedApp('rt_source', source);
  objects.set(checkpointObjectKey('rt_source', 2), 'later workspace');
  await store.pruneOlderThan('rt_source', 2);
  expect(objects.has(source)).toBe(false);
  expect(objects.get(retained)).toBe('immutable revision');
  await expect(store.retainForHostedApp('another-source', source)).rejects.toThrow('outside');
});

async function readStored(
  store: MemoryCheckpointStore,
  runtimeSessionId: string,
  objectKey?: string,
): Promise<string | null> {
  const artifact = await store.get(runtimeSessionId, BIG, objectKey);
  if (!artifact) return null;
  try {
    return await fsp.readFile(artifact.path, 'utf8');
  } finally {
    await artifact.cleanup();
  }
}

describe('resolveS3Endpoint', () => {
  const cases: Array<{
    name: string;
    options: Parameters<typeof resolveS3Endpoint>[0];
    expected: string;
  }> = [
    {
      name: 'keeps the HTTPS default for a scheme-qualified S3 endpoint',
      options: { endpoint: 'https://s3.us-east-1.amazonaws.com' },
      expected: 'https://s3.us-east-1.amazonaws.com',
    },
    {
      name: 'keeps the HTTP default for a scheme-qualified endpoint',
      options: { endpoint: 'http://storage.example.com' },
      expected: 'http://storage.example.com',
    },
    {
      name: 'uses port 9000 for a bare MinIO service name',
      options: { endpoint: 'minio' },
      expected: 'http://minio:9000',
    },
    {
      name: 'uses SSL and port 9000 for a bare local endpoint',
      options: { endpoint: 'localhost', useSsl: true },
      expected: 'https://localhost:9000',
    },
    {
      name: 'preserves a URL port when MINIO_PORT is absent',
      options: { endpoint: 'http://minio.internal:9001' },
      expected: 'http://minio.internal:9001',
    },
    {
      name: 'lets MINIO_PORT override a port already present in the URL',
      options: {
        endpoint: 'https://s3.us-east-1.amazonaws.com:8443',
        port: '9443',
      },
      expected: 'https://s3.us-east-1.amazonaws.com:9443',
    },
    {
      name: 'lets MINIO_PORT override the bare-endpoint default',
      options: { endpoint: 'minio', port: '9001' },
      expected: 'http://minio:9001',
    },
  ];

  for (const { name, options, expected } of cases) {
    test(name, () => {
      expect(resolveS3Endpoint(options)).toBe(expected);
    });
  }
});

describe('checkpoint store', () => {
  test('the S3-compatible store aborts a hung underlying operation at its hard deadline', async () => {
    let observedAbort = false;
    const client = {
      send: (_command: unknown, options?: { abortSignal?: AbortSignal }) => (
        new Promise<never>((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(options.abortSignal?.reason);
          }, { once: true });
        })
      ),
    };
    const store = new MinioCheckpointStore(client, { bucket: 'test', timeoutMs: 10 });
    await expect(store.latestSequence('rt_hung')).rejects.toThrow('checkpoint list timed out');
    expect(observedAbort).toBe(true);
  });

  test('object key is per session + sequence, zero-padded for lexical order', () => {
    expect(checkpointObjectKey('rt_abc', 1)).toBe('rtsx-checkpoints/rt_abc/00000000000000000001.tar.gz');
    expect(checkpointPrefixFor('rt_abc')).toBe('rtsx-checkpoints/rt_abc/');
    /* zero-padding keeps lexical order == numeric sequence order across widths */
    expect(checkpointObjectKey('rt_abc', 2) > checkpointObjectKey('rt_abc', 1)).toBe(true);
    expect(checkpointObjectKey('rt_abc', 10) > checkpointObjectKey('rt_abc', 9)).toBe(true);
    expect(checkpointObjectKey('rt_xyz', 1)).not.toBe(checkpointObjectKey('rt_abc', 1));
  });

  test('S3 pruning chunks deletes at the 1,000-object API limit', async () => {
    const stale = Array.from(
      { length: 1_001 },
      (_, index) => ({ Key: checkpointObjectKey('rt_many', index + 1) }),
    );
    const deleteBatchSizes: number[] = [];
    const client = {
      send: (command: { constructor?: { name?: string }; input?: {
        Delete?: { Objects?: unknown[] };
      } }) => {
        if (command.constructor?.name === 'ListObjectsV2Command') {
          return Promise.resolve({ Contents: stale, IsTruncated: false });
        }
        if (command.constructor?.name === 'DeleteObjectsCommand') {
          deleteBatchSizes.push(command.input?.Delete?.Objects?.length ?? 0);
          return Promise.resolve({});
        }
        throw new Error(`unexpected command ${command.constructor?.name}`);
      },
    };
    const store = new MinioCheckpointStore(client, { bucket: 'test' });

    await store.pruneOlderThan('rt_many', 2_000);
    expect(deleteBatchSizes).toEqual([1_000, 1]);
  });

  test('S3 high-water selection ignores non-canonical keys in the prefix', async () => {
    const client = {
      send: () => Promise.resolve({
        Contents: [
          { Key: checkpointObjectKey('rt_keys', 5) },
          { Key: `${checkpointPrefixFor('rt_keys')}99999999999999999999-foreign.tar.gz` },
        ],
        IsTruncated: false,
      }),
    };
    const store = new MinioCheckpointStore(client, { bucket: 'test' });
    expect(await store.latestSequence('rt_keys')).toBe(5);
  });

  test('memory store round-trips the highest-sequence bytes and copies defensively', async () => {
    const store = new MemoryCheckpointStore();
    const original = Buffer.from('workspace-bytes');
    await store.put('rt_1', 1, original);
    await store.commit('rt_1', 1);

    expect(await readStored(store, 'rt_1')).toBe('workspace-bytes');
    /* stored copy is independent of the caller's buffer */
    original.fill(0);
    expect(await readStored(store, 'rt_1')).toBe('workspace-bytes');
  });

  test('absent checkpoint returns null', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.get('rt_missing', BIG)).toBeNull();
  });

  test('get reads the highest sequence, not the last write', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 2, Buffer.from('newer'));
    await store.commit('rt_1', 2);
    /* a crash-orphaned put from a LOWER sequence lands late but must NOT win */
    await store.put('rt_1', 1, Buffer.from('stale'));
    expect(await readStored(store, 'rt_1')).toBe('newer');
  });

  test('latestSequence reports the max retained sequence (for reset seeding)', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.latestSequence('rt_1')).toBe(0);
    await store.put('rt_1', 5, Buffer.from('v5'));
    expect(await store.latestSequence('rt_1')).toBe(5);
    /* other sessions don't leak into this one's max */
    await store.put('rt_2', 9, Buffer.from('v9'));
    expect(await store.latestSequence('rt_1')).toBe(5);
  });

  test('uncommitted late uploads are ignored and pruning is explicit', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 1, Buffer.from('v1'));
    await store.commit('rt_1', 1);
    await store.put('rt_1', 2, Buffer.from('v2'));
    await store.commit('rt_1', 2);
    await store.put('rt_1', 3, Buffer.from('uncommitted'));
    await store.put('rt_other', 1, Buffer.from('other'));
    expect(await readStored(store, 'rt_1')).toBe('v2');
    await store.pruneOlderThan('rt_1', 2);
    const keys = [...store.objects.keys()];
    expect(keys).toContain(checkpointObjectKey('rt_1', 2));
    expect(keys).not.toContain(checkpointObjectKey('rt_1', 1));
    expect(keys).toContain(checkpointObjectKey('rt_1', 3));
    expect(keys).toContain(checkpointObjectKey('rt_other', 1));
  });

  test('an exact fenced pointer wins over a newer recovery marker', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 1, Buffer.from('pointed'));
    await store.put('rt_1', 2, Buffer.from('newer-marker'));
    await store.commit('rt_1', 2);
    expect(
      await readStored(store, 'rt_1', checkpointObjectKey('rt_1', 1)),
    ).toBe('pointed');
  });

  test('recovery skips an orphan newest marker and uses an older valid pair', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 1, Buffer.from('recoverable'));
    await store.commit('rt_1', 1);
    store.committed.add(checkpointObjectKey('rt_1', 2));

    expect(await readStored(store, 'rt_1')).toBe('recoverable');

    await store.pruneOlderThan('rt_1', 3);
    expect(store.committed.has(checkpointObjectKey('rt_1', 1))).toBe(false);
    expect(store.committed.has(checkpointObjectKey('rt_1', 2))).toBe(false);
  });

  test('rejects a checkpoint larger than maxBytes', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_big', 1, Buffer.alloc(2048));
    await store.commit('rt_big', 1);
    await expect(store.get('rt_big', 1024)).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});
