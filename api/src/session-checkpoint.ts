import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Request, Response } from 'express';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import { config } from './config';
import { logger } from './logger';
import {
    SANDBOX_WORKSPACE_ROOT,
    SESSION_WORKSPACE_ID,
} from './workspace-isolation';
import type {
    SessionMetaSnapshot,
    SessionWorkspace,
} from './session-workspace';
import {
    SESSION_META_FILE,
    SESSION_META_MARKER,
    getBoundSessionWorkspace,
} from './session-workspace';

/**
 * Session workspace checkpoint / restore.
 *
 * Makes an expiring MicroVM's state survive across a relaunch: the control
 * plane pulls a compressed archive of the session workspace over the authed
 * proxy (GET /checkpoint), stores it in S3, and pushes it back into a fresh
 * VM's workspace before the first execute (POST /restore). The untrusted VM
 * never touches S3 — only tars its own `/mnt/data`.
 *
 * Only reachable when a session is bound (getBoundSessionWorkspace); returns
 * 409 otherwise so the legacy fresh-per-job runner exposes nothing new.
 */

const CHECKPOINT_CONTENT_TYPE = 'application/x-gtar';
/** Runner-only top-level archive member. It is a sibling of `session/`, never
 * a path inside the user workspace, so user code cannot collide with it. Keep
 * this as ONE top-level file: pre-control-namespace restores use
 * `--strip-components=1`, which safely skips a one-component member but would
 * extract `control-dir/file` as a user-visible `file` during rollback. */
const CHECKPOINT_CONTROL_FILE = '.codeapi-checkpoint-control.v2.json';
/** Primed-input state is correctness-critical: losing it can overwrite
 * sandbox-modified inputs after restore. Keep the full control record whenever
 * it fits this bounded parse budget. Only beyond the hard limit may expendable
 * surfaced-output signatures be dropped; primed state is never discarded. */
const CHECKPOINT_CONTROL_MAX_BYTES = 16 * 1024 * 1024;

export class SessionCheckpointError extends Error {}

