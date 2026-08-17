import { describe, expect, test } from 'bun:test';
import { startRuntimeSessionLockHeartbeat } from './lock-heartbeat';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('runtime session lock heartbeat', () => {
    test('independently fences a holder whose renewal never settles', async () => {
        const fence = new AbortController();
        let calls = 0;
        const heartbeat = startRuntimeSessionLockHeartbeat({
            renew: () => {
                calls += 1;
                return new Promise(() => {});
            },
            fence,
            ttlMs: 40,
            intervalMs: 5,
        });
        try {
            await wait(70);
            expect(fence.signal.aborted).toBe(true);
            expect(calls).toBe(1);
        } finally {
            heartbeat.stop();
        }
    });

    test('fences immediately when Redis reports the lock was lost', async () => {
        const fence = new AbortController();
        const heartbeat = startRuntimeSessionLockHeartbeat({
            renew: async () => 'lost',
            fence,
            ttlMs: 1_000,
            intervalMs: 5,
        });
        try {
            await wait(20);
            expect(fence.signal.aborted).toBe(true);
        } finally {
            heartbeat.stop();
        }
    });

    test('an unexpected renewal rejection still fences at the independent deadline', async () => {
        const fence = new AbortController();
        const heartbeat = startRuntimeSessionLockHeartbeat({
            renew: async () => {
                throw new Error('transport exploded');
            },
            fence,
            ttlMs: 40,
            intervalMs: 5,
        });
        try {
            await wait(70);
            expect(fence.signal.aborted).toBe(true);
        } finally {
            heartbeat.stop();
        }
    });

    test('a renewal that settles after stop cannot re-arm the expiry watchdog', async () => {
        const fence = new AbortController();
        let resolveRenewal!: (result: 'held') => void;
        let markRenewalStarted!: () => void;
        const renewalStarted = new Promise<void>(resolve => {
            markRenewalStarted = resolve;
        });
        const heartbeat = startRuntimeSessionLockHeartbeat({
            renew: () => {
                markRenewalStarted();
                return new Promise<'held'>(resolve => {
                    resolveRenewal = resolve;
                });
            },
            fence,
            ttlMs: 40,
            intervalMs: 5,
        });
        try {
            await renewalStarted;
            heartbeat.stop();
            resolveRenewal('held');
            await wait(70);
            expect(fence.signal.aborted).toBe(false);
        } finally {
            heartbeat.stop();
        }
    });
});
