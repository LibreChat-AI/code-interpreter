import {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '../config';

interface S3SendClient {
    send(
        command: unknown,
        options?: { abortSignal?: AbortSignal },
    ): Promise<unknown>;
}

interface CheckpointStoreClientOptions {
    bucket?: string;
    timeoutMs?: number;
}

export function resolveS3Endpoint(options: {
    endpoint: string;
    port?: string;
    useSsl?: boolean;
}): string {
    const hasScheme = options.endpoint.includes('://');
    const protocol = options.useSsl === true ? 'https:' : 'http:';
    const parsed = new URL(
        hasScheme ? options.endpoint : `${protocol}//${options.endpoint}`,
    );
    const explicitPort = options.port?.trim();
    if (explicitPort) {
        /* MINIO_PORT is an explicit deployment override, including when the URL
         * already contains a different port. */
        parsed.port = explicitPort;
    } else if (!parsed.port && !hasScheme) {
        /* A bare endpoint is the local/MinIO shorthand and keeps MinIO's default.
         * An absolute URL instead keeps its scheme default (80/443). */
        parsed.port = '9000';
    }
    return parsed.toString().replace(/\/$/, '');
}

function s3Endpoint(): string {
    return resolveS3Endpoint({
        endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
        port: process.env.MINIO_PORT,
        useSsl: process.env.MINIO_USE_SSL?.trim().toLowerCase() === 'true',
    });
}

function createS3Client(): S3Client {
    const accessKeyId = process.env.MINIO_ACCESS_KEY?.trim();
    const secretAccessKey = process.env.MINIO_SECRET_KEY?.trim();
    return new S3Client({
        endpoint: s3Endpoint(),
        region:
            process.env.MINIO_REGION || process.env.AWS_REGION || 'us-east-1',
        forcePathStyle: true,
        ...(accessKeyId && secretAccessKey
            ? {
                  credentials: {
                      accessKeyId,
                      secretAccessKey,
                      ...(process.env.MINIO_SESSION_TOKEN
                          ? { sessionToken: process.env.MINIO_SESSION_TOKEN }
                          : {}),
                  },
              }
            : {}),
        /* Checkpoint bytes already have an immutable, fenced object key. Avoid
         * buffering streams for opportunistic SDK checksums; S3 TLS + SigV4 still
         * protect transport integrity and the archive parser validates structure. */
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}

/**
 * Durable storage for session workspace checkpoints. Each checkpoint writes a
 * distinct object under a per-session prefix keyed by a monotonic sequence
 * (`<prefix><runtime_session_id>/<sequence>.tar.gz`). The session registry points
 * at one exact immutable object; after that fenced pointer commits, a sibling
 * `.committed` marker makes the object eligible for recovery if Redis is later
 * lost. Restore never selects an uploaded-but-uncommitted object. The sequence
 * comes from an atomic Redis reservation (see `allocateCheckpointSequence`)
 * above both the counter and `latestSequence()`, so TTL reset recovery and
 * concurrent stale holders cannot collide and ordering has no dependence on
 * per-worker wall clocks. Older data and markers are best-effort pruned only
 * after the new pointer and marker commit.
 */
export interface CheckpointStore {
    /** Uploads immutable checkpoint data. This does not make it restorable or
     * prune prior checkpoints; the caller commits it only after its fenced
     * registry pointer succeeds. */
    put(
        runtimeSessionId: string,
        sequence: number,
        data: CheckpointArtifact | Buffer,
    ): Promise<void>;
    /** Writes the durable recovery marker for a checkpoint whose fenced pointer
     * has already committed. */
    commit(runtimeSessionId: string, sequence: number): Promise<void>;
    /** Best-effort garbage collection after commit. */
    pruneOlderThan(runtimeSessionId: string, sequence: number): Promise<void>;
    /** Reads the exact `objectKey`, or the highest-sequence durably committed
     * checkpoint when no pointer is available. `maxBytes` is enforced before and
     * during the streamed download. Throws {@link CheckpointTooLargeError} when
     * exceeded. */
    get(
        runtimeSessionId: string,
        maxBytes: number,
        objectKey?: string,
    ): Promise<CheckpointArtifact | null>;
    /** The highest sequence number retained under the session prefix (0 if none),
     *  used to re-seed a reset counter above already-stored objects. */
    latestSequence(runtimeSessionId: string): Promise<number>;
}

export class CheckpointTooLargeError extends Error {}

export interface CheckpointArtifact {
    path: string;
    size: number;
    cleanup(): Promise<void>;
}

export async function checkpointArtifactFromStream(
    stream: Readable,
    maxBytes: number,
    prefix = 'codeapi-checkpoint-',
): Promise<CheckpointArtifact> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const artifactPath = path.join(dir, 'workspace.tar.gz');
    let size = 0;
    const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            size += chunk.length;
            callback(
                size > maxBytes
                    ? new CheckpointTooLargeError(
                          `checkpoint exceeded maxBytes ${maxBytes}B`,
                      )
                    : null,
                chunk,
            );
        },
    });
    try {
        await pipeline(
            stream,
            limit,
            fs.createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 }),
        );
        return {
            path: artifactPath,
            size,
            cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
        };
    } catch (error) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function checkpointArtifactFromBuffer(
    data: Buffer,
): Promise<CheckpointArtifact> {
    return checkpointArtifactFromStream(Readable.from([data]), data.length);
}

