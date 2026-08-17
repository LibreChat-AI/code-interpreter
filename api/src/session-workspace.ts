import { config } from './config';
import { logger } from './logger';
import {
    ensureSessionWorkspace,
    resetSessionWorkspace,
    sandboxJobUidPool,
    type SandboxJobIdentity,
    type SandboxWorkspaceLease,
} from './workspace-isolation';

/**
 * Persistent, stateful session workspace for the Lambda MicroVM backend.
 *
 * A session-bound VM runs exactly one runtime session, and its executions
 * serialize on the control-plane lock — so the runner keeps a single
 * long-lived workspace and a single pinned UID, reused by every `/execute`.
 * This is what turns the semi-stateless runner stateful: files, installed
 * packages, and chDB dirs under `/mnt/data` survive between calls instead of
 * being wiped per job.
 *
 * Gated by two independent locks (both required): the image-level
 * `SANDBOX_SESSION_WORKSPACE_ENABLED` (true only in the Lambda MicroVM runner
 * target) and a per-request opt-in. The control plane opts a VM into session
 * mode by stamping the derived runtime session id on every `/execute` via the
 * `X-Runtime-Session-Id` header (see `parseSessionBindingFromHeader`). When
 * neither lock is active, `getBoundSessionWorkspace()` returns undefined and
 * the runner falls back to the untouched fresh-per-job path.
 *
 * The header, not a `/run` lifecycle hook, is the delivery mechanism: Lambda's
 * image build hooks require the snapshot-compatible Lambda base container image
 * to route, and enabling any runtime hook forces the `/ready` build hook, which
 * never reaches a stock container's listener. Per-request signaling keeps image
 * builds hookless (reliable) and needs no snapshot handshake.
 */

/** Wire contract with the Lambda backend (`service/src/sandbox-backend`). */
export const RUNTIME_SESSION_ID_HEADER = 'x-runtime-session-id';

/** Legacy checkpoint-sidecar path used before runner control metadata moved to
 *  its own top-level archive member. Restore still accepts this format for
 *  rolling compatibility; new checkpoints never create or alter this path. */
export const SESSION_META_FILE = '.codeapi-session-meta.json';

/** Marker embedded in runner-owned checkpoint control metadata so restore can
 *  distinguish it from a user file that merely shares the legacy reserved name
 *  and happens to contain primed/surfaced arrays. */
/* Bump whenever the meaning of a persisted field changes. v1 stored
 * per-execution masked object handles; v2 stores the stable input-cache digest.
 * Treating a v1 id as a v2 digest would re-prime over edited session inputs. */
export const SESSION_META_MARKER = 'codeapi.session-meta.v2';

export interface SessionMetaSnapshot {
    marker?: string;
    primed: Array<[string, { id: string; readOnly: boolean; hash?: string }]>;
    surfaced: Array<[string, string]>;
}

const RUNTIME_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SessionBinding {
    runtimeSessionId: string;
}

export class SessionWorkspaceBindingError extends Error {
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'SessionWorkspaceBindingError';
    }
}

/** Shape of the `/run` runHookPayload the control plane delivers per VM. */
interface RunHookSessionPayload {
    runtime_session_id?: unknown;
    session_workspace?: unknown;
}

export function parseSessionBinding(
    runHookPayload: string | undefined,
): SessionBinding | undefined {
    if (!config.session_workspace_enabled) return undefined;
    if (runHookPayload == null || runHookPayload.length === 0) return undefined;
    let parsed: RunHookSessionPayload;
    try {
        parsed = JSON.parse(runHookPayload) as RunHookSessionPayload;
    } catch {
        logger.warn(
            'Ignoring non-JSON /run runHookPayload for session binding',
        );
        return undefined;
    }
    if (parsed.session_workspace !== true) return undefined;
    if (
        typeof parsed.runtime_session_id !== 'string' ||
        parsed.runtime_session_id.length === 0
    ) {
        logger.warn(
            'Session workspace requested without a runtime_session_id — ignoring',
        );
        return undefined;
    }
    return { runtimeSessionId: parsed.runtime_session_id };
}

/** Per-request session opt-in from the `X-Runtime-Session-Id` header. Presence
 *  of a well-formed id is the opt-in; the header is only honored on the Lambda
 *  MicroVM runner target (`session_workspace_enabled`). Header values arrive as
 *  `string | string[]` from Node — a repeated header is malformed, so reject. */
