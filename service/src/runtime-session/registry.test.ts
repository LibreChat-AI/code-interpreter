import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import {
    acquireRuntimeSessionLock,
    allocateCheckpointSequence,
    allocateRuntimeSessionGeneration,
    readRuntimeSessionRecord,
    releaseRuntimeSessionLock,
    removeRuntimeSession,
    renewRuntimeSessionLock,
    resetRedisForTests,
    setRedisForTests,
    waitForRuntimeSessionLock,
    writeRuntimeSessionRecord,
    type RuntimeSessionRecord,
} from './registry';

let mock: InstanceType<typeof RedisMock>;

beforeEach(async () => {
    /* ioredis-mock shares one keyspace across instances — flush per test. */
    mock = new RedisMock();
    await mock.flushall();
    setRedisForTests(mock);
});

afterEach(() => {
    resetRedisForTests();
});

function record(
    overrides: Partial<RuntimeSessionRecord> = {},
): RuntimeSessionRecord {
    return {
        runtime_session_id: 'rt_abc123',
        tenant_id: 'tenant-a',
        canonical_user_id: 'user-1',
        state: 'PENDING',
        generation: 1,
        last_seen_at: 1_778_250_000_000,
        ...overrides,
    };
}

describe('runtime session lock', () => {
    test('acquire is exclusive; release makes it available again', async () => {
        const token = await acquireRuntimeSessionLock('rt_abc123');
        expect(token).not.toBeNull();
        expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
        await releaseRuntimeSessionLock('rt_abc123', token as string);
        expect(await acquireRuntimeSessionLock('rt_abc123')).not.toBeNull();
    });

    test('release is CAS-guarded: a stale token cannot free the current holder', async () => {
        const first = await acquireRuntimeSessionLock('rt_abc123');
        await releaseRuntimeSessionLock('rt_abc123', first as string);
        const second = await acquireRuntimeSessionLock('rt_abc123');
        await releaseRuntimeSessionLock('rt_abc123', first as string);
        expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
        await releaseRuntimeSessionLock('rt_abc123', second as string);
    });

    test('waitForRuntimeSessionLock polls until the holder releases', async () => {
        const holder = await acquireRuntimeSessionLock('rt_abc123');
        setTimeout(
            () => void releaseRuntimeSessionLock('rt_abc123', holder as string),
            60,
        );
        const token = await waitForRuntimeSessionLock('rt_abc123', {
            waitMs: 2_000,
            pollMs: 20,
        });
        expect(token).not.toBeNull();
    });

    test('zero wait still attempts one uncontended lock acquisition', async () => {
        const token = await waitForRuntimeSessionLock('rt_zero_wait_free', {
            waitMs: 0,
        });
        expect(token).not.toBeNull();
        await releaseRuntimeSessionLock('rt_zero_wait_free', token as string);
    });

    test('zero wait returns immediately when the lock is contended', async () => {
        const holder = await acquireRuntimeSessionLock('rt_zero_wait_busy');
        const started = Date.now();
        const token = await waitForRuntimeSessionLock('rt_zero_wait_busy', {
            waitMs: 0,
            pollMs: 1_000,
        });
        expect(token).toBeNull();
        expect(Date.now() - started).toBeLessThan(500);
        await releaseRuntimeSessionLock('rt_zero_wait_busy', holder as string);
    });

    test('waitForRuntimeSessionLock gives up after waitMs', async () => {
        await acquireRuntimeSessionLock('rt_abc123');
        const started = Date.now();
        const token = await waitForRuntimeSessionLock('rt_abc123', {
            waitMs: 120,
            pollMs: 25,
        });
        expect(token).toBeNull();
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    test('waitForRuntimeSessionLock stops promptly when the job is canceled', async () => {
        const holder = await acquireRuntimeSessionLock('rt_abc123');
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(new Error('job deadline')), 10);

        await expect(
            waitForRuntimeSessionLock('rt_abc123', {
                waitMs: 5_000,
                pollMs: 1_000,
                signal: controller.signal,
            }),
        ).rejects.toThrow('job deadline');
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
        await releaseRuntimeSessionLock('rt_abc123', holder as string);
    });

    test('a hung Redis SET cannot outlive the job signal while waiting for the lock', async () => {
        const scripted = mock as unknown as {
            set(...args: unknown[]): Promise<'OK' | null>;
        };
        let calls = 0;
        scripted.set = async () => {
            calls += 1;
            return new Promise(() => {});
        };
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('job deadline')), 10);

        await expect(
            waitForRuntimeSessionLock('rt_hung_set', {
                waitMs: 5_000,
                signal: controller.signal,
            }),
        ).rejects.toThrow('job deadline');
        expect(calls).toBe(1);
    });

    test('an in-flight Redis SET cannot exceed the lock-wait budget', async () => {
        const scripted = mock as unknown as {
            set(...args: unknown[]): Promise<'OK' | null>;
        };
        scripted.set = async () => new Promise(() => {});
        const started = Date.now();

        expect(
            await waitForRuntimeSessionLock('rt_hung_set_wait', {
                waitMs: 25,
                pollMs: 1_000,
            }),
        ).toBeNull();
        expect(Date.now() - started).toBeLessThan(500);
    });

    test('a late successful SET is best-effort released after caller abort', async () => {
        type SetLock = (
            key: string,
            value: string,
            expiryMode: 'PX',
            ttlMs: number,
            condition: 'NX',
        ) => Promise<'OK' | null>;
        const scripted = mock as unknown as { set: SetLock };
        const originalSet = scripted.set.bind(scripted);
        let releaseDelayedSet!: () => void;
        const delayedSet = new Promise<void>(resolve => {
            releaseDelayedSet = resolve;
        });
        let markLateSetComplete!: () => void;
        const lateSetComplete = new Promise<void>(resolve => {
            markLateSetComplete = resolve;
        });
        let first = true;
        scripted.set = async (...args) => {
            if (first) {
                first = false;
                await delayedSet;
                const result = await originalSet(...args);
                markLateSetComplete();
                return result;
            }
            return originalSet(...args);
        };
        const controller = new AbortController();
        const acquire = acquireRuntimeSessionLock('rt_late_lock', 60_000, {
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(new Error('job deadline')), 10);

        await expect(acquire).rejects.toThrow('job deadline');
        releaseDelayedSet();
        await lateSetComplete;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if ((await mock.get('rtsx:lock:rt_late_lock')) == null) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(await mock.get('rtsx:lock:rt_late_lock')).toBeNull();
    });

    test('an applied SET whose replay resolves null cannot leave a ghost lock', async () => {
        type SetLock = (
            key: string,
            value: string,
            expiryMode: 'PX',
            ttlMs: number,
            condition: 'NX',
        ) => Promise<'OK' | null>;
        const scripted = mock as unknown as { set: SetLock };
        const originalSet = scripted.set.bind(scripted);
        let markApplied!: () => void;
        const applied = new Promise<void>(resolve => {
            markApplied = resolve;
        });
        let finishReplay!: () => void;
        const replay = new Promise<void>(resolve => {
            finishReplay = resolve;
        });
        let first = true;
        scripted.set = async (...args) => {
            if (!first) return originalSet(...args);
            first = false;
            await originalSet(...args);
            markApplied();
            await replay;
            /* Models ioredis replaying an applied command after its response was
             * lost: the same token already owns the key, so SET NX returns null. */
            return null;
        };
        const controller = new AbortController();
        const acquire = acquireRuntimeSessionLock('rt_ambiguous_lock', 60_000, {
            signal: controller.signal,
        });
        await applied;
        controller.abort(new Error('job deadline'));

        await expect(acquire).rejects.toThrow('job deadline');
        finishReplay();
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if ((await mock.get('rtsx:lock:rt_ambiguous_lock')) == null) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(await mock.get('rtsx:lock:rt_ambiguous_lock')).toBeNull();
    });

    test('an applied SET whose replay quickly resolves null is still released', async () => {
        type SetLock = (
            key: string,
            value: string,
            expiryMode: 'PX',
            ttlMs: number,
            condition: 'NX',
        ) => Promise<'OK' | null>;
        const scripted = mock as unknown as { set: SetLock };
        const originalSet = scripted.set.bind(scripted);
        let first = true;
        scripted.set = async (...args) => {
            if (!first) return originalSet(...args);
            first = false;
            await originalSet(...args);
            return null;
        };

        expect(
            await acquireRuntimeSessionLock('rt_fast_null_lock', 60_000),
        ).toBeNull();
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if ((await mock.get('rtsx:lock:rt_fast_null_lock')) == null) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(await mock.get('rtsx:lock:rt_fast_null_lock')).toBeNull();
    });

    test('an applied SET whose response quickly rejects is still released', async () => {
        type SetLock = (
            key: string,
            value: string,
            expiryMode: 'PX',
            ttlMs: number,
            condition: 'NX',
        ) => Promise<'OK' | null>;
        const scripted = mock as unknown as { set: SetLock };
        const originalSet = scripted.set.bind(scripted);
        let first = true;
        scripted.set = async (...args) => {
            if (!first) return originalSet(...args);
            first = false;
            await originalSet(...args);
            throw new Error('connection closed after apply');
        };

        await expect(
            acquireRuntimeSessionLock('rt_fast_reject_lock', 60_000),
        ).rejects.toThrow('connection closed after apply');
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if ((await mock.get('rtsx:lock:rt_fast_reject_lock')) == null)
                break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(await mock.get('rtsx:lock:rt_fast_reject_lock')).toBeNull();
    });

    test('lock polling catches abort between its precheck and listener registration', async () => {
        const holder = await acquireRuntimeSessionLock('rt_poll_abort_race');
        const reason = new Error('abort before listener registration');
        let aborted = false;
        let registrations = 0;
        const signal = {
            get aborted(): boolean {
                return aborted;
            },
            get reason(): Error {
                return reason;
            },
            throwIfAborted(): void {
                if (aborted) throw reason;
            },
            addEventListener(): void {
                registrations += 1;
                /* The first registration belongs to SET; the second is the poll
                 * sleep. Abort just before that listener becomes observable. */
                if (registrations === 2) aborted = true;
            },
            removeEventListener(): void {},
        } as unknown as AbortSignal;
        const started = Date.now();

        await expect(
            waitForRuntimeSessionLock('rt_poll_abort_race', {
                waitMs: 5_000,
                pollMs: 1_000,
                signal,
            }),
        ).rejects.toThrow(reason.message);
        expect(Date.now() - started).toBeLessThan(250);
        await releaseRuntimeSessionLock('rt_poll_abort_race', holder as string);
    });

    test('a late renewal token mismatch still reports lock loss', async () => {
        const scripted = mock as unknown as {
            renewRuntimeSessionLockScript(
                lockKey: string,
                token: string,
                ttlMs: string,
            ): Promise<number>;
        };
        let settleRenewal!: (result: number) => void;
        scripted.renewRuntimeSessionLockScript = async () =>
            new Promise<number>(resolve => {
                settleRenewal = resolve;
            });
        let markLateLost!: () => void;
        const lateLost = new Promise<void>(resolve => {
            markLateLost = resolve;
        });

        expect(
            await renewRuntimeSessionLock(
                'rt_late_renewal',
                'stale-token',
                60_000,
                { timeoutMs: 10, onLateLost: markLateLost },
            ),
        ).toBe('error');
        settleRenewal(0);
        await lateLost;
    });

    test('an already-aborted registry command is not enqueued', async () => {
        const scripted = mock as unknown as {
            get(key: string): Promise<string | null>;
        };
        let calls = 0;
        scripted.get = async () => {
            calls += 1;
            return null;
        };
        const controller = new AbortController();
        controller.abort(new Error('expired before read'));

        await expect(
            readRuntimeSessionRecord('rt_expired', {
                signal: controller.signal,
            }),
        ).rejects.toThrow('expired before read');
        expect(calls).toBe(0);
    });
});

