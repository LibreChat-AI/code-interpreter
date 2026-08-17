import axios from 'axios';
import { nanoid } from 'nanoid';
import * as fs from 'fs';
import { createHash } from 'crypto';
import type {
    LambdaMicrovmClient,
    MicrovmAuthToken,
    MicrovmDescription,
    MicrovmIdlePolicy,
} from '../runtime-session/lambda-client';
import type {
    SandboxBackend,
    SandboxExecuteContext,
    SandboxRawResponse,
    SandboxTransportRequest,
} from './types';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import type { CheckpointConfig } from '../runtime-session/checkpoint';
import type { CheckpointStore } from '../runtime-session/checkpoint-store';
import {
    LambdaMicrovmApiError,
    microvmPortHeaders,
} from '../runtime-session/lambda-client';
import {
    MicrovmOpThrottledError,
    acquireOpBudget,
    poisonOpBucket,
} from '../runtime-session/throttle';
import {
    checkpointSession,
    probeInputs,
    pushInputs,
    restoreSession,
} from '../runtime-session/checkpoint';
import {
    SESSION_INPUTS_MAX_COUNT,
    SessionFilesError,
    buildInputBatch,
    sessionFileRefs,
} from '../runtime-session/files';
import {
    RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
    RUNTIME_SESSION_LOCK_TTL_MS,
    allocateRuntimeSessionGeneration,
    readRuntimeSessionRecord,
    releaseRuntimeSessionLock,
    removeRuntimeSession,
    renewRuntimeSessionLock,
    waitForRuntimeSessionLock,
    writeRuntimeSessionRecord,
} from '../runtime-session/registry';
import { startRuntimeSessionLockHeartbeat } from '../runtime-session/lock-heartbeat';
import {
    microvmLaunches,
    microvmLaunchDuration,
    microvmTerminations,
    microvmThrottleEvents,
    runtimeSessionLockContention,
} from '../metrics';
import { injectTraceHeaders, withSpan } from '../telemetry';
import { SandboxBackendError } from './types';
import { Jobs } from '../enum';
import { checkpointPipelineBudgetMs } from '../config';
import logger from '../logger';

/** Header that opts a proxied /execute into the runner's persistent session
 *  workspace (see api/src/session-workspace.ts). Session mode is delivered
 *  per-request, not via a /run lifecycle hook — Lambda's build hooks require
 *  the snapshot-compatible base container image to route, and enabling any
 *  runtime hook forces the /ready build hook (which never reaches a stock
 *  container's listener), so hookless + per-request keeps image builds sound. */
const RUNTIME_SESSION_ID_HEADER = 'X-Runtime-Session-Id';

export interface LambdaMicrovmBackendConfig {
    imageArn: string;
    imageVersion?: string;
    executionRoleArn?: string;
    logGroup?: string;
    ingressConnectorArns?: string[];
    egressConnectorArns?: string[];
    port: number;
    maxDurationSeconds: number;
    authTokenTtlSeconds: number;
    launchTimeoutMs: number;
    healthTimeoutMs: number;
    launchTps: number;
    tokenTps: number;
    jobTimeoutMs: number;
    /* Session-mode (find-or-launch) tuning. */
    idleSeconds: number;
    suspendedSeconds: number;
    lockWaitMs: number;
    /* Auto-checkpoint. When disabled, session VMs still reuse a warm workspace
     * but expiry recovery falls back to file refs (no cross-VM restore). */
    checkpointsEnabled: boolean;
    checkpoint: CheckpointConfig;
}

/** Order-independent fingerprint of every immutable launch/security input. */
export function runtimeSessionLaunchFingerprint(
    config: LambdaMicrovmBackendConfig,
): string {
    const ingress = [...(config.ingressConnectorArns ?? [])].sort();
    const egress = [...(config.egressConnectorArns ?? [])].sort();
    return JSON.stringify({
        imageArn: config.imageArn,
        imageVersion: config.imageVersion,
        executionRoleArn: config.executionRoleArn ?? '',
        logGroup: config.logGroup ?? '',
        ingress,
        egress,
        port: config.port,
        maximumDurationSeconds: config.maxDurationSeconds,
        idlePolicy: {
            maxIdleSeconds: config.idleSeconds,
            suspendedSeconds: config.suspendedSeconds,
            autoResume: true,
        },
    });
}

/** Generations below this boundary were allocated by the original INCR-only
 * scheme. New launches start in a fingerprint-seeded namespace so losing the
 * Redis counter cannot reuse an AWS clientToken after launch inputs change.
 *
 * Keep the provider token itself in the legacy `sess-<id>-<generation>` shape:
 * an older worker taking over a PENDING record during a rolling deployment
 * will derive exactly the same token instead of double-launching a VM. */
export const RUNTIME_SESSION_NAMESPACED_GENERATION_MIN = 1_000_000_000_000_000;

function runtimeSessionLaunchRequestFingerprint(
    config: LambdaMicrovmBackendConfig,
): string {
    return JSON.stringify({
        launchFingerprint: runtimeSessionLaunchFingerprint(config),
        runMicrovm: {
            imageIdentifier: config.imageArn,
            imageVersion: config.imageVersion,
            executionRoleArn: config.executionRoleArn,
            logGroup: config.logGroup,
            ingressConnectorArns: config.ingressConnectorArns,
            egressConnectorArns: config.egressConnectorArns,
            maximumDurationSeconds: config.maxDurationSeconds,
            idlePolicy: {
                maxIdleSeconds: config.idleSeconds,
                suspendedSeconds: config.suspendedSeconds,
                autoResume: true,
            },
        },
    });
}

/** A 52-bit digest leaves ample safe-integer headroom for later INCRs while
 * making a reset counter's first generation depend on the exact launch
 * request. Token collisions are scoped to one runtime session. */
export function runtimeSessionLaunchGenerationSeed(
    config: LambdaMicrovmBackendConfig,
): number {
    const offset = Number.parseInt(
        createHash('sha256')
            .update(runtimeSessionLaunchRequestFingerprint(config), 'utf8')
            .digest('hex')
            .slice(0, 13),
        16,
    );
    return RUNTIME_SESSION_NAMESPACED_GENERATION_MIN + offset;
}

export function runtimeSessionLaunchClientToken(
    runtimeSessionId: string,
    generation: number,
): string {
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(
            'Runtime session generation must be a positive safe integer',
        );
    }
    const token = `sess-${runtimeSessionId}-${generation}`;
    /* launch() can add "-r1" after a clean boot-time death. Reserve those three
     * characters up front so both attempts stay within AWS's 128-byte limit. */
    if (token.length > 125) {
        throw new Error(
            'Runtime session launch clientToken exceeds the AWS length limit',
        );
    }
    return token;
}

interface LambdaMicrovmBackendDeps {
    clientFactory: () => Promise<LambdaMicrovmClient>;
    config: LambdaMicrovmBackendConfig;
    pollIntervalMs?: number;
    /** Injected in session+checkpoint mode; undefined disables checkpoints. */
    checkpointStore?: CheckpointStore;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Operation aborted'),
            );
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(
                signal?.reason instanceof Error
                    ? signal.reason
                    : new Error('Operation aborted'),
            );
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/** AWS returns the endpoint as a bare host; docs samples do `https://${endpoint}`. */
export function normalizeMicrovmEndpoint(endpoint: string): string {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
        return endpoint.replace(/\/+$/, '');
    }
    return `https://${endpoint.replace(/\/+$/, '')}`;
}

interface LaunchOptions {
    clientToken: string;
    idlePolicy?: MicrovmIdlePolicy;
    maxDurationSeconds: number;
}

interface LaunchBudget {
    /** One absolute budget shared by throttling, both boot attempts, and polling. */
    deadlineAtMs: number;
    /** Excludes caller cancellation so ambiguous-launch reconciliation can clean up. */
    deadlineSignal: AbortSignal;
    /** Cancels forward launch work on either caller cancellation or budget expiry. */
    signal: AbortSignal;
}

