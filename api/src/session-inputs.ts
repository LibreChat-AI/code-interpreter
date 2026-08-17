import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Transform } from 'stream';
import { createGunzip } from 'zlib';
import { logger } from './logger';
import { SANDBOX_WORKSPACE_ROOT } from './workspace-isolation';

/**
 * Runner-local cache of by-reference input objects.
 *
 * Backends whose sandbox cannot reach the file server (the Lambda MicroVM's
 * only egress is the public internet) have the control plane PUSH input bytes
 * into this cache before an execute. Priming then resolves a ref from here
 * instead of over HTTP — see `Job.fetchInputObject`.
 *
 * The cache is deliberately NOT part of the session workspace:
 *  - entries are keyed by a runner-computed digest of (storage session, id),
 *    so no caller-supplied path component ever reaches the filesystem;
 *  - sandbox code cannot see or modify it (0700, outside /mnt/data);
 *  - it is never checkpointed, so a relaunched VM simply starts empty and the
 *    control plane re-pushes what the next execute needs.
 *
 * Because the only workspace writer stays the existing prime path, delivered
 * files inherit its identity, ownership, read-only, symlink-safety, priming
 * and modification-detection semantics for free.
 */

/**
 * Sibling of the workspace root, never inside it. Everything under
 * SANDBOX_WORKSPACE_ROOT is a workspace as far as the stale-workspace reaper
 * is concerned, so a cache placed there is deleted out from under the very
 * execute it was pushed for — proven live, then reproduced with
 * `reapStaleWorkspaces`. Being outside also keeps it off every nsjail mount,
 * so sandbox code can neither read nor tamper with pending inputs.
 */
const DEFAULT_SESSION_INPUT_CACHE_DIR = `${SANDBOX_WORKSPACE_ROOT}-inputs`;
const UNSAFE_CACHE_ROOTS = new Set([
    '/',
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/home',
    '/lib',
    '/lib64',
    '/mnt',
    '/mnt/data',
    '/opt',
    '/proc',
    '/root',
    '/run',
    '/sbin',
    '/srv',
    '/sys',
    '/tmp',
    '/usr',
    '/var',
    '/var/tmp',
]);

/**
 * The cache is root-owned and recursively pruned. Refuse broad paths and any
 * path that contains, or is contained by, the workspace root so a typo cannot
 * turn cache eviction into workspace deletion.
 */
export function resolveSessionInputCacheDir(
    configured = process.env.SANDBOX_INPUT_CACHE_DIR ??
        DEFAULT_SESSION_INPUT_CACHE_DIR,
): string {
    if (!path.isAbsolute(configured)) {
        throw new Error('SANDBOX_INPUT_CACHE_DIR must be an absolute path');
    }
    const resolved = path.resolve(configured);
    const workspace = path.resolve(SANDBOX_WORKSPACE_ROOT);
    const cacheFromWorkspace = path.relative(workspace, resolved);
    const workspaceFromCache = path.relative(resolved, workspace);
    const isInsideWorkspace =
        cacheFromWorkspace === '' ||
        (!cacheFromWorkspace.startsWith(`..${path.sep}`) &&
            cacheFromWorkspace !== '..');
    const containsWorkspace =
        workspaceFromCache === '' ||
        (!workspaceFromCache.startsWith(`..${path.sep}`) &&
            workspaceFromCache !== '..');
    if (
        UNSAFE_CACHE_ROOTS.has(resolved) ||
        isInsideWorkspace ||
        containsWorkspace
    ) {
        throw new Error(
            `SANDBOX_INPUT_CACHE_DIR must be a dedicated directory outside ${SANDBOX_WORKSPACE_ROOT}`,
        );
    }
    return resolved;
}

export const SESSION_INPUT_CACHE_DIR = resolveSessionInputCacheDir();
/** Cache entry names are exactly this shape — anything else is rejected. */
const ENTRY_PATTERN = /^[0-9a-f]{64}(\.json)?$/;
const META_SUFFIX = '.json';
const MAX_META_BYTES = 1024;
const TAR_BLOCK_BYTES = 512;
export const SESSION_INPUT_CACHE_MAX_OBJECTS = 256;
const TAR_MEMBER_LIMIT = SESSION_INPUT_CACHE_MAX_OBJECTS * 4 + 16;
/* Payload bytes have their own exact maxBytes accounting. Allow at most one
 * header plus one padding block per legal member, plus terminators. Counting
 * the whole decompressed stream against this bound closes gzip bombs made from
 * unlimited zero blocks after an otherwise-valid tar terminator. */