export function parseSessionBindingFromHeader(
    headerValue: string | string[] | undefined,
): SessionBinding | undefined {
    if (!config.session_workspace_enabled) return undefined;
    if (headerValue === undefined) return undefined;
    if (typeof headerValue !== 'string') {
        throw new SessionWorkspaceBindingError(
            'X-Runtime-Session-Id must appear exactly once',
        );
    }
    const runtimeSessionId = headerValue.trim();
    if (!RUNTIME_SESSION_ID_PATTERN.test(runtimeSessionId)) {
        throw new SessionWorkspaceBindingError(
            'X-Runtime-Session-Id is malformed',
        );
    }
    return { runtimeSessionId };
}

export class SessionWorkspace {
    readonly runtimeSessionId: string;
    private lease: SandboxWorkspaceLease | undefined;
    private identity: SandboxJobIdentity | undefined;
    /** relPath -> signature of every file already surfaced to the client, so a
     *  later job re-scanning the persistent workspace does not re-upload
     *  unchanged prior outputs (output diffing). */
    private readonly surfaced = new Map<string, string>();
    /** relPath -> {id, readOnly, hash} already primed onto disk, so an unchanged
     *  input delivered again is not re-downloaded (priming dedup). `readOnly`
     *  inputs are never reused (a sandbox can unlink+replace a 0444 file via the
     *  writable parent dir), so they re-download to restore pristine content +
     *  protection. `hash` is the ORIGINAL upload hash, kept as the modification
     *  baseline on reuse so a writable input mutated by a prior turn is reported
     *  as modified-from-original rather than re-hashed as if it were pristine. */
    private readonly primed = new Map<
        string,
        { id: string; readOnly: boolean; hash?: string }
    >();
    /** A failed multi-file prime may have committed only part of the request.
     * Keep the runner fail-closed until the control plane recycles it and restores
     * the last committed checkpoint. This is intentionally in-memory only: a
     * dirty workspace must never be checkpointed as a new recovery point. */
    private dirty: string | undefined;

    constructor(binding: SessionBinding) {
        this.runtimeSessionId = binding.runtimeSessionId;
    }

    /** Acquires (once) the pinned UID + persistent dir, reused every job. */
    async acquire(): Promise<SandboxWorkspaceLease> {
        if (!this.identity) {
            const identity = sandboxJobUidPool.acquire();
            if (!identity) {
                throw new Error(
                    'No sandbox UID slot available for session workspace',
                );
            }
            this.identity = identity;
        }
        this.lease = await ensureSessionWorkspace(this.identity);
        return this.lease;
    }

    /** The pinned UID/GID for this session, so a restored checkpoint's files
     *  can be chowned to the owner the sandbox jobs run as. Ensures the
     *  workspace/identity exist first. */
    async ownership(): Promise<{ dir: string; uid: number; gid: number }> {
        const lease = await this.acquire();
        return {
            dir: lease.dir,
            uid: lease.identity.uid,
            gid: lease.identity.gid,
        };
    }

    isSurfaced(relPath: string, hash: string): boolean {
        return this.surfaced.get(relPath) === hash;
    }

    markSurfaced(relPath: string, hash: string): void {
        this.surfaced.set(relPath, hash);
    }

    forget(relPath: string): void {
        this.surfaced.delete(relPath);
    }

    /** The primed storage id for `relPath`, or undefined. `readOnly` primes are
     *  reported as not-primed so the caller always re-downloads them. */
    primedInputId(relPath: string): string | undefined {
        const entry = this.primed.get(relPath);
        if (!entry || entry.readOnly) return undefined;
        return entry.id;
    }

    /** Whether `relPath` was primed as an input on any earlier turn (regardless
     *  of read-only). Such a file persists in the workspace, so a later turn that
     *  doesn't re-send it must not mistake it for a newly generated output. */
    isPrimedInput(relPath: string): boolean {
        return this.primed.has(relPath);
    }

    /** Whether the primed input at `relPath` is read-only — its sandboxed-code
     *  modifications are dropped by contract and never surfaced as outputs. */
    isPrimedReadOnly(relPath: string): boolean {
        return this.primed.get(relPath)?.readOnly === true;
    }