/**
 * Lambda MicroVM backend. Two modes, chosen by the runtime session context:
 *
 * - **stateless** (no runtime session): one VM per execution — run, execute,
 *   terminate. Correct and simple; the default.
 * - **session** (affinity/strict): find-or-launch one warm VM per
 *   `runtime_session_id` via the registry, stamp that id on every proxied
 *   /execute (the header that activates the runner's persistent workspace),
 *   and reuse the VM across calls.
 *   AWS `idlePolicy` auto-suspends the VM when idle and auto-resumes it on the
 *   next request, so there is no explicit resume in the execute path.
 */
export class LambdaMicrovmSandboxBackend implements SandboxBackend {
    readonly name = 'lambda-microvm' as const;
    private clientPromise: Promise<LambdaMicrovmClient> | undefined;
    private readonly config: LambdaMicrovmBackendConfig;
    private readonly clientFactory: () => Promise<LambdaMicrovmClient>;
    private readonly pollIntervalMs: number;
    private readonly checkpointStore: CheckpointStore | undefined;

    constructor(deps: LambdaMicrovmBackendDeps) {
        this.clientFactory = deps.clientFactory;
        this.config = deps.config;
        this.pollIntervalMs = deps.pollIntervalMs ?? 500;
        this.checkpointStore = deps.checkpointStore;
    }

    private checkpointsActive(): boolean {
        return (
            this.config.checkpointsEnabled && this.checkpointStore !== undefined
        );
    }

    private client(): Promise<LambdaMicrovmClient> {
        this.clientPromise ??= this.clientFactory();
        return this.clientPromise;
    }

    async execute(
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
    ): Promise<SandboxRawResponse> {
        /* Production supplies the worker-owned deadline, captured before egress
         * grant and request setup. Keep a backend-entry fallback for direct/test
         * callers that do not own a worker timer. Capture it before lazy client
         * initialization so that setup is counted too. */
        const deadlineAtMs =
            ctx.deadlineAtMs ?? Date.now() + this.config.jobTimeoutMs;
        const client = await this.client();
        if (ctx.runtimeSessionId && ctx.runtimeSessionMode !== 'stateless') {
            return this.executeSession(
                client,
                req,
                ctx,
                ctx.runtimeSessionId,
                deadlineAtMs,
            );
        }
        return this.executeStateless(client, req, ctx);
    }

    private async executeStateless(
        client: LambdaMicrovmClient,
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
    ): Promise<SandboxRawResponse> {
        /* One-shots self-cap their lifetime near the job timeout so a crashed
         * worker cannot leak an 8h VM. */
        const maxDurationSeconds = Math.min(
            this.config.maxDurationSeconds,
            Math.ceil(this.config.jobTimeoutMs / 1_000) + 120,
        );
        const vm = await this.launch(client, ctx, {
            clientToken:
                ctx.executionId !== ''
                    ? `exec-${ctx.executionId}`
                    : `exec-${nanoid()}`,
            maxDurationSeconds,
        });
        let terminateReason = 'stateless';
        try {
            await this.waitForRunnerReady(
                client,
                vm.microvmId,
                normalizeMicrovmEndpoint(vm.endpoint ?? ''),
                ctx,
            );
            /* Stateless one-shots take by-reference inputs too, and their guest is
             * just as unable to pull them. Same cache, same priming path. */
            await this.deliverInputs(client, vm, req, ctx);
            return await this.proxyExecute(
                client,
                vm,
                req,
                ctx,
                undefined,
                true,
            );
        } catch (error) {
            terminateReason = ctx.signal.aborted ? 'timeout' : 'error';
            throw error;
        } finally {
            await this.terminate(client, vm.microvmId, terminateReason);
        }
    }

    private async executeSession(
        client: LambdaMicrovmClient,
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
        runtimeSessionId: string,
        deadlineAtMs: number,
    ): Promise<SandboxRawResponse> {
        const lockToken = await waitForRuntimeSessionLock(runtimeSessionId, {
            waitMs: this.config.lockWaitMs,
            signal: ctx.signal,
        });
        if (!lockToken) {
            runtimeSessionLockContention.inc({ mode: ctx.runtimeSessionMode });
            /* A session-bound request depends on that session's workspace — files,
             * installed packages, database state built by earlier turns. Running it
             * on a cold one-shot would silently answer from an environment the
             * caller never asked for, so contention is a retryable BUSY in every
             * session mode. (A lossy fallback, if ever wanted, belongs behind its
             * own explicit mode rather than as a silent default.) */
            throw new SandboxBackendError(
                'RUNTIME_SESSION_BUSY',
                `Runtime session ${runtimeSessionId} is busy`,
            );
        }

        const fence = new AbortController();
        const sessionCtx: SandboxExecuteContext = {
            ...ctx,
            signal: AbortSignal.any([ctx.signal, fence.signal]),
        };
        const heartbeat = startRuntimeSessionLockHeartbeat({
            renew: () =>
                renewRuntimeSessionLock(
                    runtimeSessionId,
                    lockToken,
                    undefined,
                    {
                        signal: sessionCtx.signal,
                        onLateLost: () =>
                            fence.abort(
                                new SandboxBackendError(
                                    'MICROVM_FENCED',
                                    `Lost session lock for ${runtimeSessionId}`,
                                ),
                            ),
                    },
                ),
            fence,
            ttlMs: RUNTIME_SESSION_LOCK_TTL_MS,
        });
        let sessionVm: MicrovmDescription | undefined;

        try {
            const existing = await readRuntimeSessionRecord(runtimeSessionId, {
                signal: sessionCtx.signal,
            });
            const { vm } = await this.findOrLaunchSession(
                client,
                sessionCtx,
                runtimeSessionId,
                existing,
                lockToken,
            );
            sessionVm = vm;
            await this.deliverInputs(client, vm, req, sessionCtx, async () => {
                /* A session VM whose delivery transport failed is not trustworthy for
                 * reuse: recycle so the next call relaunches and restores. */
                const terminated = await this.terminate(
                    client,
                    vm.microvmId,
                    'error',
                );
                if (terminated) {
                    await removeRuntimeSession(runtimeSessionId, lockToken, {
                        timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
                    }).catch(() => {});
                }
            });
            const result = await this.executeOnSessionVm(
                client,
                vm,
                req,
                sessionCtx,
                runtimeSessionId,
                lockToken,
                fence.signal,
            );
            let finalizedResult: SandboxRawResponse;
            try {
                /* Gateway result restoration is part of the session transaction: do
                 * not checkpoint or advertise the mutated workspace until it succeeds.
                 * If it fails, quarantine/recycle this VM so an at-least-once retry
                 * relaunches from the preceding durable checkpoint. */
                finalizedResult = sessionCtx.sessionResultFinalizer
                    ? await sessionCtx.sessionResultFinalizer(result)
                    : result;
            } catch (error) {
                await this.recycleUncommittedSessionVm(
                    client,
                    vm,
                    runtimeSessionId,
                    lockToken,
                    'result_finalization_failed',
                );
                throw error;
            }
            /* Re-read the record findOrLaunch settled on (freshly written on
             * launch, or the reused one) and only bump its liveness — preserves
             * generation, deadline, and image fields. */
            const now = Date.now();
            /* The post-run checkpoint is an optional cache write. Skip it when the job
             * budget won't fit a full checkpoint, so a run that already succeeded
             * isn't timed out at the router by the checkpoint's latency — the next
             * relaunch restores the prior checkpoint, one exec staler. */
            const remainingBudgetMs = deadlineAtMs - now;
            /* Reserve the WHOLE checkpoint path, not just one transfer timeout:
             * token-budget wait + guest GET + object-store list + object upload +
             * durable marker + all six sequential registry commands. Metadata calls
             * use their tighter cap; the two archive transfers receive the configured
             * checkpoint timeout. */
            const worstCaseCheckpointMs = checkpointPipelineBudgetMs(
                this.config.launchTimeoutMs,
                this.config.checkpoint.timeoutMs,
            );
            const canCheckpoint =
                !sessionCtx.signal.aborted &&
                remainingBudgetMs > worstCaseCheckpointMs;
            const settled = await readRuntimeSessionRecord(runtimeSessionId, {
                signal: sessionCtx.signal,
            });
            if (!settled) {
                /* Returning success here would strand the known live VM without a
                 * registry record: no later caller could reuse or clean it up. Treat
                 * disappearance as fencing so the catch path terminates this VM. */
                throw new SandboxBackendError(
                    'MICROVM_FENCED',
                    `Runtime session record disappeared for ${runtimeSessionId} after execute`,
                );
            }
            const nextRecord = canCheckpoint
                ? await this.checkpointUnderLock(
                      client,
                      settled,
                      runtimeSessionId,
                      now,
                      lockToken,
                      sessionCtx.signal,
                  )
                : { ...settled, state: 'RUNNING' as const, last_seen_at: now };
            const persisted = await writeRuntimeSessionRecord(
                nextRecord,
                lockToken,
                undefined,
                { signal: sessionCtx.signal },
            );
            if (!persisted) {
                throw new SandboxBackendError(
                    'MICROVM_FENCED',
                    `Lost session lock for ${runtimeSessionId} after execute`,
                );
            }
            return finalizedResult;
        } catch (error) {
            /* Fencing can happen after proxyExecute returns — during checkpoint,
             * the final registry read, or the final liveness write. At that point a
             * newer holder may already be using the recorded VM. Kill it so the new
             * holder fails fast and restores, rather than letting two workers touch
             * one persistent workspace concurrently. The stale lock token cannot
             * safely remove the new holder's record, so termination is the only
             * mutation here. */
            const fenced =
                fence.signal.aborted ||
                (error instanceof SandboxBackendError &&
                    error.code === 'MICROVM_FENCED');
            if (fenced && sessionVm) {
                await this.terminate(client, sessionVm.microvmId, 'fenced');
            }
            throw error;
        } finally {
            heartbeat.stop();
            await releaseRuntimeSessionLock(runtimeSessionId, lockToken);
        }
    }