function currentUid(): number | undefined {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Serializes best-effort control metadata without making an otherwise valid
 * workspace impossible to checkpoint. Surfaced-output signatures are only a
 * dedup optimization, so discard them first. Primed-input state protects
 * sandbox edits from being overwritten after restore, so it is never silently
 * discarded. An extreme session that exceeds the bounded metadata budget must
 * fail its checkpoint instead of persisting a corrupt recovery point.
 */
function checkpointControlBytes(session: SessionWorkspace): Buffer {
    const snapshot = session.snapshotMeta();
    const encode = (meta: SessionMetaSnapshot): Buffer =>
        Buffer.from(JSON.stringify({ marker: SESSION_META_MARKER, ...meta }));

    const full = encode(snapshot);
    if (full.length <= CHECKPOINT_CONTROL_MAX_BYTES) return full;

    const withoutSurfaced = encode({ primed: snapshot.primed, surfaced: [] });
    logger.warn(
        {
            fullBytes: full.length,
            reducedBytes: withoutSurfaced.length,
            maxBytes: CHECKPOINT_CONTROL_MAX_BYTES,
        },
        'Checkpoint control metadata is oversized; dropping surfaced-output state',
    );
    if (withoutSurfaced.length <= CHECKPOINT_CONTROL_MAX_BYTES) {
        return withoutSurfaced;
    }

    throw new SessionCheckpointError(
        `checkpoint primed-input metadata exceeds ${CHECKPOINT_CONTROL_MAX_BYTES} bytes`,
    );
}

export interface SessionCheckpointStreamOptions {
    /** Test seam for deterministic late tar-failure coverage. */
    tarCommand?: string;
}

/** Streams a capped `tar.gz` of the session workspace to the response. */
export async function streamSessionCheckpoint(
    res: Response,
    options: SessionCheckpointStreamOptions = {},
): Promise<void> {
    const session = getBoundSessionWorkspace();
    if (!session) {
        res.status(409).json({ message: 'No session workspace is bound' });
        return;
    }
    if (session.dirtyReason) {
        res.status(409).json({
            error: 'session_workspace_dirty',
            message: 'Session workspace must be restored before checkpointing',
        });
        return;
    }
    await session.ownership();

    /* Carry priming/output-diff state in a separate top-level archive member.
     * The old format temporarily wrote SESSION_META_FILE into `/mnt/data`, which
     * either deleted a symlink/directory with that user-visible name or skipped
     * metadata for a legitimate regular file. A sibling archive member has no
     * collision with any path user code can create and never mutates the live
     * workspace. Restore still understands the legacy in-workspace sidecar. */
    let controlStage: string | undefined;
    try {
        controlStage = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'codeapi-checkpoint-control-'),
        );
        const controlBytes = checkpointControlBytes(session);
        await fsp.writeFile(
            path.join(controlStage, CHECKPOINT_CONTROL_FILE),
            controlBytes,
            { flag: 'wx', mode: 0o600 },
        );

        res.status(200);
        res.setHeader('Content-Type', CHECKPOINT_CONTENT_TYPE);
        /* Cap the uncompressed tar before gzip as well as the compressed response.
         * Restore applies the same two limits in reverse, so every checkpoint that
         * creation completes is guaranteed to be admissible under the same config.
         * Keeping tar and gzip as separate streaming stages preserves bounded
         * memory, backpressure, and the existing tar.gz wire format. */
        const tar = spawn(
            options.tarCommand ?? 'tar',
            [
                '-cf',
                '-',
                '-C',
                SANDBOX_WORKSPACE_ROOT,
                SESSION_WORKSPACE_ID,
                '-C',
                controlStage,
                CHECKPOINT_CONTROL_FILE,
            ],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, COPYFILE_DISABLE: '1' },
            },
        );
        tar.stderr.on('data', (chunk: Buffer) =>
            logger.debug({ tar: chunk.toString() }, 'checkpoint tar'),
        );
        /* Register the 'close' listener BEFORE awaiting the pipeline: for a small
         * workspace tar can exit and emit 'close' before pipeline resolves, and a
         * listener attached only afterward would miss it and hang here forever.
         * The 'error' listener turns a spawn failure (e.g. tar missing from PATH)
         * into a rejected promise instead of an unhandled ChildProcess 'error'
         * crashing the runner. */
        const closed: Promise<number> = new Promise((resolve, reject) => {
            tar.on('close', resolve);
            tar.on('error', reject);
        });
        /* Observe the rejection immediately: when `tar` fails to spawn, `pipeline`
         * below rejects first and we never reach `await closed` — an unobserved
         * rejection would then take the whole runner down after we already
         * answered 500. The later `await closed` still sees the same rejection. */
        closed.catch(() => {});
        try {
            await pipeline(
                tar.stdout,
                checkpointStreamLimit(config.checkpoint_max_bytes, 'expanded'),
                createGzip(),
                checkpointStreamLimit(
                    config.checkpoint_max_bytes,
                    'compressed',
                ),
                res,
                /* Do not publish a successful HTTP EOF until tar itself exits zero.
                 * A tar process can emit bytes and close stdout before reporting a
                 * late read error. Ending the response inside pipeline would make that
                 * partial archive look complete to the control plane, which could then
                 * commit it and prune the preceding recovery point. */
                { end: false },
            );
            const code = await closed;
            if (code !== 0)
                throw new SessionCheckpointError(
                    `checkpoint tar exited ${code}`,
                );
            res.end();
        } catch (error) {
            /* A downstream disconnect or either byte cap can stop consumption while
             * tar is still writing. Terminate and reap it so no child or temp-stage
             * lifetime escapes the failed request. */
            if (tar.exitCode === null && tar.signalCode === null)
                tar.kill('SIGKILL');
            await closed.catch(() => {});
            throw error;
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to stream session checkpoint');
        if (!res.headersSent)
            res.status(500).json({ message: 'checkpoint failed' });
        else res.destroy();
    } finally {
        if (controlStage) {
            await fsp
                .rm(controlStage, { recursive: true, force: true })
                .catch(() => {});
        }
    }
}

export interface SessionCheckpointOwnershipOps {
    lchown(target: string, uid: number, gid: number): Promise<void>;
    chown(target: string, uid: number, gid: number): Promise<void>;
}

export interface SessionCheckpointRestoreOptions {
    /** Test seam for deterministic ownership-failure coverage. */
    ownershipOps?: SessionCheckpointOwnershipOps;
    /** Test seam for deterministic commit/rollback failure coverage. */
    rename?: (source: string, destination: string) => Promise<void>;
    /** Non-root local development cannot chown to the compatibility sandbox UID.
     * Production hardened/per-job-UID mode never enables this fallback. */
    allowUnprivilegedOwnershipFallback?: boolean;
}

