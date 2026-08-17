export interface LockHeartbeat {
    stop(): void;
}

/**
 * Renews a session lease without overlapping Redis calls and independently
 * fences the holder when no renewal can be confirmed before the current TTL.
 * The deadline is measured from request start, so a delayed "held" response
 * cannot extend a lease that may already have expired in the meantime.
 */
export function startRuntimeSessionLockHeartbeat(args: {
    renew: () => Promise<'held' | 'lost' | 'error'>;
    fence: AbortController;
    ttlMs: number;
    intervalMs?: number;
}): LockHeartbeat {
    const ttlMs = args.ttlMs;
    const intervalMs = args.intervalMs ?? Math.floor(ttlMs / 3);
    let stopped = false;
    let inFlight = false;
    let expiry: ReturnType<typeof setTimeout>;

    const armExpiry = (remainingMs = ttlMs): void => {
        clearTimeout(expiry);
        expiry = setTimeout(() => args.fence.abort(), Math.max(0, remainingMs));
    };
    armExpiry();

    const tick = (): void => {
        if (stopped || inFlight || args.fence.signal.aborted) return;
        inFlight = true;
        const startedAt = Date.now();
        void args
            .renew()
            .then(
                renewal => {
                    if (stopped || args.fence.signal.aborted) return;
                    if (renewal === 'lost') {
                        args.fence.abort();
                        return;
                    }
                    if (renewal === 'held') {
                        armExpiry(ttlMs - (Date.now() - startedAt));
                    }
                },
                () => {
                    /* Treat an unexpected rejection like the registry's explicit `error`
                     * result: the independent TTL watchdog remains authoritative. */
                },
            )
            .finally(() => {
                inFlight = false;
            });
    };

    const interval = setInterval(tick, intervalMs);
    return {
        stop(): void {
            stopped = true;
            clearInterval(interval);
            clearTimeout(expiry);
        },
    };
}