    /**
     * Proxies the execute to a session VM and, on a failure that means the VM
     * must not be reused, terminates it and makes the registry record
     * non-reusable so the next call relaunches + restores rather than reusing a
     * dead-or-dirty VM:
     *  - abort (JOB_TIMEOUT): the runner keeps NsJail running until the child
     *    exits even after the socket closes, so a later request reusing this VM
     *    could mutate the workspace concurrently with the timed-out run.
     *  - VM unreachable (health/connection failure, e.g. idlePolicy auto-terminated
     *    a suspended VM): the RUNNING record would otherwise keep pointing at a
     *    dead VM until the hard deadline, and every request would reuse it.
     * A plain non-200 from a live runner (`Error from sandbox`) leaves the warm VM
     * and its record intact — the VM is healthy, only the request failed.
     */
    private async executeOnSessionVm(
        client: LambdaMicrovmClient,
        vm: MicrovmDescription,
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
        runtimeSessionId: string,
        lockToken: string,
        fenceSignal?: AbortSignal,
    ): Promise<SandboxRawResponse> {
        try {
            /* Fresh sessions passed readiness before their PENDING record became
             * RUNNING. Reused sessions intentionally let probe/execute trigger
             * auto-resume under the full job budget. */
            return await this.proxyExecute(
                client,
                vm,
                req,
                ctx,
                runtimeSessionId,
                true,
            );
        } catch (error) {
            /* Recycle the VM ONLY on positive evidence it's unreachable or dirty:
             *  - abort: the runner keeps NsJail running after the socket closes, so a
             *    reuse could mutate the workspace concurrently.
             *  - a transport-level axios failure (no `.response`): the execute couldn't
             *    reach the VM (connection refused/timeout).
             *  - a failed health check: assertHealthy wraps the connection/timeout/non-200
             *    into MICROVM_UNHEALTHY, so it isn't a top-level AxiosError.
             * Everything else keeps the warm VM: a non-2xx sandbox response (AxiosError
             * WITH `.response` — the VM is alive, only the request failed) and a
             * pre-request control-plane failure like a throttled CreateMicrovmAuthToken
             * (not an axios error at all) — the VM was never touched.
             * Exception: a proxy 5xx (502/503/504) is the AWS gateway reporting the
             * VM as unreachable — typically a suspended VM that failed to auto-resume,
             * but it can also happen after a fresh VM passed health and then died.
             * That has `.response` (so it's not a transport failure) but means the VM
             * is dead, not that the runner rejected the request; recycle it, else
             * every later call keeps reusing the dead VM until idle expiry. */
            const status = axios.isAxiosError(error)
                ? (error.response?.status ?? 0)
                : 0;
            /* Fenced: another worker owns the lock and will reuse this VM. Aborting
             * our HTTP request does NOT stop the runner's NsJail child (it runs to
             * completion after the socket closes), so leaving the VM alive would let
             * two executions mutate one persistent workspace concurrently. Terminate
             * it: the new holder's call fails fast on the dead endpoint and
             * relaunches + restores from the last checkpoint. A surfaced error and a
             * relaunch beat silent workspace corruption. The registry write is a
             * no-op under our stale token, which is fine — the reuse path already
             * recycles records pointing at dead VMs. */
            if (fenceSignal?.aborted === true) {
                throw new SandboxBackendError(
                    'MICROVM_FENCED',
                    `Lost session lock for ${runtimeSessionId} during execute`,
                    error,
                );
            }
            const transportFailure =
                axios.isAxiosError(error) && error.response == null;
            const unhealthy =
                error instanceof SandboxBackendError &&
                error.code === 'MICROVM_UNHEALTHY';
            const gatewayUnreachable = status >= 502 && status <= 504;
            const sessionConflictBody =
                axios.isAxiosError(error) && error.response?.status === 409
                    ? (error.response.data as
                          { error?: unknown; message?: unknown } | undefined)
                    : undefined;
            const sessionConflictCode = sessionConflictBody?.error;
            /* Older runner images returned this exact conflict without a stable
             * error code. Recognize only that legacy shape so service-first rolling
             * deploys self-heal without treating unrelated 409s as VM failures. */
            const legacySessionBindingConflict =
                sessionConflictCode === undefined &&
                sessionConflictBody?.message ===
                    'Runner is bound to a different runtime session';
            if (
                sessionConflictCode === 'session_workspace_dirty' ||
                sessionConflictCode === 'session_binding_conflict' ||
                legacySessionBindingConflict
            ) {
                const reason =
                    sessionConflictCode === 'session_workspace_dirty'
                        ? 'workspace_dirty'
                        : 'session_binding_conflict';
                await this.recycleUncommittedSessionVm(
                    client,
                    vm,
                    runtimeSessionId,
                    lockToken,
                    reason,
                );
                throw new SandboxBackendError(
                    'MICROVM_UNHEALTHY',
                    sessionConflictCode === 'session_workspace_dirty'
                        ? `Runtime session ${runtimeSessionId} workspace was dirty and has been recycled`
                        : `Runtime session ${runtimeSessionId} runner binding conflicted and has been recycled`,
                    error,
                );
            }
            if (
                ctx.signal.aborted ||
                transportFailure ||
                unhealthy ||
                gatewayUnreachable
            ) {
                const terminated = await this.terminate(
                    client,
                    vm.microvmId,
                    ctx.signal.aborted ? 'timeout' : 'error',
                );
                if (terminated) {
                    await removeRuntimeSession(runtimeSessionId, lockToken, {
                        timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
                    }).catch(() => {});
                }
            }
            throw error;
        }
    }