const DEFAULT_OWNERSHIP_OPS: SessionCheckpointOwnershipOps = {
    lchown: (target, uid, gid) => fsp.lchown(target, uid, gid),
    chown: (target, uid, gid) => fsp.chown(target, uid, gid),
};

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

function checkpointStreamLimit(
    maxBytes: number,
    kind: 'compressed' | 'expanded',
): Transform {
    let received = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            callback(
                received > maxBytes
                    ? new SessionCheckpointError(
                          `checkpoint ${kind} stream exceeds ${maxBytes} bytes`,
                      )
                    : null,
                chunk,
            );
        },
    });
}

/** Extracts a `tar.gz` into a staging tree, validates its allowed top-level
 * members, re-owns the workspace, then replaces the live session directory.
 * Staging keeps a corrupt archive or ownership failure from ever becoming an
 * executable workspace. */
export async function restoreSessionCheckpoint(
    req: Request,
    res: Response,
    options: SessionCheckpointRestoreOptions = {},
): Promise<void> {
    const session = getBoundSessionWorkspace();
    if (!session) {
        res.status(409).json({ message: 'No session workspace is bound' });
        return;
    }
    const { dir, uid, gid } = await session.ownership();
    const restoreStage = await fsp.mkdtemp(
        path.join(SANDBOX_WORKSPACE_ROOT, '.session-restore-'),
    );
    const restoredWorkspace = path.join(restoreStage, SESSION_WORKSPACE_ID);
    const restoredControl = path.join(restoreStage, CHECKPOINT_CONTROL_FILE);
    const liveBackup = path.join(restoreStage, '.live-workspace-backup');
    const rename = options.rename ?? fsp.rename;
    let liveBackedUp = false;
    let committed = false;
    let retainStageForRecovery = false;
    try {
        /* Decompress in-process so the runner can independently cap BOTH the
         * compressed request and the expanded tar stream. Passing gzip directly to
         * `tar -xzf` would let a tiny, highly-compressible checkpoint fill the
         * workspace disk before any post-extraction validation could run. */
        const gunzip = createGunzip();
        /* Keep reading through zero end markers until the expanded stream reaches
         * EOF. Without --ignore-zeros, tar can exit after the first marker while
         * gunzip still has valid tar padding to emit, closing stdin underneath
         * pipeline with ERR_STREAM_PREMATURE_CLOSE. */
        const tar = spawn(
            'tar',
            ['--ignore-zeros', '-xf', '-', '-C', restoreStage],
            {
                stdio: ['pipe', 'ignore', 'pipe'],
                env: { ...process.env, COPYFILE_DISABLE: '1' },
            },
        );
        tar.stderr.on('data', (chunk: Buffer) =>
            logger.debug({ tar: chunk.toString() }, 'restore tar'),
        );
        const closed: Promise<number> = new Promise((resolve, reject) => {
            tar.on('close', resolve);
            tar.on('error', reject);
        });
        /* Observe immediately: a spawn failure may reject the input pipeline first. */
        closed.catch(() => {});
        try {
            /* Register the 'close' listener before awaiting the pipeline (see the
             * create side): a small upload can finish and 'close' can fire before
             * pipeline resolves, and a listener attached afterward would hang. */
            await pipeline(
                req,
                checkpointStreamLimit(
                    config.checkpoint_max_bytes,
                    'compressed',
                ),
                gunzip,
                checkpointStreamLimit(config.checkpoint_max_bytes, 'expanded'),
                tar.stdin,
            );
            const code = await closed;
            if (code !== 0)
                throw new SessionCheckpointError(`restore tar exited ${code}`);
        } catch (error) {
            if (tar.exitCode === null && tar.signalCode === null)
                tar.kill('SIGKILL');
            await closed.catch(() => {});
            throw error;
        }

        const topLevel = await fsp.readdir(restoreStage, {
            withFileTypes: true,
        });
        const allowed = new Set([
            SESSION_WORKSPACE_ID,
            CHECKPOINT_CONTROL_FILE,
        ]);
        const unexpected = topLevel.find(entry => !allowed.has(entry.name));
        if (unexpected) {
            throw new SessionCheckpointError(
                `checkpoint contains unexpected top-level member: ${unexpected.name}`,
            );
        }
        const workspaceStat = await fsp
            .lstat(restoredWorkspace)
            .catch(() => null);
        if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
            throw new SessionCheckpointError(
                'checkpoint session workspace is not a real directory',
            );
        }
        const controlStat = await fsp.lstat(restoredControl).catch(() => null);
        if (
            controlStat &&
            (!controlStat.isFile() || controlStat.isSymbolicLink())
        ) {
            throw new SessionCheckpointError(
                'checkpoint control metadata is not a regular file',
            );
        }

        const restoredMeta = await readRestoredMeta(
            restoredWorkspace,
            controlStat ? restoredControl : undefined,
        );
        const runnerUid = currentUid();
        const allowUnprivilegedFallback =
            options.allowUnprivilegedOwnershipFallback ??
            (runnerUid !== undefined &&
                runnerUid !== 0 &&
                !config.hardened_sandbox_mode &&
                !config.per_job_uids);
        await chownRecursive(
            restoredWorkspace,
            uid,
            gid,
            options.ownershipOps ?? DEFAULT_OWNERSHIP_OPS,
            allowUnprivilegedFallback,
        );

        /* Commit only after extraction, metadata validation and ownership all
         * succeeded. Rename the old workspace aside first so a failed install can
         * atomically put it back; deleting it before rename made a staged failure
         * destroy valid live session state. Both paths share the workspace
         * filesystem, so each individual rename is atomic. */
        await rename(dir, liveBackup);
        liveBackedUp = true;
        await rename(restoredWorkspace, dir);
        liveBackedUp = false;
        session.loadMeta(restoredMeta);
        committed = true;

        /* The checkpoint is committed before delivery of the HTTP acknowledgement.
         * A socket/serialization error now causes the control plane to recycle this
         * VM, but must never roll the successfully restored workspace backward. */
        await fsp
            .rm(liveBackup, { recursive: true, force: true })
            .catch(error => {
                logger.warn(
                    { err: error, liveBackup },
                    'Failed to remove replaced checkpoint workspace',
                );
            });
        res.status(200).json({ status: 'restored', dir: path.basename(dir) });
    } catch (error) {
        if (committed) {
            logger.error(
                { err: error },
                'Checkpoint restored but response delivery failed',
            );
            throw error;
        }

        if (liveBackedUp) {
            try {
                await rename(liveBackup, dir);
                liveBackedUp = false;
            } catch (rollbackError) {
                retainStageForRecovery = true;
                session.markDirty('checkpoint restore rollback failed');
                logger.error(
                    {
                        err: error,
                        rollbackErr: rollbackError,
                        recoveryPath: liveBackup,
                    },
                    'Failed to roll back checkpoint workspace replacement',
                );
            }
        }
        logger.error({ err: error }, 'Failed to restore session checkpoint');
        /* Extraction, validation, and ownership happen only in restoreStage.
         * Ordinary pre-commit failures therefore leave both the live workspace and
         * its matching metadata/dirty state untouched. Only an unsuccessful
         * rollback above marks the session dirty and retains its recovery copy. */
        if (!res.headersSent)
            res.status(500).json({ message: 'restore failed' });
    } finally {
        if (!retainStageForRecovery) {
            await fsp
                .rm(restoreStage, { recursive: true, force: true })
                .catch(() => {});
        }
    }
}

