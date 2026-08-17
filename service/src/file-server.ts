import b from 'busboy';
import path from 'path';
import IORedis from 'ioredis';
import express from 'express';
import { Client } from 'minio';
import { nanoid } from 'nanoid';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import type { BucketItem, BucketItemStat, ClientOptions } from 'minio';
import type { Readable } from 'stream';
import type * as tls from 'tls';
import type * as t from './types';
import { metricsHandler, fileUploads, fileDownloads } from './metrics';
import { httpMetricsMiddleware } from './middleware/httpMetrics';
import {
    internalServiceAuthEnabled,
    requireInternalServiceAuth,
} from './internal-service-auth';
import { shutdownTelemetry, traceHttpRequest } from './telemetry';
import logger from './fileServerLogger';
import { env } from './config';
import { redisKeepAliveOptions } from './redis-options';

const { INSTANCE_ID } = env;

const app = express();
app.disable('x-powered-by');
app.use(traceHttpRequest('codeapi.file_server.request'));
app.use(httpMetricsMiddleware);

const bucketName = process.env.MINIO_BUCKET ?? 'test-bucket';

type IamProviderModule = {
    IamAwsProvider?: new (opts: object) => unknown;
    default?: new (opts: object) => unknown;
};

async function createMinioClient(): Promise<Client> {
    const irsaExplicit = process.env.MINIO_USE_IRSA?.toLowerCase() === 'true';
    const irsaEnvVars =
        Boolean(process.env.AWS_WEB_IDENTITY_TOKEN_FILE) &&
        Boolean(process.env.AWS_ROLE_ARN);
    const useIrsa = irsaExplicit || irsaEnvVars;

    const baseConfig: ClientOptions = {
        endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
        port:
            process.env.MINIO_NO_PORT?.toLowerCase() === 'true'
                ? undefined
                : parseInt(process.env.MINIO_PORT ?? '9000'),
        useSSL: process.env.MINIO_USE_SSL?.toLowerCase() === 'true',
        region:
            process.env.MINIO_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    };

    if (useIrsa) {
        logger.info('Using IRSA (IamAwsProvider) for S3 authentication', {
            tokenFile: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
            roleArn: process.env.AWS_ROLE_ARN,
            region: baseConfig.region,
        });

        /** IamAwsProvider exists in minio 8.0.6+ but isn't exported from main module
         * Try multiple import paths for compatibility with different runtimes (bun, ts-node, node)
         */
        let IamAwsProviderClass: new (opts: object) => unknown;
        try {
            const mod =
                (await import('minio/dist/main/IamAwsProvider.js')) as IamProviderModule;
            IamAwsProviderClass = (mod.IamAwsProvider ?? mod.default)!;
        } catch (primaryError) {
                try {
                    // Fallback for bun: resolve path using require if available (CJS context)
                    let resolvePath = 'node_modules/minio/';
                    try {
                        resolvePath = require
                            .resolve('minio')
                            .replace(/dist\/.*$/, '');
                    } catch {
                    // require.resolve not available (ESM context), use default path
                }
                const mod = (await import(
                    `${resolvePath}dist/main/IamAwsProvider.js`
                )) as IamProviderModule;
                IamAwsProviderClass = (mod.IamAwsProvider ?? mod.default)!;
            } catch (fallbackError) {
                logger.error('Failed to load IamAwsProvider', {
                    primaryError,
                    fallbackError,
                });
                throw new Error(
                    'Could not load IamAwsProvider for IRSA authentication. Ensure minio >= 8.0.6 is installed.',
                );
            }
        }

        const credentialsProvider = new IamAwsProviderClass({});

        return new Client({
            ...baseConfig,
            credentialsProvider:
                credentialsProvider as ClientOptions['credentialsProvider'],
        });
    }

    logger.info('Using explicit credentials for MinIO/S3 authentication');
    return new Client({
        ...baseConfig,
        accessKey: process.env.MINIO_ACCESS_KEY ?? '',
        secretKey: process.env.MINIO_SECRET_KEY ?? '',
        sessionToken: process.env.MINIO_SESSION_TOKEN,
    });
}