    /**
     * Makes a session VM non-reusable before attempting provider cleanup. The
     * prior checkpoint pointer remains on the terminal record, so a retry can
     * relaunch directly from the last committed workspace even if the durable
     * marker write for that older checkpoint had failed.
     */
    private async recycleUncommittedSessionVm(
        client: LambdaMicrovmClient,
        vm: MicrovmDescription,
        runtimeSessionId: string,
        lockToken: string,
        reason:
            | 'result_finalization_failed'
            | 'workspace_dirty'
            | 'session_binding_conflict',
    ): Promise<void> {
        let record: RuntimeSessionRecord | null = null;
        let ownsRecordedVm = false;
        let quarantined = false;
        try {
            record = await readRuntimeSessionRecord(runtimeSessionId, {
                timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
            });
            ownsRecordedVm = record?.microvm_id === vm.microvmId;
            if (record && ownsRecordedVm) {
                quarantined = await writeRuntimeSessionRecord(
                    { ...record, state: 'TERMINATING', last_error: reason },
                    lockToken,
                    undefined,
                    { timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS },
                );
                if (!quarantined) {
                    logger.warn(
                        'Lost session lock while quarantining a mutated MicroVM',
                        {
                            runtimeSessionId,
                            microvmId: vm.microvmId,
                            reason,
                        },
                    );
                }
            }
        } catch (error) {
            /* Redis can fail exactly when the workspace most needs quarantining.
             * Registry state is useful for making retries efficient, but provider
             * termination is the actual safety boundary: never let a failed read or
             * fenced write skip teardown of a VM whose uncommitted workspace was
             * already mutated. */
            logger.error(
                'Failed to quarantine a mutated MicroVM in the session registry',
                {
                    runtimeSessionId,
                    microvmId: vm.microvmId,
                    reason,
                    error,
                },
            );
        }

        const terminated = await this.terminate(client, vm.microvmId, reason);
        if (!terminated || !record || !ownsRecordedVm || !quarantined) return;

        try {
            const terminal = await writeRuntimeSessionRecord(
                {
                    ...record,
                    microvm_id: undefined,
                    endpoint: undefined,
                    state: 'TERMINATED',
                    last_seen_at: Date.now(),
                    last_error: reason,
                },
                lockToken,
                undefined,
                { timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS },
            );
            if (!terminal) {
                logger.warn(
                    'Lost session lock after recycling a mutated MicroVM',
                    {
                        runtimeSessionId,
                        microvmId: vm.microvmId,
                        reason,
                    },
                );
            }
        } catch (error) {
            /* The provider resource is already gone and the earlier TERMINATING
             * record remains non-reusable with its prior checkpoint pointer intact.
             * Preserve the primary execution/finalization error. */
            logger.error(
                'Failed to mark a recycled MicroVM terminal in the session registry',
                {
                    runtimeSessionId,
                    microvmId: vm.microvmId,
                    reason,
                    error,
                },
            );
        }
    }

    /** Order-independent fingerprint of every immutable launch/security input. */
    private launchFingerprint(): string {
        return runtimeSessionLaunchFingerprint(this.config);
    }

    private isValidationLaunchFailure(error: unknown): boolean {
        return (
            error instanceof SandboxBackendError &&
            error.code === 'MICROVM_LAUNCH_FAILED' &&
            error.cause instanceof LambdaMicrovmApiError &&
            error.cause.kind === 'validation'
        );
    }

    /** Both the base token and its single retry reached a terminal state and
     * were successfully terminated. Keeping that PENDING intent would replay
     * two known-dead tokens forever, so let the next request allocate a new
     * generation. Ambiguous provider failures remain persisted for recovery. */
    private async retireExhaustedLaunchIntent(
        launchIntent: RuntimeSessionRecord,
        lockToken: string,
        error: unknown,
    ): Promise<void> {
        const cleanlyExhausted =
            error instanceof SandboxBackendError &&
            error.code === 'MICROVM_LAUNCH_FAILED' &&
            error.transient;
        if (!cleanlyExhausted) return;
        try {
            const retired = await writeRuntimeSessionRecord(
                {
                    ...launchIntent,
                    microvm_id: undefined,
                    endpoint: undefined,
                    state: 'TERMINATED',
                    last_seen_at: Date.now(),
                    last_error: error.message,
                },
                lockToken,
                undefined,
                {
                    timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
                },
            );
            if (!retired) {
                logger.warn(
                    'Lost session lock while retiring an exhausted launch intent',
                    {
                        runtimeSessionId: launchIntent.runtime_session_id,
                    },
                );
            }
        } catch (cleanupError) {
            logger.warn('Failed to retire an exhausted launch intent', {
                runtimeSessionId: launchIntent.runtime_session_id,
                error: cleanupError,
            });
        }
    }