describe('fenced record writes', () => {
    test('retries a transient lock-release failure so the session is immediately reusable', async () => {
        const token = (await acquireRuntimeSessionLock(
            'rt_release_retry',
        )) as string;
        const scripted = mock as unknown as {
            releaseRuntimeSessionLockScript(
                lockKey: string,
                lockToken: string,
            ): Promise<number>;
        };
        const release = scripted.releaseRuntimeSessionLockScript.bind(scripted);
        let calls = 0;
        scripted.releaseRuntimeSessionLockScript = async (
            lockKey,
            lockToken,
        ) => {
            calls += 1;
            if (calls === 1) throw new Error('temporary Redis failover');
            return release(lockKey, lockToken);
        };

        await releaseRuntimeSessionLock('rt_release_retry', token);

        expect(calls).toBe(2);
        expect(
            await acquireRuntimeSessionLock('rt_release_retry'),
        ).not.toBeNull();
    });

    test('write succeeds while holding the lock and round-trips the record', async () => {
        const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
        const rec = record({
            state: 'RUNNING',
            microvm_id: 'mvm-1',
            endpoint: 'https://vm.example',
            generation: 3,
        });
        expect(await writeRuntimeSessionRecord(rec, token)).toBe(true);
        expect(await readRuntimeSessionRecord('rt_abc123')).toEqual(rec);
    });

    test('reads a corrupt record as missing instead of throwing', async () => {
        await mock.set('rtsx:sess:rt_bad', '{not valid json');
        expect(await readRuntimeSessionRecord('rt_bad')).toBeNull();
    });

    test('a hung record read is bounded by the caller signal', async () => {
        const scripted = mock as unknown as {
            get(key: string): Promise<string | null>;
        };
        scripted.get = async () => new Promise(() => {});
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('job deadline')), 10);

        await expect(
            readRuntimeSessionRecord('rt_hung_read', {
                signal: controller.signal,
            }),
        ).rejects.toThrow('job deadline');
    });

    test('a hung fenced mutation is bounded by the caller signal and fails closed', async () => {
        const token = (await acquireRuntimeSessionLock(
            'rt_hung_write',
        )) as string;
        const scripted = mock as unknown as {
            writeRuntimeSessionRecordScript(
                sessKey: string,
                lockKey: string,
                lockToken: string,
                recordJson: string,
                ttlSeconds: string,
            ): Promise<number>;
        };
        scripted.writeRuntimeSessionRecordScript = async () =>
            new Promise(() => {});
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('job deadline')), 10);

        expect(
            await writeRuntimeSessionRecord(
                record({ runtime_session_id: 'rt_hung_write' }),
                token,
                undefined,
                { signal: controller.signal },
            ),
        ).toBe(false);
    });

    test('a timed-out fenced mutation is conservatively reported as lock loss', async () => {
        const token = (await acquireRuntimeSessionLock(
            'rt_timed_out_write',
        )) as string;
        const scripted = mock as unknown as {
            writeRuntimeSessionRecordScript(
                sessKey: string,
                lockKey: string,
                lockToken: string,
                recordJson: string,
                ttlSeconds: string,
            ): Promise<number>;
        };
        scripted.writeRuntimeSessionRecordScript = async () =>
            new Promise(() => {});

        expect(
            await writeRuntimeSessionRecord(
                record({ runtime_session_id: 'rt_timed_out_write' }),
                token,
                undefined,
                { timeoutMs: 10 },
            ),
        ).toBe(false);
    });

    test('a fenced mutation transport error is conservatively reported as lock loss', async () => {
        const token = (await acquireRuntimeSessionLock(
            'rt_ambiguous_write',
        )) as string;
        const scripted = mock as unknown as {
            writeRuntimeSessionRecordScript(
                sessKey: string,
                lockKey: string,
                lockToken: string,
                recordJson: string,
                ttlSeconds: string,
            ): Promise<number>;
        };
        scripted.writeRuntimeSessionRecordScript = async () => {
            throw new Error('connection closed after apply');
        };

        expect(
            await writeRuntimeSessionRecord(
                record({ runtime_session_id: 'rt_ambiguous_write' }),
                token,
            ),
        ).toBe(false);
    });

    test('lock release has a separate bounded cleanup budget', async () => {
        const token = (await acquireRuntimeSessionLock(
            'rt_hung_release',
        )) as string;
        const scripted = mock as unknown as {
            releaseRuntimeSessionLockScript(
                lockKey: string,
                lockToken: string,
            ): Promise<number>;
        };
        scripted.releaseRuntimeSessionLockScript = async () =>
            new Promise(() => {});
        const started = Date.now();

        await releaseRuntimeSessionLock('rt_hung_release', token, {
            timeoutMs: 25,
        });

        expect(Date.now() - started).toBeLessThan(500);
    });

    test('write is fenced after the lock is lost', async () => {
        const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
        await releaseRuntimeSessionLock('rt_abc123', token);
        const thief = await acquireRuntimeSessionLock('rt_abc123');
        expect(thief).not.toBeNull();
        expect(await writeRuntimeSessionRecord(record(), token)).toBe(false);
        expect(await readRuntimeSessionRecord('rt_abc123')).toBeNull();
    });

    test('write is fenced when no lock exists at all', async () => {
        expect(await writeRuntimeSessionRecord(record(), 'never-held')).toBe(
            false,
        );
    });

    test('removal is fenced and clears the record', async () => {
        const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
        await writeRuntimeSessionRecord(record(), token);

        expect(await removeRuntimeSession('rt_abc123', 'stale-token')).toBe(
            false,
        );
        expect(await readRuntimeSessionRecord('rt_abc123')).not.toBeNull();

        expect(await removeRuntimeSession('rt_abc123', token)).toBe(true);
        expect(await readRuntimeSessionRecord('rt_abc123')).toBeNull();
    });
});