const TAR_STRUCTURAL_OVERHEAD_BYTES =
    (TAR_MEMBER_LIMIT * 2 + 4) * TAR_BLOCK_BYTES;

type WritableFileHandle = Pick<fsp.FileHandle, 'write'>;

/** FileHandle.write may legally complete with a short write. Consume the
 * entire slice or fail instead of treating unwritten bytes as cached input. */
export async function writeAllToHandle(
    handle: WritableFileHandle,
    data: Buffer,
    recoverNoSpace?: () => Promise<void>,
): Promise<void> {
    let offset = 0;
    let recovered = false;
    while (offset < data.length) {
        let bytesWritten: number;
        try {
            ({ bytesWritten } = await handle.write(
                data,
                offset,
                data.length - offset,
                null,
            ));
        } catch (error) {
            if (!recovered && recoverNoSpace && isNoSpaceError(error)) {
                recovered = true;
                await recoverNoSpace();
                continue;
            }
            throw error;
        }
        if (bytesWritten <= 0) {
            throw new Error('Session input cache write made no progress');
        }
        offset += bytesWritten;
    }
}

export interface CachedInputMeta {
    /** Whether the object is infrastructure the sandbox must not modify. This is
     *  a property of the OBJECT, so it belongs here. A filename deliberately
     *  does not: the cache is keyed by object, and the same object can be
     *  requested at several destinations in one execute, so the requesting ref
     *  owns the name. Emitting one cached name as Content-Disposition made every
     *  ref resolve to the first ref's path — which then overwrote a file the
     *  sandbox had edited. */
    readOnly: boolean;
}

export interface CachedInput {
    path: string;
    meta: CachedInputMeta;
    /** Held open with O_NOFOLLOW so eviction can unlink the cache pathname
     * without invalidating an execute that already accepted this entry. */
    handle: fsp.FileHandle;
}

/** Opaque, collision-resistant key for a (storage session, object) pair. The
 *  digest keeps caller-controlled ids out of the filesystem entirely. */
export function inputCacheKey(storageSessionId: string, id: string): string {
    return crypto
        .createHash('sha256')
        .update(`${storageSessionId}\u0000${id}`, 'utf8')
        .digest('hex');
}

function parseCachedInputMeta(raw: string): CachedInputMeta | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as { readOnly?: unknown }).readOnly !== 'boolean'
        ) {
            return null;
        }
        return { readOnly: (parsed as { readOnly: boolean }).readOnly };
    } catch {
        return null;
    }
}

export async function hasCachedInput(
    storageSessionId: string,
    id: string,
    cacheKey?: string,
): Promise<boolean> {
    const opened = await openCachedInput(storageSessionId, id, cacheKey);
    if (!opened) return false;
    await opened.handle.close();
    return true;
}