let minioClient: Client;
let storageInitialized = false;

const useAltDnsLookup = process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true';

const redisClient = new IORedis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    enableReadyCheck: false,
    tls:
        process.env.REDIS_TLS === 'true'
            ? ({
                  // For self-signed certificates
                  rejectUnauthorized: false,
              } as tls.ConnectionOptions)
            : undefined,
    connectTimeout: 10000,
    ...redisKeepAliveOptions(),
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number {
        const delay = Math.min(times * 500, 2000);
        return delay;
    },
    reconnectOnError(err: Error): boolean {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    },
    // Alternative DNS lookup for AWS ElastiCache TLS connections
    ...(useAltDnsLookup
        ? {
              dnsLookup: (
                  address: string,
                  callback: (err: Error | null, addr: string) => void,
              ): void => callback(null, address),
          }
        : {}),
});

redisClient.on('error', err => {
    logger.error('Redis Client Error', { error: err });
});

redisClient.on('connect', () => {
    logger.info('Redis Client Connected', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    });
});

redisClient.on('ready', () => {
    logger.info('Redis Client Ready');
});

const minioRegion =
    process.env.MINIO_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

async function ensureBucketExists(retries = 10, delay = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const exists = await minioClient.bucketExists(bucketName);
            if (exists) {
                logger.info('Bucket already exists');
                return;
            }
            await minioClient.makeBucket(bucketName, minioRegion);
            logger.info('Bucket created successfully');
            return;
        } catch (err: unknown) {
            const error = err as { code?: string; message?: string };
            if (error.code === 'BucketAlreadyOwnedByYou') {
                logger.info('Bucket already exists');
                return;
            }

            if (attempt < retries) {
                const backoff = delay * Math.pow(2, attempt - 1);
                logger.warn(
                    `MinIO not ready, retrying in ${backoff}ms (attempt ${attempt}/${retries})`,
                    { error: error.message },
                );
                await new Promise(resolve => setTimeout(resolve, backoff));
            } else {
                logger.error(
                    'Failed to ensure bucket exists after all retries',
                    { error },
                );
                throw err;
            }
        }
    }
}

async function initializeStorage(): Promise<void> {
    minioClient = await createMinioClient();
    await ensureBucketExists();
    storageInitialized = true;
    logger.info('Storage initialization complete');
}

/**
 * Peeks the first chunk to detect 0-byte streams up front. MinIO multipart
 * upload aborts with `"You must specify at least one part"` when the stream
 * yields no data — empty inputs (e.g. Python `__init__.py`, our `.dirkeep`
 * empty-folder marker) are common and must be storable. Empty streams
 * resolve with `empty: true`; non-empty streams resolve with a PassThrough
 * that replays the peeked first chunk and the rest of the upstream.
 */
function peekStreamForEmpty(
    input: Readable,
): Promise<{ empty: true } | { empty: false; body: Readable }> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
            input.removeListener('data', onData);
            input.removeListener('end', onEnd);
            input.removeListener('error', onError);
        };
        function onError(err: Error): void {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        }
        function onEnd(): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ empty: true });
        }
        function onData(firstChunk: Buffer | string): void {
            if (settled) return;
            settled = true;
            cleanup();
            input.pause();
            const passthrough = new PassThrough();
            const buf = Buffer.isBuffer(firstChunk)
                ? firstChunk
                : Buffer.from(firstChunk);
            passthrough.write(buf);
            input.pipe(passthrough);
            input.once('error', err => passthrough.destroy(err));
            resolve({ empty: false, body: passthrough });
        }
        input.once('data', onData);
        input.once('end', onEnd);
        input.once('error', onError);
    });
}

