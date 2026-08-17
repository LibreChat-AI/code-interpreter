import axios from 'axios';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type * as t from '../types';
import { internalServiceHeaders } from '../internal-service-auth';
import { getAxiosErrorDetails } from '../utils';
import { env } from '../config';
import logger from '../logger';

/**
 * Input delivery for sandbox backends whose guest cannot reach the file
 * server (a MicroVM's only egress is the public internet, so the runner's
 * pull-based priming has nothing reachable to pull from).
 *
 * The control plane fetches the authorized objects locally and pushes the
 * bytes into a runner-local cache keyed by (storage session, object id). The
 * runner's EXISTING priming path then resolves refs from that cache instead of
 * over HTTP — so the sandbox workspace keeps exactly one writer, and pushed
 * inputs inherit its identity, ownership, read-only, symlink-safety, priming
 * and modification-detection semantics unchanged.
 *
 * Two consequences worth stating, because earlier designs got them wrong:
 *  - Nothing here decides what the workspace should contain. Re-pushing an
 *    object can never revert a sandbox edit, because the push does not touch
 *    the workspace at all.
 *  - Dedupe is asked of the VM (`probe`), not tracked in Redis. Control-plane
 *    state can be lost with a recycle; the VM's own cache cannot lie about
 *    what it holds.
 */

export const SESSION_INPUTS_MAX_COUNT = 256;

/**
 * Stable input-delivery failures. These codes survive the worker/BullMQ
 * boundary and let the public router distinguish a bad/oversized input set
 * from a broken MicroVM without exposing file-server or archive details.
 */
export type SessionFilesErrorCode =
    | 'SESSION_INPUT_TOO_LARGE'
    | 'SESSION_INPUT_UNAVAILABLE'
    | 'SESSION_INPUT_SOURCE_FAILED'
    | 'SESSION_INPUT_PREPARATION_FAILED'
    | 'SESSION_INPUT_ABORTED';

export class SessionFilesError extends Error {
    constructor(
        public readonly code: SessionFilesErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'SessionFilesError';
    }
}

export interface SessionFileRef {
    id: string;
    storage_session_id: string;
    name: string;
    cache_key: string;
}

/** Mirrors the runner's `inputCacheKey` (api/src/session-inputs.ts): both ends
 *  ship in the same image, so the digest is a hard-coded contract. */
export function inputCacheKey(storageSessionId: string, id: string): string {
    return crypto
        .createHash('sha256')
        .update(`${storageSessionId}\u0000${id}`, 'utf8')
        .digest('hex');
}

/** The by-reference subset of the payload's files (inline `content` entries
 *  need no delivery — the runner writes those itself). */
export function sessionFileRefs(
    files: t.PayloadBody['files'] | undefined,
): SessionFileRef[] {
    if (!files?.length) return [];
    const refs: SessionFileRef[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        if (
            !('id' in file) ||
            !file.id ||
            !file.storage_session_id ||
            !file.name
        )
            continue;
        /* Identity is (storage session, id) — the same object requested under two
         * names is ONE delivery; the runner writes it to each requested path from
         * the payload during priming. */
        const key = inputCacheKey(file.storage_session_id, file.id);
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({
            id: file.id,
            storage_session_id: file.storage_session_id,
            name: file.name,
            cache_key: file.input_cache_key ?? key,
        });
    }
    return refs;
}

export interface InputBatch {
    path: string;
    /** Exact uncompressed bytes in data files plus metadata sidecars. */
    expandedSize: number;
    size: number;
    count: number;
    cleanup(): Promise<void>;
}

/**
 * Fetches the given objects from the file server and packs them into the
 * digest-named batch the runner's cache endpoint accepts. Throws
 * {@link SessionFilesError} on a failed fetch or a blown budget — a silently
 * missing input is the failure mode this module exists to prevent.
 */