/** Zero-padded so lexicographic key order matches numeric sequence order. */
const SEQUENCE_WIDTH = 20;

export function checkpointPrefixFor(runtimeSessionId: string): string {
    return `${env.CHECKPOINT_PREFIX}${runtimeSessionId}/`;
}

export function checkpointObjectKey(
    runtimeSessionId: string,
    sequence: number,
): string {
    return `${checkpointPrefixFor(runtimeSessionId)}${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.tar.gz`;
}

function checkpointCommitKey(
    runtimeSessionId: string,
    sequence: number,
): string {
    return `${checkpointObjectKey(runtimeSessionId, sequence)}.committed`;
}

/** Parse the sequence back out of a full object key (inverse of the key fn). */
function sequenceFromKey(key: string): number {
    const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.tar\.gz$/, '');
    const seq = Number.parseInt(base, 10);
    return Number.isFinite(seq) ? seq : 0;
}

/** S3/MinIO-backed store using the same MINIO_* envs as file-server. */
export class MinioCheckpointStore implements CheckpointStore {
    private readonly client: S3SendClient;
    private readonly bucket: string;
    private readonly timeoutMs: number;

    constructor(
        client?: S3SendClient,
        options: CheckpointStoreClientOptions = {},
    ) {
        this.client = client ?? createS3Client();
        /* `||` not `??`: an empty-string CODEAPI_CHECKPOINT_BUCKET must fall through
         * to MINIO_BUCKET (startup validation accepts the config when MINIO_BUCKET
         * is set, so `??` would otherwise select '' and fail every S3 op). */
        this.bucket =
            options.bucket ||
            process.env.CODEAPI_CHECKPOINT_BUCKET ||
            process.env.MINIO_BUCKET ||
            'test-bucket';
        this.timeoutMs = options.timeoutMs ?? env.CHECKPOINT_TIMEOUT_MS;
    }