async function uploadFile(
    session_id: string,
    fileStream: Readable,
    filename: string,
    mimetype: string,
    existingFileId?: string,
    readOnly = false,
): Promise<t.UploadResult> {
    const fileId = existingFileId ?? nanoid();
    const fileExtension = path.extname(filename);
    const objectName = `${session_id}/${fileId}${fileExtension}`;

    const encodedFilename = Buffer.from(filename).toString('base64');

    /* `X-Amz-Meta-Read-Only: true` declares this file as infrastructure the
     * uploader doesn't want surfaced as a generated artifact downstream
     * (e.g. skill files primed by LibreChat). Stored as an MinIO/S3 user
     * metadata header so it persists with the object and is exposed on
     * `getObject` / `statObject` without a separate Redis lookup. */
    const metaData: Record<string, string> = {
        'Content-Type': mimetype,
        'X-Amz-Meta-Original-Filename': encodedFilename,
        'X-Amz-Meta-Original-Filename-Encoded': 'base64',
    };
    if (readOnly) {
        metaData['X-Amz-Meta-Read-Only'] = 'true';
    }

    /* Note: this returns UploadedObjectInfo */
    const sessionKey = await redisClient.get(`session:${session_id}`);
    const peeked = await peekStreamForEmpty(fileStream);
    if (peeked.empty) {
        /* Empty file: explicit single PUT with size=0 — multipart fails with
         * "You must specify at least one part" on zero-byte streams. */
        await minioClient.putObject(
            bucketName,
            objectName,
            Buffer.alloc(0),
            0,
            metaData,
        );
    } else {
        await minioClient.putObject(
            bucketName,
            objectName,
            peeked.body,
            undefined,
            metaData,
        );
    }
    logger.info(
        `[${INSTANCE_ID}] File ID: ${fileId} | Filename: ${filename} | Session key: ${sessionKey}`,
    );
    await redisClient.set(
        `upload:${sessionKey}${session_id}${fileId}`,
        'true',
        'EX',
        env.SESSION_CACHE_TTL,
    );
    fileUploads.inc();

    return {
        filename,
        fileId,
    };
}

app.get('/metrics', metricsHandler);

app.get('/health', (_req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/ready', async (_req: express.Request, res: express.Response) => {
    const checks: { redis?: string; s3?: string; storage?: string } = {};
    let healthy = true;

    if (!storageInitialized) {
        checks.storage = 'initializing';
        healthy = false;
    }

    try {
        await redisClient.ping();
        checks.redis = 'ok';
    } catch (error) {
        logger.error('Readiness check failed - Redis:', { error });
        checks.redis = 'error';
        healthy = false;
    }

    if (storageInitialized) {
        try {
            await minioClient.bucketExists(bucketName);
            checks.s3 = 'ok';
        } catch (error) {
            logger.error('Readiness check failed - S3:', { error });
            checks.s3 = 'error';
            healthy = false;
        }
    } else {
        checks.s3 = 'pending';
    }

    if (healthy) {
        res.status(200).json({ status: 'ready', checks });
    } else {
        res.status(503).json({ status: 'not ready', checks });
    }
});

if (!internalServiceAuthEnabled()) {
    logger.warn(
        'CODEAPI_INTERNAL_SERVICE_TOKEN is not set; file object routes are unauthenticated',
    );
}

app.use('/sessions', requireInternalServiceAuth);