export async function openCachedInput(
    storageSessionId: string,
    id: string,
    cacheKey?: string,
): Promise<CachedInput | null> {
    const key = cacheKey ?? inputCacheKey(storageSessionId, id);
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const entry = path.join(SESSION_INPUT_CACHE_DIR, key);
    let handle: fsp.FileHandle | undefined;
    try {
        handle = await fsp.open(
            entry,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const dataStat = await handle.stat();
        if (!dataStat.isFile()) {
            await handle.close();
            return null;
        }

        let metaHandle: fsp.FileHandle | undefined;
        let metaMtime: Date | undefined;
        let raw: string | null = null;
        try {
            metaHandle = await fsp.open(
                `${entry}${META_SUFFIX}`,
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
            );
            const metaStat = await metaHandle.stat();
            metaMtime = metaStat.mtime;
            if (metaStat.isFile() && metaStat.size <= MAX_META_BYTES) {
                raw = await metaHandle.readFile('utf8');
            }
        } catch {
            raw = null;
        } finally {
            await metaHandle?.close().catch(() => {});
        }
        const meta = raw === null ? null : parseCachedInputMeta(raw);
        if (!meta) {
            logger.warn(
                { key },
                'Ignoring session input with missing or invalid metadata',
            );
            await handle.close();
            return null;
        }
        /* tmpfs commonly uses relatime, so merely opening a hit does not reliably
         * refresh atime. Touch both immutable cache files explicitly: capacity
         * recovery can then evict cold entries while preserving the working set
         * the immediately preceding probe proved present. */
        const now = new Date();
        await Promise.all([
            fsp.utimes(entry, now, dataStat.mtime).catch(() => {}),
            fsp
                .utimes(`${entry}${META_SUFFIX}`, now, metaMtime ?? now)
                .catch(() => {}),
        ]);
        return { path: entry, meta, handle };
    } catch {
        await handle?.close().catch(() => {});
        return null;
    }
}

/**
 * Presents a cached entry as the `Response` the file server would have
 * returned, so every downstream priming step (name resolution, read-only
 * protection, streaming hash, atomic rename) runs byte-identically whether the
 * bytes arrived by pull or by push.
 */
export function cachedInputResponse(entry: CachedInput): Response {
    const headers = new Headers();
    /* No Content-Disposition: priming falls back to the ref's requested name,
     * so each destination gets its own copy (see CachedInputMeta). */
    if (entry.meta.readOnly === true) headers.set('x-read-only', 'true');
    return new Response(
        entry.handle.createReadStream() as unknown as ReadableStream,
        {
            status: 200,
            headers,
        },
    );
}

function tarString(block: Buffer, offset: number, length: number): string {
    const field = block.subarray(offset, offset + length);
    const nul = field.indexOf(0);
    return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

function tarOctal(block: Buffer, offset: number, length: number): number {
    const raw = tarString(block, offset, length).trim().replace(/\0/g, '');
    if (!/^[0-7]*$/.test(raw)) throw new Error('Invalid tar numeric field');
    return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function validateTarChecksum(block: Buffer): void {
    const expected = tarOctal(block, 148, 8);
    let actual = 0;
    for (let i = 0; i < block.length; i += 1) {
        actual += i >= 148 && i < 156 ? 0x20 : block[i];
    }
    if (actual !== expected)
        throw new Error('Invalid session input tar checksum');
}

/**
 * Extracts the deliberately tiny flat tar contract without invoking `tar`.
 * This lets the runner enforce member count and expanded bytes before writes,
 * reject links/PAX/path traversal, and cap compressed input while streaming.
 */
async function extractInputArchive(
    body: NodeJS.ReadableStream,
    staging: string,
    maxBytes: number,
    reserveStagingBytes: (bytes: number) => Promise<void>,
    recoverNoSpace: () => Promise<void>,
): Promise<number> {
    let compressedBytes = 0;
    const compressedLimit =
        maxBytes + Math.max(1024 * 1024, Math.ceil(maxBytes / 100));
    const decompressedLimit =
        maxBytes > Number.MAX_SAFE_INTEGER - TAR_STRUCTURAL_OVERHEAD_BYTES
            ? Number.MAX_SAFE_INTEGER
            : maxBytes + TAR_STRUCTURAL_OVERHEAD_BYTES;
    const compressedGuard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            callback(
                compressedBytes > compressedLimit
                    ? new Error(
                          `Compressed session input batch exceeds ${compressedLimit} bytes`,
                      )
                    : null,
                chunk,
            );
        },
    });
    const gunzip = createGunzip();
    const forwardCompressedError = (error: Error): void => {
        gunzip.destroy(error);
    };
    const forwardBodyError = (error: unknown): void => {
        compressedGuard.destroy(
            error instanceof Error ? error : new Error(String(error)),
        );
    };
    compressedGuard.on('error', forwardCompressedError);
    body.once('error', forwardBodyError);
    body.pipe(compressedGuard).pipe(gunzip);

    let buffered = Buffer.alloc(0);
    let current:
        | {
              handle?: fsp.FileHandle;
              remaining: number;
              padding: number;
              expectedSize?: number;
          }
        | undefined;
    let expandedBytes = 0;
    let files = 0;
    let members = 0;
    let decompressedBytes = 0;
    let stagedBytes = 0;
    let archiveEnded = false;
    const seen = new Set<string>();

    try {
        for await (const rawChunk of gunzip) {
            decompressedBytes += (rawChunk as Buffer).length;
            if (decompressedBytes > decompressedLimit) {
                throw new Error(
                    `Decompressed session input batch exceeds ${decompressedLimit} bytes`,
                );
            }
            let chunk = rawChunk as Buffer;
            while (chunk.length > 0) {
                if (archiveEnded) {
                    if (chunk.some(byte => byte !== 0)) {
                        throw new Error(
                            'Unexpected data after session input tar terminator',
                        );
                    }
                    break;
                }

                if (current) {
                    if (current.remaining > 0) {
                        const length = Math.min(
                            current.remaining,
                            chunk.length,
                        );
                        if (current.handle) {
                            await writeAllToHandle(
                                current.handle,
                                chunk.subarray(0, length),
                                recoverNoSpace,
                            );
                        }
                        current.remaining -= length;
                        chunk = chunk.subarray(length);
                        if (current.remaining > 0) continue;
                    }
                    if (current.padding > 0) {
                        const length = Math.min(current.padding, chunk.length);
                        current.padding -= length;
                        chunk = chunk.subarray(length);
                        if (current.padding > 0) continue;
                    }
                    if (current.handle) {
                        const stat = await current.handle.stat();
                        if (stat.size !== current.expectedSize) {
                            throw new Error(
                                `Session input cache write size mismatch: expected ${current.expectedSize}, got ${stat.size}`,
                            );
                        }
                        await current.handle.close();
                    }
                    current = undefined;
                    continue;
                }

                const needed = TAR_BLOCK_BYTES - buffered.length;
                const length = Math.min(needed, chunk.length);
                buffered = Buffer.concat([buffered, chunk.subarray(0, length)]);
                chunk = chunk.subarray(length);
                if (buffered.length < TAR_BLOCK_BYTES) continue;

                const header = buffered;
                buffered = Buffer.alloc(0);
                if (header.every(byte => byte === 0)) {
                    archiveEnded = true;
                    continue;
                }
                members += 1;
                if (members > TAR_MEMBER_LIMIT) {
                    throw new Error(
                        'Session input tar contains too many members',
                    );
                }
                validateTarChecksum(header);
                const prefix = tarString(header, 345, 155);
                const rawName = [prefix, tarString(header, 0, 100)]
                    .filter(Boolean)
                    .join('/');
                const name = rawName.replace(/^\.\//, '');
                const size = tarOctal(header, 124, 12);
                const type = String.fromCharCode(header[156] || 0x30);

                /* BSD tar emits per-file PAX metadata even for short names. Ignore the
                 * metadata payload completely; unlike a general tar extractor, this
                 * parser never applies PAX path/link overrides. It still counts toward
                 * the expanded-byte ceiling. */
                if (type === 'x' || type === 'g') {
                    expandedBytes += size;
                    if (expandedBytes > maxBytes) {
                        throw new Error(
                            `Session input batch exceeds the ${maxBytes}-byte cache limit`,
                        );
                    }
                    current = {
                        remaining: size,
                        padding:
                            (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) %
                            TAR_BLOCK_BYTES,
                    };
                    continue;
                }
                if (type === '5' && (name === '' || name === '.')) {
                    if (size !== 0)
                        throw new Error('Invalid tar directory member size');
                    continue;
                }
                if (type !== '0') {
                    throw new Error(
                        `Unsupported session input tar member type: ${type}`,
                    );
                }
                if (!ENTRY_PATTERN.test(name) || seen.has(name)) {
                    throw new Error(`Unexpected session input member: ${name}`);
                }
                seen.add(name);
                files += 1;
                if (files > SESSION_INPUT_CACHE_MAX_OBJECTS * 2) {
                    throw new Error(
                        `Session input batch exceeds the ${SESSION_INPUT_CACHE_MAX_OBJECTS}-object limit`,
                    );
                }
                if (name.endsWith(META_SUFFIX) && size > MAX_META_BYTES) {
                    throw new Error(
                        `Session input metadata exceeds ${MAX_META_BYTES} bytes`,
                    );
                }
                expandedBytes += size;
                if (expandedBytes > maxBytes) {
                    throw new Error(
                        `Session input batch exceeds the ${maxBytes}-byte cache limit`,
                    );
                }
                stagedBytes += size;
                await reserveStagingBytes(stagedBytes);
                let handle: fsp.FileHandle;
                try {
                    handle = await fsp.open(
                        path.join(staging, name),
                        'wx',
                        0o600,
                    );
                } catch (error) {
                    if (!isNoSpaceError(error)) throw error;
                    await recoverNoSpace();
                    handle = await fsp.open(
                        path.join(staging, name),
                        'wx',
                        0o600,
                    );
                }
                current = {
                    handle,
                    remaining: size,
                    padding:
                        (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) %
                        TAR_BLOCK_BYTES,
                    expectedSize: size,
                };
            }
        }
        if (!archiveEnded || current || buffered.length !== 0) {
            throw new Error('Truncated session input tar archive');
        }
        return stagedBytes;
    } finally {
        body.removeListener('error', forwardBodyError);
        compressedGuard.removeListener('error', forwardCompressedError);
        await current?.handle?.close().catch(() => {});
        if (!compressedGuard.destroyed) compressedGuard.destroy();
        if (!gunzip.destroyed) gunzip.destroy();
    }
}

function isNoSpaceError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOSPC'
    );
}