    /** AWS SDK AbortSignal reaches the Node HTTP handler, so expiry destroys the
     * underlying socket and upload/download stream instead of merely abandoning
     * a still-running MinIO promise after the session lock has been released. */
    private async withDeadline<T>(
        label: string,
        operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(
                new Error(`${label} timed out after ${this.timeoutMs}ms`),
            );
        }, this.timeoutMs);
        timer.unref?.();
        try {
            return await operation(controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    private send<T>(label: string, command: unknown): Promise<T> {
        return this.withDeadline(
            label,
            async abortSignal =>
                (await this.client.send(command, { abortSignal })) as T,
        );
    }

    async put(
        runtimeSessionId: string,
        sequence: number,
        data: CheckpointArtifact | Buffer,
    ): Promise<void> {
        const key = checkpointObjectKey(runtimeSessionId, sequence);
        const size = Buffer.isBuffer(data) ? data.length : data.size;
        await this.withDeadline('checkpoint upload', async abortSignal => {
            const source = Buffer.isBuffer(data)
                ? data
                : fs.createReadStream(data.path, { signal: abortSignal });
            try {
                await this.client.send(
                    new PutObjectCommand({
                        Bucket: this.bucket,
                        Key: key,
                        Body: source,
                        ContentLength: size,
                        ContentType: 'application/x-gtar',
                    }),
                    { abortSignal },
                );
            } finally {
                if (!Buffer.isBuffer(source)) source.destroy();
            }
        });
    }

    async commit(runtimeSessionId: string, sequence: number): Promise<void> {
        const marker = Buffer.from('committed\n');
        await this.send(
            'checkpoint marker upload',
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: checkpointCommitKey(runtimeSessionId, sequence),
                Body: marker,
                ContentLength: marker.length,
                ContentType: 'text/plain',
            }),
        );
    }

    async pruneOlderThan(
        runtimeSessionId: string,
        sequence: number,
    ): Promise<void> {
        const keepKey = checkpointObjectKey(runtimeSessionId, sequence);
        const stale = (await this.listKeys(runtimeSessionId)).filter(key => {
            if (key.endsWith('.tar.gz')) return key < keepKey;
            if (key.endsWith('.tar.gz.committed')) {
                return key.slice(0, -'.committed'.length) < keepKey;
            }
            return false;
        });
        for (let offset = 0; offset < stale.length; offset += 1_000) {
            const chunk = stale.slice(offset, offset + 1_000);
            const result = await this.send<{
                Errors?: Array<{ Key?: string; Code?: string }>;
            }>(
                'checkpoint prune',
                new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: {
                        Objects: chunk.map(Key => ({ Key })),
                        Quiet: true,
                    },
                }),
            );
            if (result.Errors?.length) {
                throw new Error(
                    `Failed to prune checkpoint objects: ` +
                        result.Errors.map(
                            item => `${item.Key ?? '?'}:${item.Code ?? '?'}`,
                        ).join(', '),
                );
            }
        }
    }

    async latestSequence(runtimeSessionId: string): Promise<number> {
        const key = await this.latestKey(runtimeSessionId);
        return key ? sequenceFromKey(key) : 0;
    }

    async get(
        runtimeSessionId: string,
        maxBytes: number,
        objectKey?: string,
    ): Promise<CheckpointArtifact | null> {
        const key =
            objectKey ?? (await this.latestCommittedKey(runtimeSessionId));
        if (!key) return null;
        const prefix = checkpointPrefixFor(runtimeSessionId);
        if (!key.startsWith(prefix) || !key.endsWith('.tar.gz')) {
            throw new Error(
                'Checkpoint pointer is outside the runtime session prefix',
            );
        }
        let size: number;
        try {
            const stat = await this.send<{ ContentLength?: number }>(
                'checkpoint stat',
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            );
            size = stat.ContentLength ?? 0;
        } catch (error) {
            const code =
                (error as { code?: string; name?: string })?.code ??
                (error as { name?: string })?.name;
            const status = (
                error as { $metadata?: { httpStatusCode?: number } }
            )?.$metadata?.httpStatusCode;
            if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
                if (objectKey)
                    throw new Error(
                        `Committed checkpoint object is missing: ${key}`,
                    );
                return null;
            }
            throw error;
        }
        /* Reject before downloading, then enforce again while streaming in case the
         * object changes or a compatible store reports an inaccurate size. */
        if (size > maxBytes) {
            throw new CheckpointTooLargeError(
                `checkpoint ${size}B exceeds maxBytes ${maxBytes}B`,
            );
        }
        return this.withDeadline('checkpoint download', async abortSignal => {
            const result = (await this.client.send(
                new GetObjectCommand({ Bucket: this.bucket, Key: key }),
                { abortSignal },
            )) as { Body?: AsyncIterable<Uint8Array> };
            if (!result.Body)
                throw new Error('Checkpoint download response omitted Body');
            return checkpointArtifactFromStream(
                Readable.from(result.Body),
                maxBytes,
            );
        });
    }

    private async listKeys(runtimeSessionId: string): Promise<string[]> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        return this.withDeadline('checkpoint list', async abortSignal => {
            const keys: string[] = [];
            let ContinuationToken: string | undefined;
            do {
                const page = (await this.client.send(
                    new ListObjectsV2Command({
                        Bucket: this.bucket,
                        Prefix: prefix,
                        ContinuationToken,
                    }),
                    { abortSignal },
                )) as {
                    Contents?: Array<{ Key?: string }>;
                    IsTruncated?: boolean;
                    NextContinuationToken?: string;
                };
                for (const item of page.Contents ?? []) {
                    if (item.Key) keys.push(item.Key);
                }
                ContinuationToken = page.IsTruncated
                    ? page.NextContinuationToken
                    : undefined;
                if (page.IsTruncated && !ContinuationToken) {
                    throw new Error(
                        'Checkpoint list response omitted continuation token',
                    );
                }
            } while (ContinuationToken);
            return keys;
        });
    }

    private async latestKey(runtimeSessionId: string): Promise<string | null> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        const keys = (await this.listKeys(runtimeSessionId)).filter(
            key =>
                key.startsWith(prefix) &&
                /^\d{20}\.tar\.gz$/.test(key.slice(prefix.length)),
        );
        if (keys.length === 0) return null;
        return keys.reduce((max, key) => (key > max ? key : max));
    }

    private async latestCommittedKey(
        runtimeSessionId: string,
    ): Promise<string | null> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        const keys = await this.listKeys(runtimeSessionId);
        const available = new Set(keys);
        const markers = keys.filter(
            key =>
                key.startsWith(prefix) &&
                /^\d{20}\.tar\.gz\.committed$/.test(key.slice(prefix.length)),
        );
        if (markers.length === 0) return null;
        markers.sort().reverse();
        for (const marker of markers) {
            const dataKey = marker.slice(0, -'.committed'.length);
            if (available.has(dataKey)) return dataKey;
        }
        return null;
    }
}

