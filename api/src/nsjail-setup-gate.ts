import * as fsp from 'fs/promises';

/**
 * Serializes the unsafe portion of NsJail launches inside a single runner.
 *
 * NsJail with `no_pivotroot: true` and no explicit chroot picks a host-shared
 * setup directory of the form `/tmp/nsjail.<orig_uid>.root`. Because the
 * runner runs as root (required by SANDBOX_PER_JOB_UIDS), every concurrent
 * NsJail child targets the same path: `/tmp/nsjail.0.root`. The bind-mount
 * inside each child's mount namespace is private, but the host directory
 * entry and the mkdir/chmod/bind sequence around it race.
 *
 * This gate guards only the spawn -> "mounts done" window. NsJail flushes
 * `[I] ... Executing "<bin>" for '...'` to its `--log` file immediately after
 * all mount setup completes and before exec(2). We hold the gate until that
 * marker appears or a watchdog timeout fires, then release so the job runs
 * its actual code in parallel with siblings. Throughput stays in the runner;
 * only the dangerous ~tens-of-ms window is serialized.
 */
export interface NsJailSetupGateOptions {
    /** Poll interval (ms) when tailing the NsJail log for the setup-done marker. */
    pollIntervalMs?: number;
    /**
     * Hard upper bound (ms) on how long the gate will wait for the marker.
     * Set well above expected setup time (~tens of ms) so a slow flush does
     * not falsely time out, but well below per-job timeouts so a wedged setup
     * does not jam the queue.
     */
    watchdogMs?: number;
    /**
     * Substring searched for in the log file. NsJail at default verbosity
     * emits `[I][<ts>] Executing "<bin>" for '<connstr>'` once all mounts are
     * complete; matching the literal ` Executing ` (with leading space) avoids
     * false positives on user output named "Executing".
     */
    marker?: string;
    /** Test seam: override fs reads. */
    readFile?: (path: string) => Promise<string>;
    /** Test seam: override `setTimeout`-based delay. */
    delay?: (ms: number) => Promise<void>;
    /** Test seam: monotonic clock source in ms. */
    now?: () => number;
}

export interface NsJailSetupGateResult<T> {
    value: T;
    /** True if the post-mount log marker was observed before the watchdog. */
    markerSeen: boolean;
    /**
     * Last non-ENOENT error encountered while polling, if any. Always
     * undefined when `markerSeen` is true. When `markerSeen` is false this
     * lets the caller distinguish "log file existed but never contained the
     * marker" (no `pollError`) from "log file was unreadable" (set).
     */
    pollError?: NodeJS.ErrnoException;
}

export interface NsJailSetupGate {
    /**
     * Acquires the gate, invokes `spawn` (synchronously), then waits until the
     * NsJail child has finished its mount-setup phase (either the log marker
     * appears or the watchdog fires). Returns whatever `spawn` returned. Any
     * exception thrown by `spawn` releases the gate before propagating.
     *
     * `abortSignal` (optional) is checked between log-poll iterations and
     * releases the gate immediately when aborted — used by callers that
     * detect the child died asynchronously (e.g. node:child_process spawn
     * emitting ENOENT/EACCES on its 'error' event). Without this, every
     * failed spawn pays the full watchdogMs (default 1500ms) while
     * holding the serialized gate, amplifying latency for every queued
     * job behind it. When aborted, the result reports markerSeen=false
     * — the caller is expected to immediately surface the spawn error
     * and skip the "watchdog fired" warning path.
     */
    runSetup<T>(
        logPath: string,
        spawn: () => T,
        abortSignal?: AbortSignal,
    ): Promise<NsJailSetupGateResult<T>>;
    /** For metrics/tests: how many callers are currently waiting on the gate. */
    pending(): number;
}

const DEFAULT_OPTIONS: Required<
    Omit<NsJailSetupGateOptions, 'readFile' | 'delay' | 'now'>
> = {
    pollIntervalMs: 10,
    watchdogMs: 1500,
    marker: ' Executing ',
};

export function createNsJailSetupGate(
    options: NsJailSetupGateOptions = {},
): NsJailSetupGate {
    const cfg = { ...DEFAULT_OPTIONS, ...options };
    const readFile =
        options.readFile ?? ((p: string) => fsp.readFile(p, 'utf8'));
    const delay =
        options.delay ??
        ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());

    /* Single FIFO chain. Each acquirer awaits the previous tail before
     * proceeding; the new tail is the promise resolved by `release()`. This
     * preserves request order without an external queue and keeps `pending()`
     * honest. */
    let tail: Promise<void> = Promise.resolve();
    let waiters = 0;

    async function pollForMarker(
        logPath: string,
        abortSignal?: AbortSignal,
    ): Promise<{
        markerSeen: boolean;
        lastError?: NodeJS.ErrnoException;
    }> {
        const start = now();
        let lastError: NodeJS.ErrnoException | undefined;
        for (;;) {
            /* Caller signaled the child died (e.g. node:child_process emitted
             * 'error' or 'close' before NsJail could log its marker). Release
             * immediately so the queued setup-gate chain doesn't pay the full
             * watchdogMs for every misconfigured / fork-pressure spawn. */
            if (abortSignal?.aborted) return { markerSeen: false, lastError };
            try {
                const content = await readFile(logPath);
                if (content.includes(cfg.marker)) return { markerSeen: true };
                /* File is readable and currently has no marker — clear any
                 * previously-recorded read error since the fs is now healthy. */
                lastError = undefined;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                    /* NsJail hasn't flushed its log yet. Expected pre-marker state,
                     * not a diagnosable failure — don't touch lastError so callers
                     * can distinguish "log never appeared" from "log appeared but
                     * was unreadable" in the watchdog warn. */
                } else {
                    /* EACCES on a chmod race, EISDIR if the path got clobbered,
                     * EIO, ... — we can't currently observe the marker. Failing
                     * OPEN here would release the gate before NsJail finished its
                     * mount setup, the exact unsafe overlap this gate exists to
                     * prevent. Keep polling until the watchdog fires and retain
                     * the most recent error so the caller can surface it. */
                    lastError = err as NodeJS.ErrnoException;
                }
            }
            if (now() - start >= cfg.watchdogMs)
                return { markerSeen: false, lastError };
            await delay(cfg.pollIntervalMs);
        }
    }

    async function runSetup<T>(
        logPath: string,
        spawn: () => T,
        abortSignal?: AbortSignal,
    ): Promise<NsJailSetupGateResult<T>> {
        waiters++;
        const previous = tail;
        let releaseSelf: () => void = () => {};
        const selfBarrier = new Promise<void>(resolve => {
            releaseSelf = resolve;
        });
        tail = previous.then(() => selfBarrier);

        try {
            await previous;
        } catch {
            /* A previous holder rejecting must not poison successors. The chain
             * was extended above, and `releaseSelf()` below will still resolve
             * `selfBarrier`, so the next waiter unblocks normally. */
        }

        waiters--;
        let value: T;
        try {
            value = spawn();
        } catch (err) {
            releaseSelf();
            throw err;
        }

        const result = await pollForMarker(logPath, abortSignal);
        releaseSelf();
        return {
            value,
            markerSeen: result.markerSeen,
            pollError: result.lastError,
        };
    }

    return {
        runSetup,
        pending: () => waiters,
    };
}

/** Process-wide default gate used by nsjail.execute(). */
export const defaultNsJailSetupGate = createNsJailSetupGate();