export async function buildInputBatch(
    refs: SessionFileRef[],
    opts: {
        timeoutMs: number;
        maxBytes: number;
        fileServerUrl?: string;
        signal?: AbortSignal;
    },
): Promise<InputBatch | undefined> {
    if (refs.length === 0) return undefined;
    if (refs.length > SESSION_INPUTS_MAX_COUNT) {
        throw new SessionFilesError(
            'SESSION_INPUT_TOO_LARGE',
            `Session delivery of ${refs.length} objects exceeds the ${SESSION_INPUTS_MAX_COUNT} limit`,
        );
    }
    const baseUrl = (opts.fileServerUrl ?? env.FILE_SERVER_URL).replace(
        /\/$/,
        '',
    );
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-inputs-'));
    const objects = path.join(tmp, 'objects');
    const archive = path.join(tmp, 'inputs.tar.gz');
    try {
        await fsp.mkdir(objects, { mode: 0o700 });
        let totalBytes = 0;
        for (const ref of refs) {
            if (opts.signal?.aborted) {
                throw new SessionFilesError(
                    'SESSION_INPUT_ABORTED',
                    'Session input delivery aborted',
                );
            }
            const key = ref.cache_key;
            const fetched = await fetchFileObjectToPath(
                baseUrl,
                ref,
                path.join(objects, key),
                { ...opts, remainingBytes: opts.maxBytes - totalBytes },
            );
            totalBytes += fetched.bytes;
            const metadata = Buffer.from(
                JSON.stringify({ readOnly: fetched.readOnly }),
            );
            totalBytes += metadata.length;
            if (totalBytes > opts.maxBytes) {
                throw new SessionFilesError(
                    'SESSION_INPUT_TOO_LARGE',
                    `Session inputs exceed the ${opts.maxBytes}-byte budget`,
                );
            }
            await fsp.writeFile(
                path.join(objects, `${key}.json`),
                /* Only object-level facts travel with the object; the destination
                 * name belongs to each requesting ref (see CachedInputMeta). */
                metadata,
            );
        }
        await tarDirectory(objects, archive, opts.signal);
        const stat = await fsp.lstat(archive);
        await fsp.rm(objects, { recursive: true, force: true });
        return {
            path: archive,
            expandedSize: totalBytes,
            size: stat.size,
            count: refs.length,
            cleanup: () => fsp.rm(tmp, { recursive: true, force: true }),
        };
    } catch (error) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        /* An abort can surface from axios, stream.pipeline, fs, or the tar child.
         * The shared signal is the authoritative cause; preserve the stable code
         * instead of whichever lower-level error happened to win the race. */
        if (opts.signal?.aborted) {
            throw new SessionFilesError(
                'SESSION_INPUT_ABORTED',
                'Session input delivery aborted',
            );
        }
        if (error instanceof SessionFilesError) throw error;
        logger.error(
            'Failed to prepare session input batch:',
            getAxiosErrorDetails(error),
        );
        throw new SessionFilesError(
            'SESSION_INPUT_PREPARATION_FAILED',
            'Failed to prepare session input batch',
        );
    }
}

async function fetchFileObjectToPath(
    baseUrl: string,
    ref: SessionFileRef,
    destination: string,
    opts: {
        timeoutMs: number;
        maxBytes: number;
        remainingBytes: number;
        signal?: AbortSignal;
    },
): Promise<{ bytes: number; readOnly: boolean }> {
    const url = `${baseUrl}/sessions/${encodeURIComponent(ref.storage_session_id)}/objects/${encodeURIComponent(ref.id)}`;
    try {
        const response = await axios.get<Readable>(url, {
            headers: internalServiceHeaders(),
            responseType: 'stream',
            timeout: opts.timeoutMs,
            signal: opts.signal,
        });
        const announced = Number(response.headers['content-length']);
        if (Number.isFinite(announced) && announced > opts.remainingBytes) {
            response.data.destroy();
            throw new SessionFilesError(
                'SESSION_INPUT_TOO_LARGE',
                `Session inputs exceed the ${opts.maxBytes}-byte budget`,
            );
        }
        let bytes = 0;
        const limit = new Transform({
            transform(chunk: Buffer, _encoding, callback): void {
                bytes += chunk.length;
                callback(
                    bytes > opts.remainingBytes
                        ? new SessionFilesError(
                              'SESSION_INPUT_TOO_LARGE',
                              `Session inputs exceed the ${opts.maxBytes}-byte budget`,
                          )
                        : null,
                    chunk,
                );
            },
        });
        await pipeline(
            response.data,
            limit,
            fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
        );
        const readOnly =
            String(response.headers['x-read-only'] ?? '').toLowerCase() ===
            'true';
        return { bytes, readOnly };
    } catch (error) {
        await fsp.rm(destination, { force: true }).catch(() => {});
        if (error instanceof SessionFilesError) throw error;
        if (opts.signal?.aborted) {
            throw new SessionFilesError(
                'SESSION_INPUT_ABORTED',
                'Session input delivery aborted',
            );
        }
        /* Sanitized details only: a raw axios error carries the request config —
         * including the internal service token header — straight into the logs. */
        logger.error(
            `Failed to fetch session input ${ref.id}:`,
            getAxiosErrorDetails(error),
        );
        const status = axios.isAxiosError(error)
            ? error.response?.status
            : undefined;
        throw new SessionFilesError(
            status != null && status >= 400 && status < 500
                ? 'SESSION_INPUT_UNAVAILABLE'
                : 'SESSION_INPUT_SOURCE_FAILED',
            `Failed to fetch input ${ref.name} from file server`,
        );
    }
}

function tarDirectory(
    root: string,
    archive: string,
    signal?: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-czf', archive, '-C', root, '.'], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, COPYFILE_DISABLE: '1' },
            signal,
        });
        const errChunks: Buffer[] = [];
        tar.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
        tar.on('error', error => {
            reject(
                new SessionFilesError(
                    signal?.aborted
                        ? 'SESSION_INPUT_ABORTED'
                        : 'SESSION_INPUT_PREPARATION_FAILED',
                    signal?.aborted
                        ? 'Session input delivery aborted'
                        : `Failed to start inputs tar: ${error.message}`,
                ),
            );
        });
        tar.on('close', code => {
            if (code !== 0) {
                reject(
                    new SessionFilesError(
                        'SESSION_INPUT_PREPARATION_FAILED',
                        `inputs tar exited ${code}: ${Buffer.concat(errChunks).toString()}`,
                    ),
                );
                return;
            }
            resolve();
        });
    });
}