app.post(
    '/sessions/:session_id/objects',
    async (req: express.Request, res: express.Response) => {
        const session_id = Array.isArray(req.params.session_id)
            ? req.params.session_id[0]
            : req.params.session_id;
        /** Request-level X-Read-Only flag — applies to every file in this batch.
         *  See `uploadFile` for semantics (infrastructure inputs that callers
         *  should not surface as generated artifacts). */
        const readOnlyHeader = req.headers['x-read-only'];
        const readOnly =
            typeof readOnlyHeader === 'string' &&
            readOnlyHeader.toLowerCase() === 'true';
        /** busboy with proper charset handling and preservePath so subdirectory
         *  components survive (e.g. `pptx/editing.md`); default strips to basename. */
        const busboy = b({
            headers: req.headers,
            defCharset: 'utf8',
            defParamCharset: 'utf8',
            preservePath: true,
        });
        const uploadPromises: Promise<t.UploadResult | null>[] = [];

        busboy.on(
            'file',
            (fieldname: string, file: Readable, info: b.FileInfo) => {
                const {
                    filename: combinedFilename,
                    encoding: _e,
                    mimeType,
                } = info;

                // Handle the filename properly - it might be URL encoded
                let decodedFilename: string;
                try {
                    decodedFilename = decodeURIComponent(combinedFilename);
                } catch (err) {
                    // If decoding fails, use the original filename
                    logger.warn(
                        `Failed to decode filename, using original: ${combinedFilename}`,
                        { error: err },
                    );
                    decodedFilename = combinedFilename;
                }

                const [fileId, ...filenameParts] = decodedFilename.split('___');
                const filename = filenameParts.join('___');

                logger.info(
                    `[${INSTANCE_ID}] Processing file: ${filename} with ID: ${fileId}`,
                );

                const uploadPromise = uploadFile(
                    session_id,
                    file,
                    filename,
                    mimeType,
                    fileId,
                    readOnly,
                ).catch(err => {
                    logger.error(
                        `[${INSTANCE_ID}] Error uploading file ${filename}:`,
                        { error: err },
                    );
                    return null;
                });
                uploadPromises.push(uploadPromise);
            },
        );

        busboy.on('finish', async () => {
            try {
                const results = await Promise.all(uploadPromises);
                const successfulUploads = results.filter(
                    (result): result is t.UploadResult => result !== null,
                );

                logger.info(
                    `[${INSTANCE_ID}] Successfully uploaded ${successfulUploads.length} files for session ${session_id}`,
                );

                return res.status(200).json({
                    message: 'success',
                    storage_session_id: session_id,
                    files: successfulUploads,
                });
            } catch (err) {
                logger.error('Error processing uploads:', { error: err });
                return res.status(500).send('Error uploading files.');
            }
        });

        busboy.on('error', error => {
            logger.error(
                `[${INSTANCE_ID}] Busboy error for session_id ${session_id}:`,
                error,
            );
            res.status(500).json({ error: 'Error processing upload' });
        });

        await pipeline(req, busboy);
    },
);

app.put(
    '/sessions/:session_id/objects/:fileId',
    async (req: express.Request, res: express.Response) => {
        const session_id = Array.isArray(req.params.session_id)
            ? req.params.session_id[0]
            : req.params.session_id;
        const fileId = Array.isArray(req.params.fileId)
            ? req.params.fileId[0]
            : req.params.fileId;
        // Decode the filename from the header if it's URL encoded
        const originalFilename = req.headers['x-original-filename'] as string;
        let decodedFilename = '';

        if (originalFilename) {
            try {
                decodedFilename = decodeURIComponent(originalFilename);
            } catch (err) {
                // If decoding fails, use the original filename
                logger.warn(
                    `Failed to decode filename header, using original: ${originalFilename}`,
                    { error: err },
                );
                decodedFilename = originalFilename;
            }
        }

        const mimeType = req.headers['content-type'] as string;
        const readOnlyHeader = req.headers['x-read-only'];
        const readOnly =
            typeof readOnlyHeader === 'string' &&
            readOnlyHeader.toLowerCase() === 'true';

        if (!decodedFilename || !mimeType) {
            return res.status(400).json({ error: 'Missing required headers' });
        }

        try {
            const result = await uploadFile(
                session_id,
                req,
                decodedFilename,
                mimeType,
                fileId,
                readOnly,
            );
            logger.info(
                `[${INSTANCE_ID}] File uploaded successfully: ${result.filename}`,
            );
            return res.status(200).json(result);
        } catch (err) {
            logger.error(
                `[${INSTANCE_ID}] Error uploading file ${decodedFilename}:`,
                { error: err },
            );
            return res.status(500).json({ error: 'Error uploading file.' });
        }
    },
);