async function cleanupStaleInputStaging(): Promise<void> {
    const entries = await fsp
        .readdir(SESSION_INPUT_CACHE_DIR, { withFileTypes: true })
        .catch(() => []);
    const staleBefore = Date.now() - 10 * 60_000;
    await Promise.all(
        entries
            .filter(
                entry =>
                    entry.isDirectory() && entry.name.startsWith('.staging-'),
            )
            .map(async entry => {
                const target = path.join(SESSION_INPUT_CACHE_DIR, entry.name);
                const stat = await fsp.lstat(target).catch(() => null);
                if (stat && stat.mtimeMs < staleBefore) {
                    await fsp
                        .rm(target, { recursive: true, force: true })
                        .catch(() => {});
                }
            }),
    );
}

/**
 * Extracts a pushed batch into the cache. Members are digest-named by the
 * control plane (`<key>` for bytes, `<key>.json` for metadata), so validation
 * is a name-shape check rather than path arithmetic: nothing else can be
 * written, and no member can escape the cache directory.
 */
let storeTail: Promise<void> = Promise.resolve();

async function storeCachedInputsOnce(
    body: NodeJS.ReadableStream,
    maxBytes = Number.MAX_SAFE_INTEGER,
    expectedBytes?: number,
): Promise<number> {
    await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true, mode: 0o700 });
    const cacheStat = await fsp.lstat(SESSION_INPUT_CACHE_DIR);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
        throw new Error('Session input cache root must be a real directory');
    }
    await fsp.chmod(SESSION_INPUT_CACHE_DIR, 0o700);
    await cleanupStaleInputStaging();
    const staging = await fsp.mkdtemp(
        path.join(SESSION_INPUT_CACHE_DIR, '.staging-'),
    );
    try {
        /* Treat the configured cache ceiling as a budget shared by committed
         * entries and the in-flight staging tree. As each tar header declares its
         * file size, evict cold entries BEFORE writing those bytes; this prevents
         * a full cache from requiring a second cache-sized allocation just to
         * receive a valid missing batch. An ENOSPC caused by unrelated workspace
         * growth gets one emergency all-cache prune and exact-operation retry. */
        const stagedBytes = await extractInputArchive(
            body,
            staging,
            maxBytes,
            bytes => pruneInputCache(Math.max(0, maxBytes - bytes)),
            () => pruneInputCache(0),
        );
        if (expectedBytes !== undefined && stagedBytes !== expectedBytes) {
            throw new Error(
                `Session input expanded-byte mismatch: expected ${expectedBytes}, got ${stagedBytes}`,
            );
        }

        const entries = await fsp.readdir(staging, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !ENTRY_PATTERN.test(entry.name)) {
                throw new Error(
                    `Unexpected session input member: ${entry.name}`,
                );
            }
        }

        const names = new Set(entries.map(entry => entry.name));
        const keys = entries
            .filter(entry => !entry.name.endsWith(META_SUFFIX))
            .map(entry => entry.name);
        if (keys.length * 2 !== entries.length) {
            throw new Error(
                'Each session input requires exactly one data file and metadata sidecar',
            );
        }
        for (const key of keys) {
            const metaName = `${key}${META_SUFFIX}`;
            if (!names.has(metaName)) {
                throw new Error(`Session input ${key} is missing metadata`);
            }
            const raw = await fsp.readFile(
                path.join(staging, metaName),
                'utf8',
            );
            if (!parseCachedInputMeta(raw)) {
                throw new Error(`Session input ${key} has invalid metadata`);
            }
        }

        let stored = 0;
        /* Commit sidecars before data. A new key remains a probe miss until both
         * exist; replacing an immutable key can only expose its new validated
         * metadata beside identical object bytes for the brief rename window. */
        const commitOrder = [
            ...entries.filter(entry => entry.name.endsWith(META_SUFFIX)),
            ...entries.filter(entry => !entry.name.endsWith(META_SUFFIX)),
        ];
        for (const entry of commitOrder) {
            await fsp.rename(
                path.join(staging, entry.name),
                path.join(SESSION_INPUT_CACHE_DIR, entry.name),
            );
            if (!entry.name.endsWith(META_SUFFIX)) stored += 1;
        }
        return stored;
    } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
}