function isSessionMetaSnapshot(value: unknown): value is SessionMetaSnapshot {
    if (value == null || typeof value !== 'object') return false;
    const snapshot = value as SessionMetaSnapshot;
    if (snapshot.marker !== SESSION_META_MARKER) return false;
    if (!Array.isArray(snapshot.primed) || !Array.isArray(snapshot.surfaced))
        return false;
    const validPrimed = snapshot.primed.every(
        entry =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            entry[1] != null &&
            typeof entry[1] === 'object' &&
            typeof entry[1].id === 'string' &&
            typeof entry[1].readOnly === 'boolean' &&
            (entry[1].hash === undefined || typeof entry[1].hash === 'string'),
    );
    const validSurfaced = snapshot.surfaced.every(
        entry =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string',
    );
    return validPrimed && validSurfaced;
}

/** Applies runner control metadata. New checkpoints carry it outside
 * `session/`; old checkpoints are read from the legacy in-workspace sidecar.
 * Presence of a new control member is authoritative: invalid metadata rejects
 * the restore, and a user file at the legacy name is never reinterpreted or
 * deleted. */
async function readRestoredMeta(
    workspaceDir: string,
    controlPath?: string,
): Promise<SessionMetaSnapshot> {
    const empty: SessionMetaSnapshot = { primed: [], surfaced: [] };
    /* Parse and validate metadata without mutating the live session. The caller
     * installs the returned snapshot only after the staged workspace commits. */
    if (controlPath) {
        const stat = await fsp.lstat(controlPath).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
            throw new SessionCheckpointError(
                'checkpoint control metadata is not a regular file',
            );
        }
        if (stat.size > CHECKPOINT_CONTROL_MAX_BYTES) {
            throw new SessionCheckpointError(
                `checkpoint control metadata exceeds ${CHECKPOINT_CONTROL_MAX_BYTES} bytes`,
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(
                await fsp.readFile(controlPath, 'utf8'),
            ) as unknown;
        } catch {
            throw new SessionCheckpointError(
                'checkpoint control metadata is not valid JSON',
            );
        }
        if (!isSessionMetaSnapshot(parsed)) {
            throw new SessionCheckpointError(
                'checkpoint control metadata is malformed or incompatible',
            );
        }
        return parsed;
    }

    const metaPath = path.join(workspaceDir, SESSION_META_FILE);
    try {
        /* Backward compatibility for checkpoints created by the pre-control-
         * namespace format. Only trust a runner-owned writable regular file:
         * user-created and read-only-input collisions remain ordinary user data. */
        const stat = await fsp.lstat(metaPath).catch(() => null);
        if (!stat?.isFile()) return empty;
        const trustedOwner = currentUid();
        const ownerMatches = trustedOwner == null || stat.uid === trustedOwner;
        const ownerWritable = (stat.mode & 0o200) !== 0;
        if (!ownerMatches || !ownerWritable) {
            logger.warn(
                'Ignoring untrusted session meta sidecar from restored workspace',
            );
            return empty;
        }
        const parsed = JSON.parse(
            await fsp.readFile(metaPath, 'utf8'),
        ) as unknown;
        if (isSessionMetaSnapshot(parsed)) {
            await fsp.rm(metaPath, { force: true }).catch(() => {});
            return parsed;
        } else if (
            typeof (parsed as { marker?: unknown })?.marker === 'string' &&
            (parsed as { marker: string }).marker.startsWith(
                'codeapi.session-meta.v',
            )
        ) {
            /* This is a runner-owned sidecar from an incompatible pre-release image,
             * not a user file. Never load it under the current schema and never leave
             * it in the workspace to be surfaced as a generated artifact. Rollouts
             * that change this marker must drain/recycle old development sessions. */
            logger.warn(
                {
                    marker: (parsed as { marker: string }).marker,
                    expected: SESSION_META_MARKER,
                },
                'Ignoring incompatible session checkpoint metadata',
            );
            await fsp.rm(metaPath, { force: true }).catch(() => {});
        }
    } catch (error) {
        logger.debug({ err: error }, 'No session meta sidecar to restore');
    }
    return empty;
}