/**
 * Single-object metadata lookup. Returns the JSON shape callers
 * (LibreChat's `getSessionInfo`) need to decide whether the object's
 * underlying sandbox session is still alive — `lastModified` is the
 * 23-hour-freshness signal the priming layer reads. Distinct from the
 * binary-streaming GET below: that one returns the file bytes, not
 * metadata. Keeping the two as separate routes lets the public
 * service-api expose only the metadata variant under sessionAuth
 * without conflating with the internal-only binary download.
 */
app.get(
    '/sessions/:session_id/objects/:objectId/metadata',
    async (req, res) => {
        const { session_id, objectId } = req.params;

        try {
            const stream = minioClient.listObjects(
                bucketName,
                `${session_id}/${objectId}`,
                true,
            );
            let objectName = '';

            for await (const obj of stream) {
                if (obj.name.startsWith(`${session_id}/${objectId}`) === true) {
                    objectName = obj.name;
                    break;
                }
            }

            if (!objectName) {
                return res.status(404).json({
                    error: 'File not found',
                    details: 'No matching file found',
                    session_id,
                    objectId,
                });
            }

            const stat: Partial<BucketItemStat> = await minioClient.statObject(
                bucketName,
                objectName,
            );
            const originalFilename = decodeOriginalFilename(
                stat.metaData,
                path.basename(objectName),
            );

            return res.status(200).json({
                name: objectName,
                originalFilename,
                size: stat.size,
                lastModified: stat.lastModified,
                etag: stat.etag,
                contentType:
                    stat.metaData?.['content-type'] ??
                    'application/octet-stream',
                readOnly: stat.metaData?.['read-only'] === 'true',
            });
        } catch (err) {
            logger.error('Error fetching object metadata:', {
                error: err,
                session_id,
                objectId,
                bucketName,
            });
            return res.status(500).json({
                error: 'Error fetching object metadata',
                details: (err as Error | undefined)?.message,
            });
        }
    },
);