export async function storeCachedInputs(
    body: NodeJS.ReadableStream,
    maxBytes = Number.MAX_SAFE_INTEGER,
    expectedBytes?: number,
): Promise<number> {
    /* Concurrent pushes otherwise each budget only its own staging tree and can
     * collectively recreate the same transient disk spike. Queue extraction;
     * request streams naturally backpressure while waiting. */
    const previous = storeTail;
    let release!: () => void;
    storeTail = new Promise<void>(resolve => {
        release = resolve;
    });
    await previous;
    try {
        return await storeCachedInputsOnce(body, maxBytes, expectedBytes);
    } finally {
        release();
    }
}

/** Drops least-recently-used entries until the cache fits `maxBytes`. Eviction
 *  is always safe: a miss simply re-pushes on the next probe. */
export async function pruneInputCache(maxBytes: number): Promise<void> {
    const names = await fsp
        .readdir(SESSION_INPUT_CACHE_DIR)
        .catch(() => [] as string[]);
    const nameSet = new Set(names.filter(name => ENTRY_PATTERN.test(name)));
    const pairs: Array<{ key: string; size: number; atime: number }> = [];
    let total = 0;
    for (const name of nameSet) {
        if (name.endsWith(META_SUFFIX)) continue;
        const metaName = `${name}${META_SUFFIX}`;
        const dataStat = await fsp
            .lstat(path.join(SESSION_INPUT_CACHE_DIR, name))
            .catch(() => null);
        const metaStat = nameSet.has(metaName)
            ? await fsp
                  .lstat(path.join(SESSION_INPUT_CACHE_DIR, metaName))
                  .catch(() => null)
            : null;
        if (!dataStat?.isFile() || !metaStat?.isFile()) {
            await fsp
                .rm(path.join(SESSION_INPUT_CACHE_DIR, name), { force: true })
                .catch(() => {});
            await fsp
                .rm(path.join(SESSION_INPUT_CACHE_DIR, metaName), {
                    force: true,
                })
                .catch(() => {});
            nameSet.delete(metaName);
            continue;
        }
        const size = dataStat.size + metaStat.size;
        pairs.push({
            key: name,
            size,
            atime: Math.max(dataStat.atimeMs, metaStat.atimeMs),
        });
        total += size;
        nameSet.delete(metaName);
    }
    /* Metadata with no data object is never usable and must not accumulate. */
    for (const orphan of nameSet) {
        if (orphan.endsWith(META_SUFFIX)) {
            await fsp
                .rm(path.join(SESSION_INPUT_CACHE_DIR, orphan), { force: true })
                .catch(() => {});
        }
    }
    if (total <= maxBytes) return;
    pairs.sort((a, b) => a.atime - b.atime);
    for (const pair of pairs) {
        if (total <= maxBytes) break;
        await fsp
            .rm(path.join(SESSION_INPUT_CACHE_DIR, pair.key), { force: true })
            .catch(() => {});
        await fsp
            .rm(
                path.join(SESSION_INPUT_CACHE_DIR, `${pair.key}${META_SUFFIX}`),
                { force: true },
            )
            .catch(() => {});
        total -= pair.size;
    }
}