/** In-memory store for bun tests. Keyed by full object key so latest-selection
 *  and pruning mirror the S3-backed store. */
export class MemoryCheckpointStore implements CheckpointStore {
    readonly objects = new Map<string, Buffer>();
    readonly committed = new Set<string>();

    async put(
        runtimeSessionId: string,
        sequence: number,
        data: CheckpointArtifact | Buffer,
    ): Promise<void> {
        const key = checkpointObjectKey(runtimeSessionId, sequence);
        this.objects.set(
            key,
            Buffer.isBuffer(data)
                ? Buffer.from(data)
                : await fsp.readFile(data.path),
        );
    }

    async commit(runtimeSessionId: string, sequence: number): Promise<void> {
        this.committed.add(checkpointObjectKey(runtimeSessionId, sequence));
    }

    async pruneOlderThan(
        runtimeSessionId: string,
        sequence: number,
    ): Promise<void> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        const keep = checkpointObjectKey(runtimeSessionId, sequence);
        for (const existing of this.objects.keys()) {
            if (existing.startsWith(prefix) && existing < keep) {
                this.objects.delete(existing);
                this.committed.delete(existing);
            }
        }
        for (const existing of this.committed) {
            if (existing.startsWith(prefix) && existing < keep) {
                this.committed.delete(existing);
            }
        }
    }

    async latestSequence(runtimeSessionId: string): Promise<number> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        let max = 0;
        for (const key of this.objects.keys()) {
            if (key.startsWith(prefix))
                max = Math.max(max, sequenceFromKey(key));
        }
        return max;
    }

    async get(
        runtimeSessionId: string,
        maxBytes: number,
        objectKey?: string,
    ): Promise<CheckpointArtifact | null> {
        const prefix = checkpointPrefixFor(runtimeSessionId);
        let latest = objectKey;
        if (!latest) {
            for (const key of this.committed) {
                if (
                    key.startsWith(prefix) &&
                    this.objects.has(key) &&
                    (latest === undefined || key > latest)
                )
                    latest = key;
            }
        }
        if (latest === undefined) return null;
        if (!latest.startsWith(prefix) || !latest.endsWith('.tar.gz')) {
            throw new Error(
                'Checkpoint pointer is outside the runtime session prefix',
            );
        }
        const data = this.objects.get(latest);
        if (!data) {
            if (objectKey)
                throw new Error(
                    `Committed checkpoint object is missing: ${latest}`,
                );
            return null;
        }
        if (data.length > maxBytes) {
            throw new CheckpointTooLargeError(
                `checkpoint ${data.length}B exceeds maxBytes ${maxBytes}B`,
            );
        }
        return checkpointArtifactFromBuffer(Buffer.from(data));
    }
}