    private async findOrLaunchSession(
        client: LambdaMicrovmClient,
        ctx: SandboxExecuteContext,
        runtimeSessionId: string,
        record: RuntimeSessionRecord | null,
        lockToken: string,
    ): Promise<{ vm: MicrovmDescription; restored: boolean }> {
        if (!this.config.imageVersion) {
            throw new SandboxBackendError(
                'MICROVM_LAUNCH_FAILED',
                'Stateful runtime sessions require a pinned LAMBDA_MICROVM_IMAGE_VERSION',
            );
        }
        const deadlineHeadroomMs = this.config.jobTimeoutMs + 30_000;
        /* A record whose image/version/port no longer match the current config was
         * launched by an older deploy — relaunch on the current config rather than
         * reuse it (a changed port would otherwise health-check the wrong port and
         * fail as UNHEALTHY instead of cleanly relaunching). */
        const launchFingerprint = this.launchFingerprint();
        const launchRequestFingerprint = runtimeSessionLaunchRequestFingerprint(
            this.config,
        );
        const configMatches =
            record &&
            record.image_arn === this.config.imageArn &&
            record.image_version === this.config.imageVersion &&
            record.port === this.config.port &&
            record.launch_fingerprint === launchFingerprint;
        const pendingRequestMatches =
            record?.launch_request_fingerprint == null ||
            record.launch_request_fingerprint === launchRequestFingerprint;
        /* Past idle+suspended, AWS auto-terminates the suspended VM while the record
         * still reads RUNNING until the 8h hard deadline. Treat that as non-reusable
         * so the first request after idle expiry relaunches + restores, instead of
         * reusing a dead endpoint, failing the health check, and returning 503. */
        const idleTerminationMs =
            (this.config.idleSeconds + this.config.suspendedSeconds) * 1_000;
        const likelyIdleTerminated =
            record != null &&
            Date.now() - record.last_seen_at > idleTerminationMs;
        const reusable =
            record &&
            record.state === 'RUNNING' &&
            record.microvm_id &&
            record.endpoint &&
            configMatches &&
            !likelyIdleTerminated &&
            (record.hard_deadline_at == null ||
                record.hard_deadline_at - Date.now() > deadlineHeadroomMs);
        if (reusable && record) {
            /* Reuse the warm VM. If AWS auto-suspended it, the proxy request
             * transparently auto-resumes it (idlePolicy.autoResume). */
            return {
                vm: {
                    microvmId: record.microvm_id as string,
                    state: 'RUNNING',
                    endpoint: record.endpoint,
                },
                restored: false,
            };
        }

        /* We're relaunching. Always terminate a recorded VM before replacing it.
         * `last_seen_at` is only advanced after a successful execute; a failed
         * delivery/proxy request can nevertheless auto-resume and touch the VM.
         * Therefore "past idle+suspended" is enough to reject reuse, but NOT proof
         * AWS already killed it. Skipping termination on that assumption leaks a
         * live resumed VM after the record is overwritten. Provider not-found is
         * already treated as successful cleanup, so the safe path is unconditional. */
        if (record?.microvm_id) {
            const terminated = await this.terminate(
                client,
                record.microvm_id,
                'superseded',
            );
            if (!terminated) {
                throw new SandboxBackendError(
                    'MICROVM_UNHEALTHY',
                    `Could not terminate non-reusable MicroVM ${record.microvm_id}`,
                );
            }
        }

        /* RunMicrovm is idempotent by clientToken, but a worker can die after AWS
         * accepts the call and before its response (and MicroVM id) reaches us.
         * Persist the complete launch intent first. A successor on the same config
         * replays that generation/token and recovers the already-running VM instead
         * of allocating a new generation and leaving the first VM billable. */
        const canReplayPendingLaunch = Boolean(
            record &&
            record.state === 'PENDING' &&
            !record.microvm_id &&
            configMatches &&
            pendingRequestMatches &&
            Number.isSafeInteger(record.generation) &&
            record.generation > 0 &&
            record.launched_at != null &&
            record.hard_deadline_at != null &&
            record.hard_deadline_at - Date.now() > deadlineHeadroomMs,
        );
        const generation =
            canReplayPendingLaunch && record
                ? record.generation
                : await allocateRuntimeSessionGeneration(
                      runtimeSessionId,
                      runtimeSessionLaunchGenerationSeed(this.config),
                      { signal: ctx.signal },
                  );
        const launchedAt =
            canReplayPendingLaunch && record?.launched_at != null
                ? record.launched_at
                : Date.now();
        const hardDeadlineAt =
            canReplayPendingLaunch && record?.hard_deadline_at != null
                ? record.hard_deadline_at
                : launchedAt + this.config.maxDurationSeconds * 1_000 - 60_000;
        const launchClientToken =
            canReplayPendingLaunch && record
                ? (record.launch_client_token ??
                  runtimeSessionLaunchClientToken(runtimeSessionId, generation))
                : runtimeSessionLaunchClientToken(runtimeSessionId, generation);
        let launchIntent: RuntimeSessionRecord = {
            runtime_session_id: runtimeSessionId,
            tenant_id: ctx.tenantId ?? '',
            canonical_user_id: ctx.canonicalUserId ?? '',
            port: this.config.port,
            image_arn: this.config.imageArn,
            image_version: this.config.imageVersion,
            launch_fingerprint: launchFingerprint,
            /* Preserve absence on a compatibility replay. A crash or ambiguous
             * failure must not make a legacy/high-generation record look fully
             * migrated before AWS accepts it. Successful launch fills both fields. */
            launch_client_token: canReplayPendingLaunch
                ? record?.launch_client_token
                : launchClientToken,
            launch_request_fingerprint: canReplayPendingLaunch
                ? record?.launch_request_fingerprint
                : launchRequestFingerprint,
            state: 'PENDING',
            generation,
            launched_at: launchedAt,
            last_seen_at: Date.now(),
            hard_deadline_at: hardDeadlineAt,
            workspace_checkpoint: record?.workspace_checkpoint,
            checkpointed_at: record?.checkpointed_at,
        };
        const pendingOk = await writeRuntimeSessionRecord(
            launchIntent,
            lockToken,
            undefined,
            { signal: ctx.signal },
        );
        if (!pendingOk) {
            throw new SandboxBackendError(
                'MICROVM_FENCED',
                `Lost session lock for ${runtimeSessionId} before launch`,
            );
        }

        const launchWithToken = (
            clientToken: string,
        ): Promise<MicrovmDescription> =>
            this.launch(client, ctx, {
                clientToken,
                idlePolicy: {
                    maxIdleSeconds: this.config.idleSeconds,
                    suspendedSeconds: this.config.suspendedSeconds,
                    autoResume: true,
                },
                maxDurationSeconds: this.config.maxDurationSeconds,
            });

        let vm: MicrovmDescription;
        try {
            vm = await launchWithToken(launchClientToken);
        } catch (error) {
            /* A pre-upgrade PENDING record may carry a token that AWS already
             * accepted (lost response), so replay it first. AWS exposes an
             * idempotency mismatch as generic ValidationException with no structured
             * discriminator. For an incomplete compatibility record only, treat the
             * first validation as a possible collision: atomically promote the Redis
             * counter, persist the replacement intent, and try once with the
             * fingerprint-seeded generation. Genuine invalid configuration fails
             * again, and the completed replacement record cannot rotate repeatedly. */
            const compatibilityPending =
                canReplayPendingLaunch &&
                record != null &&
                (record.generation <
                    RUNTIME_SESSION_NAMESPACED_GENERATION_MIN ||
                    record.launch_client_token == null ||
                    record.launch_request_fingerprint == null);
            if (compatibilityPending && this.isValidationLaunchFailure(error)) {
                const migratedGeneration =
                    await allocateRuntimeSessionGeneration(
                        runtimeSessionId,
                        runtimeSessionLaunchGenerationSeed(this.config),
                        { signal: ctx.signal },
                    );
                const migratedClientToken = runtimeSessionLaunchClientToken(
                    runtimeSessionId,
                    migratedGeneration,
                );
                launchIntent = {
                    ...launchIntent,
                    generation: migratedGeneration,
                    launch_client_token: migratedClientToken,
                    launch_request_fingerprint: launchRequestFingerprint,
                    last_seen_at: Date.now(),
                };
                const migratedPendingOk = await writeRuntimeSessionRecord(
                    launchIntent,
                    lockToken,
                    undefined,
                    { signal: ctx.signal },
                );
                if (!migratedPendingOk) {
                    throw new SandboxBackendError(
                        'MICROVM_FENCED',
                        `Lost session lock for ${runtimeSessionId} while migrating its launch intent`,
                    );
                }
                try {
                    vm = await launchWithToken(migratedClientToken);
                } catch (migratedError) {
                    await this.retireExhaustedLaunchIntent(
                        launchIntent,
                        lockToken,
                        migratedError,
                    );
                    throw migratedError;
                }
            } else {
                await this.retireExhaustedLaunchIntent(
                    launchIntent,
                    lockToken,
                    error,
                );
                throw error;
            }
        }

        const launchedRecord: RuntimeSessionRecord = {
            ...launchIntent,
            launch_client_token:
                launchIntent.launch_client_token ?? launchClientToken,
            launch_request_fingerprint:
                launchIntent.launch_request_fingerprint ??
                launchRequestFingerprint,
            microvm_id: vm.microvmId,
            endpoint: vm.endpoint,
            image_arn: vm.imageArn ?? this.config.imageArn,
            image_version: vm.imageVersion ?? this.config.imageVersion,
            last_seen_at: Date.now(),
        };

        let restored = false;
        try {
            /* Publish the launched VM as PENDING before readiness/restore. A worker
             * crash leaves enough information for the successor to terminate it,
             * while never advertising a partial workspace as reusable. */
            const tracked = await writeRuntimeSessionRecord(
                launchedRecord,
                lockToken,
                undefined,
                { signal: ctx.signal },
            );
            if (!tracked) {
                throw new SandboxBackendError(
                    'MICROVM_FENCED',
                    `Lost session lock for ${runtimeSessionId} after launch`,
                );
            }

            const endpointBase = normalizeMicrovmEndpoint(vm.endpoint ?? '');
            await this.waitForRunnerReady(
                client,
                vm.microvmId,
                endpointBase,
                ctx,
            );

            /* Fresh VM: restore the predecessor's workspace before the first execute
             * so an 8h rollover / eviction is invisible. Attempt even after Redis
             * record loss because the object-store key is deterministic. */
            if (this.checkpointStore && this.checkpointsActive()) {
                const restoreResult = await restoreSession({
                    mintToken: microvmId =>
                        this.mintAuthToken(client, microvmId, ctx.signal),
                    store: this.checkpointStore,
                    runtimeSessionId,
                    microvmId: vm.microvmId,
                    endpointBase,
                    config: this.config.checkpoint,
                    signal: ctx.signal,
                    checkpointKey: record?.workspace_checkpoint,
                });
                if (
                    restoreResult === 'push_failed' ||
                    restoreResult === 'fetch_failed'
                ) {
                    throw new SandboxBackendError(
                        'MICROVM_UNHEALTHY',
                        restoreResult === 'push_failed'
                            ? 'Checkpoint restore left the workspace in an unknown state'
                            : 'Checkpoint fetch failed; refusing to run against an empty workspace',
                    );
                }
                restored = restoreResult === 'restored';
            }

            const runningOk = await writeRuntimeSessionRecord(
                {
                    ...launchedRecord,
                    state: 'RUNNING',
                    last_seen_at: Date.now(),
                },
                lockToken,
                undefined,
                { signal: ctx.signal },
            );
            if (!runningOk) {
                throw new SandboxBackendError(
                    'MICROVM_FENCED',
                    `Lost session lock for ${runtimeSessionId} after restore`,
                );
            }
            return { vm, restored };
        } catch (error) {
            const terminated = await this.terminate(
                client,
                vm.microvmId,
                'error',
            );
            if (terminated) {
                await removeRuntimeSession(runtimeSessionId, lockToken, {
                    timeoutMs: RUNTIME_SESSION_REDIS_CLEANUP_TIMEOUT_MS,
                }).catch(() => {});
            }
            throw error;
        }
    }