    markPrimed(
        relPath: string,
        storageFileId: string,
        readOnly = false,
        hash?: string,
    ): void {
        /* A successful prime replaces whatever previously occupied this path.
         * Any surfaced signature therefore belongs to an older output lineage:
         * retaining it could suppress a later modification of the new input when
         * its bytes happen to match that prior output. */
        this.forget(relPath);
        this.primed.set(relPath, { id: storageFileId, readOnly, hash });
    }

    markDirty(reason: string): void {
        this.dirty = reason;
        logger.error(
            { runtimeSessionId: this.runtimeSessionId, reason },
            'Session workspace marked dirty',
        );
    }

    get dirtyReason(): string | undefined {
        return this.dirty;
    }

    /** The original upload hash recorded when `relPath` was first primed, or
     *  undefined. Used as the modification baseline on reuse. */
    primedHash(relPath: string): string | undefined {
        return this.primed.get(relPath)?.hash;
    }

    /** Serializes the priming + output-diff state into checkpoint control
     *  metadata so a relaunched VM restores the same in-memory state. */
    snapshotMeta(): SessionMetaSnapshot {
        return {
            primed: [...this.primed.entries()],
            surfaced: [...this.surfaced.entries()],
        };
    }

    /** Rebuilds priming + output-diff state from restored checkpoint metadata.
     *  Without it a relaunched VM would re-download every input ref, overwriting a
     *  restored in-place-modified input with its original, and re-upload every
     *  restored file as a new output. */
    loadMeta(snapshot: SessionMetaSnapshot): void {
        /* REPLACE, never merge: the restored workspace is the authoritative
         * content, so entries from a prior (failed or superseded) restore that the
         * snapshot omits must not linger — a stale primed entry would suppress a
         * real file from the output scan. */
        this.primed.clear();
        this.surfaced.clear();
        this.dirty = undefined;
        for (const [relPath, entry] of snapshot.primed)
            this.primed.set(relPath, entry);
        for (const [relPath, hash] of snapshot.surfaced)
            this.surfaced.set(relPath, hash);
    }

    /** Full teardown: wipe the dir, release the pinned UID, clear diff state.
     *  Fail closed on a failed wipe: the directory was quarantined with this
     *  session's data still inside, so the pinned UID is deliberately NOT
     *  released — recycling it could let a later session reactivate the
     *  quarantined contents under a matching identity. Leaking one UID slot on
     *  a VM that is being recycled anyway is the cheaper failure. */
    async reset(): Promise<void> {
        const wiped = await resetSessionWorkspace();
        this.surfaced.clear();
        this.primed.clear();
        this.dirty = undefined;
        this.lease = undefined;
        if (!wiped) {
            logger.error(
                { runtimeSessionId: this.runtimeSessionId },
                'Session workspace wipe failed; retaining pinned UID for the quarantined directory',
            );
            return;
        }
        if (this.identity) {
            sandboxJobUidPool.release(this.identity);
            this.identity = undefined;
        }
    }
}

let boundSession: SessionWorkspace | undefined;

/** Binding the same session twice is a no-op. A DIFFERENT runtime session id
 *  is rejected outright: in the MicroVM topology one runner serves exactly one
 *  session for its whole lifetime, so a second id is a control-plane bug or a
 *  forged header — and honoring it would race an async wipe of the previous
 *  session against the new session's restore over the same directory (the
 *  reset could delete the new session's files, or checkpoint one session's
 *  data under the other's identity). Fail closed; the control plane recycles
 *  the VM on the resulting 409. */
export function bindSessionWorkspace(
    binding: SessionBinding | undefined,
): SessionWorkspace | undefined {
    if (!binding) return boundSession;
    if (
        boundSession &&
        boundSession.runtimeSessionId === binding.runtimeSessionId
    ) {
        return boundSession;
    }
    if (boundSession) {
        logger.error(
            {
                bound: boundSession.runtimeSessionId,
                requested: binding.runtimeSessionId,
            },
            'Refusing to rebind runner to a different runtime session',
        );
        return undefined;
    }
    boundSession = new SessionWorkspace(binding);
    return boundSession;
}

export function getBoundSessionWorkspace(): SessionWorkspace | undefined {
    return boundSession;
}

/** Called by `/terminate` (and session reset) to release the workspace. */
export async function unbindSessionWorkspace(): Promise<void> {
    const current = boundSession;
    boundSession = undefined;
    if (current) await current.reset();
}

export function resetSessionWorkspaceStateForTests(): void {
    boundSession = undefined;
}
