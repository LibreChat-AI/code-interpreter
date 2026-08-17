import axios from 'axios';
import * as fs from 'fs';
import { Readable } from 'stream';
import type { MicrovmAuthToken } from './lambda-client';
import { microvmPortHeaders } from './lambda-client';
import {
    CheckpointTooLargeError,
    checkpointArtifactFromStream,
    type CheckpointArtifact,
    type CheckpointStore,
} from './checkpoint-store';
import {
    acquireRuntimeSessionLock,
    allocateCheckpointSequence,
    readRuntimeSessionRecord,
    releaseRuntimeSessionLock,
    writeRuntimeSessionRecord,
} from './registry';
import { checkpointObjectKey } from './checkpoint-store';
import {
    microvmCheckpoints,
    microvmRestores,
    microvmCheckpointBytes,
} from '../metrics';
import { CHECKPOINT_METADATA_TIMEOUT_CAP_MS } from '../config';
import logger from '../logger';

/** Reject if `promise` doesn't settle within `ms`, so a stalled metadata leg
 * cannot hold the session lock. The production S3-compatible store separately
 * attaches an AbortSignal deadline to every request and streamed transfer,
 * which destroys the underlying transport when its hard bound expires. */
function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        promise.then(
            value => {
                clearTimeout(timer);
                if (timedOut) {
                    if (onLateValue)
                        void Promise.resolve(onLateValue(value)).catch(
                            () => {},
                        );
                    return;
                }
                resolve(value);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * Auto-checkpoint orchestration. The workspace only mutates during an
 * execute, and executes serialize on the session lock — so a lock-guarded
 * checkpoint after each exec yields complete, tear-free coverage: if a newer
 * exec already holds the lock we skip, and that exec's own post-checkpoint
 * covers our changes. Restore runs in-path on relaunch, before the first
 * execute on the fresh VM. A missed post-exec checkpoint is non-fatal and
 * leaves the prior durable pointer intact. Restore failures fail closed and
 * recycle the fresh VM rather than silently running against an empty or
 * partially restored workspace.
 */

export interface CheckpointConfig {
    port: number;
    authTokenTtlSeconds: number;
    maxBytes: number;
    timeoutMs: number;
}

/* Opts the runner into session mode for checkpoint/restore. These run before
 * the first /execute on a relaunched VM, so the runner has nothing bound yet in
 * the hookless design; without this header the handler 409s. Case-insensitive,
 * matches the runner's `x-runtime-session-id`. */
const RUNTIME_SESSION_ID_HEADER = 'X-Runtime-Session-Id';

export async function pullCheckpoint(
    args: {
        mintToken: () => Promise<MicrovmAuthToken>;
        endpointBase: string;
        runtimeSessionId: string;
        signal?: AbortSignal;
    },
    config: CheckpointConfig,
): Promise<CheckpointArtifact> {
    const token = await args.mintToken();
    /* Axios' Node `timeout` is a socket-inactivity timeout. A peer that keeps
     * trickling bytes can therefore outlive it, so add an absolute transfer
     * deadline that remains attached until the response stream finishes. */
    const transferDeadlineSignal = AbortSignal.timeout(config.timeoutMs);
    const transferSignal = args.signal
        ? AbortSignal.any([args.signal, transferDeadlineSignal])
        : transferDeadlineSignal;
    const response = await axios.get<Readable>(
        `${args.endpointBase}/api/v2/session/checkpoint`,
        {
            headers: {
                [token.headerName]: token.token,
                ...microvmPortHeaders(config.port),
                [RUNTIME_SESSION_ID_HEADER]: args.runtimeSessionId,
            },
            responseType: 'stream',
            timeout: config.timeoutMs,
            signal: transferSignal,
        },
    );
    const announced = Number(response.headers['content-length']);
    if (Number.isFinite(announced) && announced > config.maxBytes) {
        response.data.destroy();
        throw new CheckpointTooLargeError(
            `checkpoint ${announced}B exceeds maxBytes ${config.maxBytes}B`,
        );
    }
    return checkpointArtifactFromStream(response.data, config.maxBytes);
}

export async function pushRestore(
    args: {
        mintToken: () => Promise<MicrovmAuthToken>;
        endpointBase: string;
        runtimeSessionId: string;
        signal?: AbortSignal;
    },
    data: CheckpointArtifact,
    config: CheckpointConfig,
): Promise<void> {
    const token = await args.mintToken();
    await axios.post(
        `${args.endpointBase}/api/v2/session/restore`,
        fs.createReadStream(data.path),
        {
            headers: {
                [token.headerName]: token.token,
                ...microvmPortHeaders(config.port),
                [RUNTIME_SESSION_ID_HEADER]: args.runtimeSessionId,
                'Content-Type': 'application/x-gtar',
                'Content-Length': String(data.size),
            },
            maxBodyLength: config.maxBytes,
            timeout: config.timeoutMs,
            signal: args.signal,
        },
    );
}

/**
 * Asks the VM which of `refs` its input cache is missing. Dedupe lives here,
 * not in Redis: control-plane state can be lost with a recycle, while the VM
 * cannot be wrong about what it holds.
 */
export async function probeInputs(
    args: {
        mintToken: () => Promise<MicrovmAuthToken>;
        endpointBase: string;
        signal?: AbortSignal;
    },
    refs: Array<{ cache_key: string }>,
    config: CheckpointConfig,
): Promise<Array<{ cache_key: string }>> {
    const token = await args.mintToken();
    const response = await axios.post<{
        missing?: Array<{ cache_key: string }>;
    }>(
        `${args.endpointBase}/api/v2/session/inputs/probe`,
        { refs },
        {
            headers: {
                [token.headerName]: token.token,
                ...microvmPortHeaders(config.port),
                'Content-Type': 'application/json',
            },
            timeout: config.timeoutMs,
            signal: args.signal,
        },
    );
    const missing = response.data?.missing;
    if (!Array.isArray(missing)) {
        throw new Error('Runner returned an invalid input probe response');
    }
    const requested = new Set(refs.map(ref => ref.cache_key));
    const seen = new Set<string>();
    for (const ref of missing) {
        if (
            typeof ref?.cache_key !== 'string' ||
            !/^[0-9a-f]{64}$/.test(ref.cache_key) ||
            !requested.has(ref.cache_key) ||
            seen.has(ref.cache_key)
        ) {
            throw new Error('Runner returned an invalid input probe response');
        }
        seen.add(ref.cache_key);
    }
    return missing;
}

/** Pushes a digest-named input batch into the VM's runner-local cache. Never
 *  touches the sandbox workspace — priming does that, from the cache. */
export async function pushInputs(
    args: {
        mintToken: () => Promise<MicrovmAuthToken>;
        endpointBase: string;
        signal?: AbortSignal;
    },
    data: NodeJS.ReadableStream | Buffer | (() => NodeJS.ReadableStream),
    config: CheckpointConfig,
    contentLength?: number,
    expandedBytes?: number,
): Promise<void> {
    const token = await args.mintToken();
    /* Build file streams only after token minting succeeds. An eagerly-created
     * fs.ReadStream opens on a later tick; if minting rejects, caller cleanup can
     * unlink the archive first and the stream then emits an unhandled ENOENT. */
    const requestData = typeof data === 'function' ? data() : data;
    await axios.post(
        `${args.endpointBase}/api/v2/session/inputs`,
        requestData,
        {
            headers: {
                [token.headerName]: token.token,
                ...microvmPortHeaders(config.port),
                'Content-Type': 'application/x-gtar',
                ...(contentLength === undefined
                    ? {}
                    : { 'Content-Length': String(contentLength) }),
                ...(expandedBytes === undefined
                    ? {}
                    : {
                          'X-CodeAPI-Input-Expanded-Bytes':
                              String(expandedBytes),
                      }),
            },
            maxBodyLength: Math.max(config.maxBytes, contentLength ?? 0),
            timeout: config.timeoutMs,
            signal: args.signal,
        },
    );
}

/**
 * Checkpoint the session workspace: pull the tar from the still-warm VM,
 * store it, and record the pointer under the lock (fenced write). Pass
 * `lockToken` to reuse a lock already held (the post-exec path); omit it for
 * a standalone checkpoint (e.g. a pre-deadline sweep), which takes a single
 * non-blocking lock — a busy lock means a newer exec is running and its own
 * post-checkpoint will cover this one.
 */
export async function checkpointSession(args: {
    mintToken: (microvmId: string) => Promise<MicrovmAuthToken>;
    store: CheckpointStore;
    runtimeSessionId: string;
    config: CheckpointConfig;
    normalizeEndpoint: (endpoint: string) => string;
    lockToken?: string;
    signal?: AbortSignal;
}): Promise<'stored' | 'skipped_busy' | 'skipped_state' | 'failed'> {
    const heldToken = args.lockToken;
    const registryOptions = { signal: args.signal };
    const lockToken =
        heldToken ??
        (await acquireRuntimeSessionLock(
            args.runtimeSessionId,
            undefined,
            registryOptions,
        ));
    let data: CheckpointArtifact | undefined;
    if (!lockToken) {
        microvmCheckpoints.inc({ outcome: 'skipped_busy' });
        return 'skipped_busy';
    }
    try {
        const record = await readRuntimeSessionRecord(
            args.runtimeSessionId,
            registryOptions,
        );
        if (
            !record ||
            record.state !== 'RUNNING' ||
            !record.microvm_id ||
            !record.endpoint
        ) {
            microvmCheckpoints.inc({ outcome: 'skipped_state' });
            return 'skipped_state';
        }
        const microvmId = record.microvm_id;
        data = await pullCheckpoint(
            {
                mintToken: () => args.mintToken(microvmId),
                endpointBase: args.normalizeEndpoint(record.endpoint),
                runtimeSessionId: args.runtimeSessionId,
                signal: args.signal,
            },
            args.config,
        );
        /* Read the durable high-water mark before reserving a sequence. The Redis
         * reservation atomically advances above max(counter, retainedMax), so even
         * a stale holder that resumes after lock expiry receives a distinct object
         * key and cannot overwrite the newer holder's committed checkpoint. */
        const retainedMax = await withTimeout(
            args.store.latestSequence(args.runtimeSessionId),
            Math.min(args.config.timeoutMs, CHECKPOINT_METADATA_TIMEOUT_CAP_MS),
            'checkpoint store.latestSequence',
        );
        const sequence = await allocateCheckpointSequence(
            args.runtimeSessionId,
            retainedMax,
            registryOptions,
        );
        /* Upload immutable data first. If this times out or we lose the lock before
         * the pointer CAS, it is only an uncommitted orphan: restore ignores it. */
        await withTimeout(
            args.store.put(args.runtimeSessionId, sequence, data),
            args.config.timeoutMs,
            'checkpoint store.put',
        );

        /* Commit the exact pointer under the session fence only after the object
         * exists. This prevents a crash/timeout from publishing a missing object. */
        const persisted = await writeRuntimeSessionRecord(
            {
                ...record,
                workspace_checkpoint: checkpointObjectKey(
                    args.runtimeSessionId,
                    sequence,
                ),
                checkpointed_at: Date.now(),
            },
            lockToken,
            undefined,
            registryOptions,
        );
        if (!persisted) {
            microvmCheckpoints.inc({ outcome: 'skipped_busy' });
            return 'skipped_busy';
        }

        /* The Redis pointer is authoritative while present. A durable commit
         * marker lets a later restore recover after Redis TTL/loss without ever
         * selecting an uncommitted late upload. Marker/GC failures must not undo
         * the already-committed pointer. */
        let markerCommitted = false;
        await withTimeout(
            args.store.commit(args.runtimeSessionId, sequence),
            Math.min(args.config.timeoutMs, CHECKPOINT_METADATA_TIMEOUT_CAP_MS),
            'checkpoint store.commit',
        )
            .then(() => {
                markerCommitted = true;
            })
            .catch(error => {
                logger.warn(
                    'Checkpoint commit marker failed; Redis pointer remains authoritative',
                    {
                        runtimeSessionId: args.runtimeSessionId,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                );
            });
        /* Never prune the previous durable recovery point unless the new marker
         * exists. The Redis pointer can outlive a marker failure, but Redis loss
         * must still fall back to the prior committed pair. */
        if (markerCommitted) {
            void args.store
                .pruneOlderThan(args.runtimeSessionId, sequence)
                .catch(error => {
                    logger.warn('Checkpoint garbage collection failed', {
                        runtimeSessionId: args.runtimeSessionId,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                });
        }
        microvmCheckpointBytes.observe(data.size);
        microvmCheckpoints.inc({ outcome: 'stored' });
        return 'stored';
    } catch (error) {
        microvmCheckpoints.inc({ outcome: 'failed' });
        logger.warn('Session checkpoint failed', {
            runtimeSessionId: args.runtimeSessionId,
            error: error instanceof Error ? error.message : String(error),
        });
        return 'failed';
    } finally {
        await data?.cleanup().catch(() => {});
        /* Only release a lock we acquired here. */
        if (!heldToken)
            await releaseRuntimeSessionLock(args.runtimeSessionId, lockToken);
    }
}

/** Relaunch restore: caller holds the session lock and the VM is RUNNING. */
export async function restoreSession(args: {
    mintToken: (microvmId: string) => Promise<MicrovmAuthToken>;
    store: CheckpointStore;
    runtimeSessionId: string;
    microvmId: string;
    endpointBase: string;
    config: CheckpointConfig;
    signal?: AbortSignal;
    checkpointKey?: string;
}): Promise<'restored' | 'absent' | 'fetch_failed' | 'push_failed'> {
    /* The store enforces `maxBytes` before and during its streamed download, so an
     * oversized/stray checkpoint cannot consume unbounded worker memory or disk.
     * Bound the fetch too — a stalled S3/MinIO get would otherwise hold the
     * session lock through the whole relaunch and time the request out. */
    let data: CheckpointArtifact | null;
    try {
        data = await withTimeout(
            args.store.get(
                args.runtimeSessionId,
                args.config.maxBytes,
                args.checkpointKey,
            ),
            args.config.timeoutMs,
            'checkpoint store.get',
            late => late?.cleanup(),
        );
    } catch (error) {
        /* Fetch failed before the runner was touched — the workspace is still the
         * clean fresh-VM one, but a prior checkpoint pointer means running there
         * would silently lose session state. The caller fails closed and recycles
         * this VM. */
        microvmRestores.inc({ outcome: 'failed' });
        logger.warn(
            'Checkpoint fetch failed; refusing to run with an empty workspace',
            {
                runtimeSessionId: args.runtimeSessionId,
                error: error instanceof Error ? error.message : String(error),
            },
        );
        return 'fetch_failed';
    }
    if (!data) {
        microvmRestores.inc({ outcome: 'absent' });
        return 'absent';
    }
    try {
        await pushRestore(
            {
                mintToken: () => args.mintToken(args.microvmId),
                endpointBase: args.endpointBase,
                runtimeSessionId: args.runtimeSessionId,
                signal: args.signal,
            },
            data,
            args.config,
        );
        microvmRestores.inc({ outcome: 'restored' });
        logger.info('Session workspace restored from checkpoint', {
            runtimeSessionId: args.runtimeSessionId,
            bytes: data.size,
        });
        return 'restored';
    } catch (error) {
        /* Push failed AFTER the runner may have started extracting/chowning/wiping
         * the workspace. That cleanup runs async past our client abort, so the
         * workspace is possibly-partial — the caller must recycle the VM rather than
         * execute against it. */
        microvmRestores.inc({ outcome: 'failed' });
        logger.warn(
            'Checkpoint push-restore failed; the VM workspace may be partial',
            {
                runtimeSessionId: args.runtimeSessionId,
                error: error instanceof Error ? error.message : String(error),
            },
        );
        return 'push_failed';
    } finally {
        await data.cleanup().catch(() => {});
    }
}