async function applyOwnership(
    operation: () => Promise<void>,
    allowUnprivilegedFallback: boolean,
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        const code = errorCode(error);
        if (
            allowUnprivilegedFallback &&
            (code === 'EPERM' || code === 'EACCES')
        ) {
            return;
        }
        throw error;
    }
}

async function chownRecursive(
    dir: string,
    uid: number,
    gid: number,
    ownershipOps: SessionCheckpointOwnershipOps,
    allowUnprivilegedFallback: boolean,
): Promise<void> {
    await applyOwnership(
        () => ownershipOps.lchown(dir, uid, gid),
        allowUnprivilegedFallback,
    );
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        /* A restored checkpoint is untrusted content: never follow symlinks. A
         * `session/x -> /etc/passwd` entry would otherwise have `chown` re-own the
         * target outside the workspace. Do not trust Dirent.d_type here because
         * some filesystems report DT_UNKNOWN; lstat every member, lchown links, and
         * never recurse through them. */
        const stat = await fsp.lstat(full);
        if (stat.isSymbolicLink()) {
            await applyOwnership(
                () => ownershipOps.lchown(full, uid, gid),
                allowUnprivilegedFallback,
            );
            continue;
        }
        await applyOwnership(
            () => ownershipOps.chown(full, uid, gid),
            allowUnprivilegedFallback,
        );
        if (stat.isDirectory()) {
            await chownRecursive(
                full,
                uid,
                gid,
                ownershipOps,
                allowUnprivilegedFallback,
            );
        }
    }
}