describe('generation counter', () => {
    test('increments monotonically per session and independently across sessions', async () => {
        expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(1);
        expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(2);
        expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(3);
        expect(await allocateRuntimeSessionGeneration('rt_other')).toBe(1);
    });

    test('atomically promotes a legacy counter to a caller-provided namespace', async () => {
        expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(1);
        expect(
            await allocateRuntimeSessionGeneration(
                'rt_abc123',
                1_000_000_000_000_123,
            ),
        ).toBe(1_000_000_000_000_123);
        expect(
            await allocateRuntimeSessionGeneration(
                'rt_abc123',
                1_000_000_000_000_100,
            ),
        ).toBe(1_000_000_000_000_124);
    });

    test('serializes concurrent promotion attempts without reusing the seed', async () => {
        const seed = 1_000_000_000_000_321;
        const generations = await Promise.all([
            allocateRuntimeSessionGeneration('rt_abc123', seed),
            allocateRuntimeSessionGeneration('rt_abc123', seed),
        ]);
        expect(generations.sort((a, b) => a - b)).toEqual([seed, seed + 1]);
    });
});

describe('checkpoint sequence counter', () => {
    test('concurrent stale holders reserve distinct keys above the durable high-water mark', async () => {
        /* Models two holders that both listed durable sequence 100 around a lease
         * handoff. A split INCR + reseed SET can return 101 to both and let the
         * stale upload overwrite the new holder's committed object. The atomic
         * reservation must serialize them as 101 and 102 instead. */
        const reservations = await Promise.all([
            allocateCheckpointSequence('rt_abc123', 100),
            allocateCheckpointSequence('rt_abc123', 100),
        ]);
        expect(reservations.sort((a, b) => a - b)).toEqual([101, 102]);
        expect(await allocateCheckpointSequence('rt_abc123', 50)).toBe(103);
    });
});