app.get('/sessions/:session_id/objects/:objectId', async (req, res) => {
    const { session_id, objectId } = req.params;

    try {
        // List objects to find the correct file with extension
        const stream = minioClient.listObjects(
            bucketName,
            `${session_id}/${objectId}`,
            true,
        );
        let objectName = '';

        for await (const obj of stream) {
            if (obj.name.startsWith(`${session_id}/${objectId}`) === true) {
                objectName = obj.name;
                break;
            }
        }

        if (!objectName) {
            logger.warn('File not found', { session_id, objectId, bucketName });
            return res.status(404).json({
                error: 'File not found',
                details: 'No matching file found',
                session_id,
                objectId,
                bucketName,
            });
        }

        logger.info(`[${INSTANCE_ID}] Attempting to download: ${objectName}`);

        const stat: Partial<BucketItemStat> = await minioClient.statObject(
            bucketName,
            objectName,
        );

        let originalFilename = path.basename(objectName);
        if (
            stat.metaData?.['original-filename-encoded'] === 'base64' &&
            stat.metaData['original-filename'] != null
        ) {
            try {
                originalFilename = Buffer.from(
                    stat.metaData['original-filename'],
                    'base64',
                ).toString('utf8');
            } catch (err) {
                logger.warn(
                    'Failed to decode filename from metadata, using fallback',
                    { error: err },
                );
                originalFilename =
                    stat.metaData['original-filename'] ??
                    path.basename(objectName);
            }
        } else if (stat.metaData?.['original-filename'] != null) {
            originalFilename = stat.metaData['original-filename'];
        }

        logger.info(`[${INSTANCE_ID}] File found: ${objectName}`);

        // Explicitly remove problematic headers that might be duplicated
        res.removeHeader('Transfer-Encoding');
        res.removeHeader('Date');

        const encodedFilename = encodeURIComponent(originalFilename);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodedFilename}`,
        );
        if (stat.metaData?.['content-type'] != null) {
            res.setHeader('Content-Type', stat.metaData['content-type']);
        }
        /* Surface the read-only flag on download so the sandbox can plumb it
         * onto its in-memory file metadata without a separate metadata fetch.
         * MinIO normalizes `X-Amz-Meta-Read-Only` to `read-only` in stat.metaData. */
        if (stat.metaData?.['read-only'] === 'true') {
            res.setHeader('X-Read-Only', 'true');
        }

        const dataStream = await minioClient.getObject(bucketName, objectName);
        fileDownloads.inc();

        dataStream.on('data', chunk => {
            res.write(chunk);
        });

        dataStream.on('end', () => {
            res.end();
        });

        dataStream.on('error', err => {
            logger.error('Error streaming file:', {
                error: err,
                session_id,
                objectId,
                bucketName,
            });
            // Only send error if headers haven't been sent yet
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Error streaming file',
                    details: err.message,
                });
            } else {
                res.end();
            }
        });
    } catch (err) {
        logger.error('Error downloading file:', {
            error: err,
            session_id,
            objectId,
            bucketName,
        });
        return res.status(500).json({
            error: 'Error downloading file',
            details: (err as Error | undefined)?.message,
            session_id,
            objectId,
            bucketName,
        });
    }
});

/**
 * Decodes the original filename from metadata.
 * Handles both base64-encoded and plain text filenames for consistency.
 */
function decodeOriginalFilename(
    metadata: Record<string, string> | undefined,
    fallbackName: string,
): string {
    if (!metadata) return fallbackName;

    const encodedFilename = metadata['original-filename'];
    const encodingType = metadata['original-filename-encoded'];

    if (encodedFilename && encodingType === 'base64') {
        try {
            return Buffer.from(encodedFilename, 'base64').toString('utf8');
        } catch {
            return encodedFilename;
        }
    }

    return encodedFilename || fallbackName;
}

/**
 * Extracts session_id and file_id from object name (format: {session_id}/{file_id}.ext)
 */
function parseObjectName(
    objectName: string | undefined,
): { session_id: string; file_id: string } | null {
    if (objectName == null || objectName === '') return null;
    const parts = objectName.split('/');
    if (parts.length < 2) return null;
    const session_id = parts[0];
    const fileNameWithExt = parts[1];
    // Remove extension to get file_id
    const file_id = fileNameWithExt.replace(/\.[^.]+$/, '');
    return { session_id, file_id };
}

const detailLevels: Record<
    t.DetailLevel | string,
    (
        obj: BucketItem,
    ) => Promise<t.ObjectTypes | Partial<t.ObjectTypes>> | undefined
> = {
    simple: async (obj: BucketItem): Promise<Partial<t.SimpleObject>> =>
        obj.name ?? '',
    summary: async (obj: BucketItem): Promise<Partial<t.SummaryObject>> => ({
        name: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
    }),
    full: async (obj: BucketItem): Promise<Partial<t.FullObject>> => {
        const stat = await minioClient.statObject(bucketName, obj.name ?? '');
        // Decode original filename for consistent plain text response
        const originalFilename = decodeOriginalFilename(
            stat.metaData,
            path.basename(obj.name ?? ''),
        );
        return {
            name: obj.name,
            size: obj.size,
            lastModified: obj.lastModified,
            etag: obj.etag,
            metadata: {
                ...stat.metaData,
                // Provide decoded filename for client convenience (standardized)
                'original-filename': originalFilename,
                'original-filename-encoded': 'none', // Indicate it's already decoded
            },
            versionId: stat.versionId,
            contentType:
                stat.metaData['content-type'] ?? 'application/octet-stream',
        };
    },
    // New normalized detail level - returns self-contained file references
    // Ideal for clients that need to pass files to subsequent requests
    normalized: async (obj: BucketItem): Promise<Record<string, unknown>> => {
        const stat = await minioClient.statObject(bucketName, obj.name ?? '');
        const originalFilename = decodeOriginalFilename(
            stat.metaData,
            path.basename(obj.name ?? ''),
        );
        const parsed = parseObjectName(obj.name);

        const result: Record<string, unknown> = {
            id:
                parsed?.file_id ??
                path.basename(obj.name ?? '').replace(/\.[^.]+$/, ''),
            name: originalFilename,
            storage_session_id: parsed?.session_id ?? '',
            size: obj.size,
            contentType:
                stat.metaData['content-type'] ?? 'application/octet-stream',
            lastModified: obj.lastModified,
        };
        if (stat.metaData['read-only'] === 'true') {
            result.read_only = true;
        }
        return result;
    },
};

app.get('/sessions/:session_id/objects', async (req, res) => {
    const { session_id } = req.params;
    const { detail = 'simple' } = req.query;

    try {
        const stream = minioClient.listObjects(bucketName, session_id, true);
        const objects: (t.ObjectTypes | Partial<t.ObjectTypes> | undefined)[] =
            [];

        const getDetail = detailLevels[detail as string] ?? detailLevels.simple;

        for await (const obj of stream) {
            objects.push(await getDetail(obj));
        }

        res.json(objects);
    } catch (err) {
        logger.error('Error listing objects:', { error: err, session_id });
        return res.status(500).send('Error listing objects');
    }
});

app.delete('/sessions/:session_id/objects/:fileId', async (req, res) => {
    const { session_id, fileId } = req.params;

    try {
        const stream = minioClient.listObjects(
            bucketName,
            `${session_id}/${fileId}`,
            true,
        );
        let objectName = '';

        for await (const obj of stream) {
            if (obj.name.startsWith(`${session_id}/${fileId}`) === true) {
                objectName = obj.name;
                break;
            }
        }

        if (!objectName) {
            logger.warn('File not found for deletion', {
                session_id,
                fileId,
                bucketName,
            });
            return res.status(404).json({
                error: 'File not found',
                details: 'No matching file found for deletion',
                session_id,
                fileId,
                bucketName,
            });
        }

        await minioClient.removeObject(bucketName, objectName);
        logger.info(
            `[${INSTANCE_ID}] File deleted successfully: ${objectName}`,
        );
        return res.status(200).json({
            message: 'File deleted successfully',
            session_id,
            fileId,
        });
    } catch (err) {
        logger.error('Error deleting file:', err);
        return res.status(500).json({
            error: 'Error deleting file',
        });
    }
});

const port = Number(process.env.FILE_SERVER_PORT ?? 3000);
/** Optional bind address. Deployments where only the co-located service-api
 *  should reach the file server (push-model sandbox backends fetch input
 *  bytes server-side) set this to 127.0.0.1 so the object routes are never
 *  network-exposed. Unset preserves the historical all-interfaces bind. */
const host = process.env.FILE_SERVER_HOST;
let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function startServer(): Promise<void> {
    try {
        await initializeStorage();
        const onListen = (): void => {
            logger.info(
                `[${INSTANCE_ID}] Server running on ${host ?? '*'}:${port}`,
            );
        };
        server = host
            ? app.listen(port, host, onListen)
            : app.listen(port, onListen);
    } catch (err) {
        logger.error('Critical: Could not initialize storage', { error: err });
        process.exit(1);
    }
}

function closeHttpServer(): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server?.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[${INSTANCE_ID}] Shutting down file server...`);
    try {
        await closeHttpServer();
        await redisClient.quit();
        try {
            await shutdownTelemetry();
        } catch (telemetryError) {
            logger.warn(`[${INSTANCE_ID}] OpenTelemetry shutdown failed`, {
                error: telemetryError,
            });
        }
        process.exit(0);
    } catch (error) {
        logger.error(`[${INSTANCE_ID}] File server shutdown failed`, { error });
        try {
            await shutdownTelemetry();
        } catch (telemetryError) {
            logger.warn(`[${INSTANCE_ID}] OpenTelemetry shutdown failed`, {
                error: telemetryError,
            });
        }
        process.exit(1);
    }
}

startServer();

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', { error });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});