    /** Polls the runner's health endpoint until it responds, bounded by the
     *  launch timeout — a freshly-RUNNING VM's app may still be booting. */
    private async waitForRunnerReady(
        client: LambdaMicrovmClient,
        microvmId: string,
        base: string,
        ctx: SandboxExecuteContext,
    ): Promise<void> {
        const deadline = Date.now() + this.config.launchTimeoutMs;
        const refreshSkewMs = this.config.healthTimeoutMs + this.pollIntervalMs;
        let token: MicrovmAuthToken | undefined;
        let lastError: unknown;
        while (Date.now() < deadline) {
            ctx.signal.throwIfAborted();
            /* Readiness can legitimately outlive one proxy token under a custom
             * launch timeout. Refresh just before expiry instead of repeatedly
             * probing with a credential AWS will reject. A newly minted token is
             * still used once even when a test/fake gives it an unusually short
             * lifetime, avoiding a mint-only loop. */
            if (
                token === undefined ||
                token.expiresAtMs <= Date.now() + refreshSkewMs
            ) {
                token = await this.mintAuthToken(client, microvmId, ctx.signal);
            }
            try {
                await this.assertHealthy(base, token.token, ctx);
                return;
            } catch (error) {
                ctx.signal.throwIfAborted();
                lastError = error;
                if (Date.now() + this.pollIntervalMs >= deadline) break;
                await sleep(this.pollIntervalMs, ctx.signal);
            }
        }
        throw lastError instanceof SandboxBackendError
            ? lastError
            : new SandboxBackendError(
                  'MICROVM_UNHEALTHY',
                  'Runner did not become ready before restore',
                  lastError,
              );
    }

    /**
     * Pulls a checkpoint from the still-warm VM while the exec lock is held and
     * stores it, returning the record to persist (with the checkpoint pointer)
     * or the liveness-only update if checkpoints are off/failed. Never throws —
     * a missed post-exec checkpoint does not rewrite the prior durable pointer.
     * The current warm VM remains authoritative until the next successful
     * checkpoint; a later replacement restores the last committed snapshot.
     */
    private async checkpointUnderLock(
        client: LambdaMicrovmClient,
        record: RuntimeSessionRecord,
        runtimeSessionId: string,
        now: number,
        lockToken: string,
        signal?: AbortSignal,
    ): Promise<RuntimeSessionRecord> {
        const base: RuntimeSessionRecord = {
            ...record,
            state: 'RUNNING',
            last_seen_at: now,
        };
        if (
            !this.checkpointStore ||
            !this.checkpointsActive() ||
            !record.microvm_id ||
            !record.endpoint
        ) {
            return base;
        }
        const result = await checkpointSession({
            mintToken: microvmId =>
                this.mintAuthToken(client, microvmId, signal),
            store: this.checkpointStore,
            runtimeSessionId,
            config: this.config.checkpoint,
            normalizeEndpoint: normalizeMicrovmEndpoint,
            lockToken,
            signal,
        });
        /* checkpointSession wrote the pointer under our lock on success; re-read so
         * we keep it, but re-apply `last_seen_at: now` — that record was built from
         * the pre-execute snapshot, so without this the liveness timestamp never
         * advances on checkpointed executes and an actively-used session would look
         * idle and relaunch needlessly. */
        if (result === 'stored') {
            const persisted = await readRuntimeSessionRecord(runtimeSessionId, {
                signal,
            });
            return persisted ? { ...persisted, last_seen_at: now } : base;
        }
        return base;
    }

    /** Mints a proxy auth token under the shared per-second token budget, so
     *  concurrent warm-session executes queue instead of bursting past AWS's
     *  CreateMicrovmAuthToken TPS limit (mirrors launch's `run` budget). Maps
     *  control-plane failures to SandboxBackendError so they never escape raw:
     *  `throttled` poisons the bucket for backoff, and `not_found` (the VM was
     *  evicted/terminated) surfaces as MICROVM_UNHEALTHY so the caller tears down
     *  the stale record and relaunches instead of retrying a dead VM. */
    private async mintAuthToken(
        client: LambdaMicrovmClient,
        microvmId: string,
        signal?: AbortSignal,
    ): Promise<MicrovmAuthToken> {
        /* Throttle admission and the SDK request share one absolute control-plane
         * budget. Starting a fresh SDK window after a long throttle wait would make
         * the post-exec checkpoint reserve underestimate this stage. */
        const tokenDeadlineSignal = AbortSignal.timeout(
            this.config.launchTimeoutMs,
        );
        const tokenSignal = signal
            ? AbortSignal.any([signal, tokenDeadlineSignal])
            : tokenDeadlineSignal;
        const tokenBudgetDeadlineAtMs =
            Date.now() + this.config.launchTimeoutMs;
        try {
            await acquireOpBudget('token', {
                limitPerSecond: this.config.tokenTps,
                budgetMs: this.config.launchTimeoutMs,
                deadlineAtMs: tokenBudgetDeadlineAtMs,
                signal: tokenSignal,
            });
        } catch (error) {
            if (
                error instanceof MicrovmOpThrottledError ||
                (tokenDeadlineSignal.aborted && !signal?.aborted)
            ) {
                const throttleError =
                    error instanceof MicrovmOpThrottledError
                        ? error
                        : new MicrovmOpThrottledError(
                              'token',
                              this.config.launchTimeoutMs,
                          );
                microvmThrottleEvents.inc({ op: 'token' });
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_THROTTLED',
                    throttleError.message,
                    throttleError,
                );
            }
            throw error;
        }
        try {
            return await client.createMicrovmAuthToken(
                {
                    microvmId,
                    port: this.config.port,
                    ttlSeconds: this.config.authTokenTtlSeconds,
                },
                tokenSignal,
            );
        } catch (error) {
            if (
                error instanceof LambdaMicrovmApiError &&
                error.kind === 'throttled'
            ) {
                await poisonOpBucket('token', undefined, {
                    deadlineAtMs: tokenBudgetDeadlineAtMs,
                    signal: tokenSignal,
                });
                microvmThrottleEvents.inc({ op: 'token' });
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_THROTTLED',
                    error.message,
                    error,
                );
            }
            if (
                error instanceof LambdaMicrovmApiError &&
                error.kind === 'not_found'
            ) {
                throw new SandboxBackendError(
                    'MICROVM_UNHEALTHY',
                    error.message,
                    error,
                );
            }
            if (error instanceof LambdaMicrovmApiError) {
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_FAILED',
                    error.message,
                    error,
                );
            }
            throw error;
        }
    }

    /**
     * Ensures the VM holds every by-reference input this request declares,
     * BEFORE the execute. The guest cannot reach the file server, so the control
     * plane fetches the bytes and pushes them into the runner's input cache; the
     * runner's normal priming then resolves refs from that cache.
     *
     * Dedupe is a probe, not bookkeeping: the VM reports what it is missing, so
     * a lost session record (recycle, failover, flush) can never cause a needed
     * input to be skipped — and a re-push can never revert a sandbox edit,
     * because this path does not write the workspace at all.
     *
     * Applies to session AND stateless executions alike: the cache is keyed by
     * (storage session, object), not by session.
     */
    private async deliverInputs(
        client: LambdaMicrovmClient,
        vm: MicrovmDescription,
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
        onUnhealthy?: () => Promise<void>,
    ): Promise<void> {
        const refs = req.inputDelivery ?? sessionFileRefs(req.body.files);
        if (refs.length === 0) return;
        if (refs.length > SESSION_INPUTS_MAX_COUNT) {
            throw new SessionFilesError(
                'SESSION_INPUT_TOO_LARGE',
                `Session delivery of ${refs.length} objects exceeds the ${SESSION_INPUTS_MAX_COUNT} limit`,
            );
        }
        const endpointBase = normalizeMicrovmEndpoint(vm.endpoint ?? '');
        const mintToken = (): Promise<MicrovmAuthToken> =>
            this.mintAuthToken(client, vm.microvmId, ctx.signal);
        const deliveryConfig = {
            ...this.config.checkpoint,
            /* A probe can be the request that auto-resumes a suspended VM. Give that
             * operation the worker's full budget; the shared abort signal still
             * enforces the actual remaining JOB_TIMEOUT. */
            timeoutMs: this.config.jobTimeoutMs,
        };
        let missing: Array<{ cache_key: string }>;
        try {
            missing = await this.probeInputsWithRetry(
                { mintToken, endpointBase, signal: ctx.signal },
                refs.map(ref => ({ cache_key: ref.cache_key })),
                deliveryConfig,
            );
        } catch (error) {
            return await this.rethrowInputDeliveryFailure(
                error,
                ctx.signal,
                onUnhealthy,
                'Session input delivery failed',
            );
        }
        logger.info('Session input delivery', {
            microvmId: vm.microvmId,
            refs: refs.length,
            missing: missing.length,
        });
        if (missing.length === 0) return;

        /* Source fetch/authorization/size failures say nothing about VM health.
         * Keep a warm session intact so a caller error cannot discard workspace
         * changes newer than the last checkpoint. */
        const wanted = new Set(missing.map(ref => ref.cache_key));
        const batch = await buildInputBatch(
            refs.filter(ref => wanted.has(ref.cache_key)),
            {
                timeoutMs: this.config.checkpoint.timeoutMs,
                maxBytes: this.config.checkpoint.maxBytes,
                signal: ctx.signal,
            },
        );
        if (!batch) {
            throw new SessionFilesError(
                'SESSION_INPUT_PREPARATION_FAILED',
                'Runner requested an empty session input batch',
            );
        }

        try {
            await pushInputs(
                { mintToken, endpointBase, signal: ctx.signal },
                () => fs.createReadStream(batch.path),
                deliveryConfig,
                batch.size,
                batch.expandedSize,
            );
        } catch (error) {
            return await this.rethrowInputDeliveryFailure(
                error,
                ctx.signal,
                onUnhealthy,
                'Session input push failed',
            );
        } finally {
            await batch.cleanup().catch(() => {});
        }

        /* Pruning happens as part of the push. Re-probe the ENTIRE working set so
         * an undersized runner cache cannot ACK the batch and then execute with an
         * older, currently-required ref evicted. */
        let stillMissing: Array<{ cache_key: string }>;
        try {
            stillMissing = await this.probeInputsWithRetry(
                { mintToken, endpointBase, signal: ctx.signal },
                refs.map(ref => ({ cache_key: ref.cache_key })),
                deliveryConfig,
            );
        } catch (error) {
            return await this.rethrowInputDeliveryFailure(
                error,
                ctx.signal,
                onUnhealthy,
                'Session input verification failed',
            );
        }
        if (stillMissing.length > 0) {
            throw new SessionFilesError(
                'SESSION_INPUT_TOO_LARGE',
                `Runner input cache cannot hold the ${refs.length}-object working set`,
            );
        }
    }

    /**
     * Input delivery is control-plane/cache work and has not started an NsJail
     * execution. Recycle a warm VM only when the failure positively says that VM
     * is gone or unreachable. Token throttles, other Lambda API failures, live
     * runner 4xx/5xx responses, validation errors, and caller aborts do not make
     * the VM unsafe to reuse.
     */
    private inputDeliveryProvesVmUnhealthy(
        error: unknown,
        signal: AbortSignal,
    ): boolean {
        if (signal.aborted) return false;
        if (error instanceof SandboxBackendError) {
            return error.code === 'MICROVM_UNHEALTHY';
        }
        if (!axios.isAxiosError(error)) return false;
        if (error.response == null) return true;
        return error.response.status >= 502 && error.response.status <= 504;
    }

    private async rethrowInputDeliveryFailure(
        error: unknown,
        signal: AbortSignal,
        onUnhealthy: (() => Promise<void>) | undefined,
        message: string,
    ): Promise<never> {
        /* Probe/push/token waits share the worker deadline but surface several
         * lower-level abort shapes. Preserve input-delivery semantics before
         * classifying VM health so the worker can return a sanitized 504. */
        if (signal.aborted) {
            throw new SessionFilesError(
                'SESSION_INPUT_ABORTED',
                'Session input delivery aborted',
            );
        }
        if (this.inputDeliveryProvesVmUnhealthy(error, signal)) {
            await onUnhealthy?.();
        }
        /* Preserve mapped control-plane codes (especially throttling) so callers
         * can apply their normal retry/backpressure policy. */
        if (error instanceof SandboxBackendError) {
            throw error;
        }
        throw new SandboxBackendError('MICROVM_UNHEALTHY', message, error);
    }

    private async probeInputsWithRetry(
        args: {
            mintToken: () => Promise<MicrovmAuthToken>;
            endpointBase: string;
            signal?: AbortSignal;
        },
        refs: Array<{ cache_key: string }>,
        config: CheckpointConfig,
    ): Promise<Array<{ cache_key: string }>> {
        const deadline = Date.now() + config.timeoutMs;
        for (;;) {
            try {
                return await probeInputs(args, refs, config);
            } catch (error) {
                const status = axios.isAxiosError(error)
                    ? (error.response?.status ?? 0)
                    : 0;
                /* A suspended endpoint can reset/refuse the connection while AWS
                 * auto-resumes it, before the proxy is ready to return a 502/503/504.
                 * Retry both transport-level failures and gateway transients under the
                 * caller's full bounded delivery budget. */
                const transient =
                    axios.isAxiosError(error) &&
                    (error.response == null ||
                        status === 502 ||
                        status === 503 ||
                        status === 504);
                if (
                    !transient ||
                    args.signal?.aborted ||
                    Date.now() + this.pollIntervalMs >= deadline
                ) {
                    throw error;
                }
                await sleep(this.pollIntervalMs, args.signal);
            }
        }
    }

    private async proxyExecute(
        client: LambdaMicrovmClient,
        vm: MicrovmDescription,
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
        runtimeSessionId?: string,
        readinessSatisfied = false,
    ): Promise<SandboxRawResponse> {
        const base = normalizeMicrovmEndpoint(vm.endpoint ?? '');
        const token = await this.mintAuthToken(
            client,
            vm.microvmId,
            ctx.signal,
        );
        /* Skip the preflight health check on a REUSED session VM: AWS may be
         * auto-resuming it from a suspend, and that resume can exceed the short
         * healthTimeoutMs (it scales with suspended-state size) — a slow-but-valid
         * resume would be misread as MICROVM_UNHEALTHY and the VM torn down. The
         * execute itself carries the resume under the full job budget, a
         * genuinely-evicted VM already fails token minting with not_found, and a
         * freshly-launched VM (reused=false) still gets the readiness probe. */
        if (!readinessSatisfied) {
            /* A freshly-launched VM's runner may still be booting (RUNNING is a
             * control-plane state). When checkpoints are active the launch path
             * already polled readiness; when they are disabled/stateless this is the
             * only gate — so poll until launchTimeoutMs rather than tearing the VM
             * down on a single connection-refused/503 probe. */
            await this.waitForRunnerReady(client, vm.microvmId, base, ctx);
        }

        /* Session mode is opted into per-request via this header (not a /run
         * lifecycle hook): stock container images can't route Lambda's build
         * hooks, so the runner reads its runtime session id straight off the
         * proxied execute. Header-only — never the manifest-signed body. */
        const sessionHeader = runtimeSessionId
            ? { [RUNTIME_SESSION_ID_HEADER]: runtimeSessionId }
            : undefined;

        return withSpan(
            'codeapi.sandbox.execute',
            {
                'http.request.method': 'POST',
                'url.path': `/${Jobs.execute}`,
                'codeapi.language': ctx.language,
                'codeapi.sandbox.backend': this.name,
            },
            async () => {
                const response = await axios.post<SandboxRawResponse>(
                    `${base}/api/v2/${Jobs.execute}`,
                    req.body,
                    {
                        headers: {
                            ...injectTraceHeaders(req.headers),
                            [token.headerName]: token.token,
                            ...microvmPortHeaders(this.config.port),
                            ...sessionHeader,
                        },
                        signal: ctx.signal,
                    },
                );
                if (response.status !== 200) {
                    throw new Error('Error from sandbox');
                }
                return response.data;
            },
            'CLIENT',
        );
    }

    private async launch(
        client: LambdaMicrovmClient,
        ctx: SandboxExecuteContext,
        opts: LaunchOptions,
    ): Promise<MicrovmDescription> {
        const deadlineSignal = AbortSignal.timeout(this.config.launchTimeoutMs);
        const budget: LaunchBudget = {
            deadlineAtMs: Date.now() + this.config.launchTimeoutMs,
            deadlineSignal,
            signal: AbortSignal.any([ctx.signal, deadlineSignal]),
        };
        const normalizeBudgetFailure = (error: unknown): unknown =>
            !ctx.signal.aborted && this.launchBudgetExpired(budget)
                ? this.launchTimeoutError()
                : error;

        try {
            return await this.launchOnce(client, ctx, opts, budget);
        } catch (error) {
            const normalizedError = normalizeBudgetFailure(error);
            const retryableError =
                normalizedError instanceof SandboxBackendError &&
                normalizedError.code === 'MICROVM_LAUNCH_FAILED' &&
                normalizedError.transient &&
                !ctx.signal.aborted
                    ? normalizedError
                    : undefined;
            if (!retryableError) {
                throw normalizedError;
            }
            /* Fresh clientToken: RunMicrovm is idempotent per token, so reusing the
             * original would hand back the same dead VM. The retry consumes only the
             * first attempt's remaining launch budget. */
            logger.warn(
                `[${ctx.executionId}] MicroVM died during boot (${retryableError.message}); retrying launch once`,
            );
            microvmLaunches.inc({ outcome: 'retried' });
            try {
                return await this.launchOnce(
                    client,
                    ctx,
                    { ...opts, clientToken: `${opts.clientToken}-r1` },
                    budget,
                );
            } catch (retryError) {
                throw normalizeBudgetFailure(retryError);
            }
        }
    }

    private launchBudgetExpired(budget: LaunchBudget): boolean {
        return (
            budget.deadlineSignal.aborted || Date.now() >= budget.deadlineAtMs
        );
    }

    private launchTimeoutError(): SandboxBackendError {
        return new SandboxBackendError(
            'MICROVM_LAUNCH_FAILED',
            `MicroVM launch did not reach RUNNING within ${this.config.launchTimeoutMs}ms`,
        );
    }

    private assertLaunchBudget(
        ctx: SandboxExecuteContext,
        budget: LaunchBudget,
    ): void {
        ctx.signal.throwIfAborted();
        if (this.launchBudgetExpired(budget)) throw this.launchTimeoutError();
    }

    private async launchOnce(
        client: LambdaMicrovmClient,
        ctx: SandboxExecuteContext,
        opts: LaunchOptions,
        budget: LaunchBudget,
    ): Promise<MicrovmDescription> {
        const endLaunchTimer = microvmLaunchDuration.startTimer();
        this.assertLaunchBudget(ctx, budget);
        try {
            await acquireOpBudget('run', {
                limitPerSecond: this.config.launchTps,
                budgetMs: Math.max(1, budget.deadlineAtMs - Date.now()),
                deadlineAtMs: budget.deadlineAtMs,
                signal: budget.signal,
            });
        } catch (error) {
            if (error instanceof MicrovmOpThrottledError) {
                microvmThrottleEvents.inc({ op: 'run' });
                microvmLaunches.inc({ outcome: 'throttled' });
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_THROTTLED',
                    error.message,
                    error,
                );
            }
            throw error;
        }
        this.assertLaunchBudget(ctx, budget);

        let vm: MicrovmDescription;
        try {
            vm = await client.runMicrovm(
                {
                    imageIdentifier: this.config.imageArn,
                    imageVersion: this.config.imageVersion,
                    executionRoleArn: this.config.executionRoleArn,
                    logGroup: this.config.logGroup,
                    ingressConnectorArns: this.config.ingressConnectorArns,
                    egressConnectorArns: this.config.egressConnectorArns,
                    maximumDurationSeconds: opts.maxDurationSeconds,
                    idlePolicy: opts.idlePolicy,
                    clientToken: opts.clientToken,
                },
                budget.signal,
                budget.deadlineSignal,
            );
        } catch (error) {
            if (
                error instanceof LambdaMicrovmApiError &&
                error.kind === 'throttled'
            ) {
                await poisonOpBucket('run', undefined, {
                    deadlineAtMs: budget.deadlineAtMs,
                    signal: budget.signal,
                });
                microvmThrottleEvents.inc({ op: 'run' });
                microvmLaunches.inc({ outcome: 'throttled' });
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_THROTTLED',
                    error.message,
                    error,
                );
            }
            microvmLaunches.inc({ outcome: 'failed' });
            throw new SandboxBackendError(
                'MICROVM_LAUNCH_FAILED',
                error instanceof Error ? error.message : 'RunMicrovm failed',
                error,
            );
        }

        try {
            const ready = await this.waitUntilRunning(client, vm, ctx, budget);
            microvmLaunches.inc({ outcome: 'ok' });
            endLaunchTimer();
            return ready;
        } catch (error) {
            microvmLaunches.inc({ outcome: 'failed' });
            const terminated = await this.terminate(
                client,
                vm.microvmId,
                'error',
            );
            if (!terminated) {
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_FAILED',
                    `MicroVM ${vm.microvmId} failed during boot and could not be terminated`,
                    error,
                );
            }
            /* waitUntilRunning throws SandboxBackendError for its own conditions, but
             * the GetMicrovm poll it makes can throw a raw LambdaMicrovmApiError
             * (throttle/transient control-plane error). Map it like runMicrovm so it
             * surfaces as a public MICROVM_LAUNCH_* failure, not a generic 500. */
            if (error instanceof SandboxBackendError) throw error;
            if (
                error instanceof LambdaMicrovmApiError &&
                error.kind === 'throttled'
            ) {
                await poisonOpBucket('run', undefined, {
                    deadlineAtMs: budget.deadlineAtMs,
                    signal: budget.signal,
                });
                microvmThrottleEvents.inc({ op: 'run' });
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_THROTTLED',
                    error.message,
                    error,
                );
            }
            throw new SandboxBackendError(
                'MICROVM_LAUNCH_FAILED',
                error instanceof Error ? error.message : 'MicroVM poll failed',
                error,
            );
        }
    }

    private async waitUntilRunning(
        client: LambdaMicrovmClient,
        vm: MicrovmDescription,
        ctx: SandboxExecuteContext,
        budget: LaunchBudget,
    ): Promise<MicrovmDescription> {
        let current = vm;
        for (;;) {
            if (ctx.signal.aborted) {
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_FAILED',
                    'Execution aborted while MicroVM was launching',
                );
            }
            if (this.launchBudgetExpired(budget))
                throw this.launchTimeoutError();
            if (current.state === 'RUNNING' && current.endpoint) return current;
            if (
                current.state === 'TERMINATED' ||
                current.state === 'TERMINATING'
            ) {
                /* A boot-time death is a fast, provider-side transient (observed in
                 * the field a few times a day) — mark it retryable so `launch` can
                 * try once more instead of surfacing a 503 to the caller. */
                throw new SandboxBackendError(
                    'MICROVM_LAUNCH_FAILED',
                    `MicroVM ${current.microvmId} entered ${current.state} before becoming ready`,
                    undefined,
                    true,
                );
            }
            if (Date.now() + this.pollIntervalMs > budget.deadlineAtMs)
                throw this.launchTimeoutError();
            await sleep(this.pollIntervalMs, budget.signal);
            current = await client.getMicrovm(current.microvmId, budget.signal);
        }
    }

    private async assertHealthy(
        base: string,
        token: string,
        ctx: SandboxExecuteContext,
    ): Promise<void> {
        try {
            const response = await axios.get(`${base}/api/v2/health`, {
                headers: {
                    'X-aws-proxy-auth': token,
                    ...microvmPortHeaders(this.config.port),
                },
                timeout: this.config.healthTimeoutMs,
                signal: ctx.signal,
            });
            if (response.status !== 200) {
                throw new Error(`health returned ${response.status}`);
            }
        } catch (error) {
            throw new SandboxBackendError(
                'MICROVM_UNHEALTHY',
                `MicroVM health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                error,
            );
        }
    }

    private async terminate(
        client: LambdaMicrovmClient,
        microvmId: string,
        reason: string,
    ): Promise<boolean> {
        try {
            await client.terminateMicrovm(
                microvmId,
                AbortSignal.timeout(this.config.launchTimeoutMs),
            );
            microvmTerminations.inc({ reason });
            return true;
        } catch (error) {
            if (
                error instanceof LambdaMicrovmApiError &&
                error.kind === 'not_found'
            ) {
                /* The desired terminal state already holds. Treat provider not-found as
                 * successful cleanup so a stale registry record cannot wedge relaunch. */
                microvmTerminations.inc({ reason });
                return true;
            }
            logger.error('Failed to terminate MicroVM', {
                microvmId,
                reason,
                error,
            });
            return false;
        }
    }
}
