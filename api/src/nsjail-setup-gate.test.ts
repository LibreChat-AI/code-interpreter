import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createNsJailSetupGate } from './nsjail-setup-gate';

/**
 * Tests use a real tmp dir + real `setTimeout` with very short intervals
 * rather than a virtual clock. The gate is tiny and the dangerous behavior
 * is timing-sensitive enough that a virtual clock would mostly be testing
 * the mock rather than the gate. Each test runs in <100ms in practice.
 */

let tmpRoot: string | undefined;

async function tmpFile(name = 'nsjail.log'): Promise<string> {
    if (!tmpRoot) {
        tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gate-test-'));
    }
    return path.join(tmpRoot, `${Math.random().toString(36).slice(2)}-${name}`);
}

describe('createNsJailSetupGate', () => {
    test('releases as soon as the setup-done marker appears in the log', async () => {
        const logPath = await tmpFile();
        const gate = createNsJailSetupGate({
            pollIntervalMs: 2,
            watchdogMs: 500,
        });

        let spawned = 0;
        const start = Date.now();
        /* Write the marker shortly after spawn; the gate should release within
         * pollIntervalMs of the write. */
        setTimeout(() => {
            fs.writeFileSync(
                logPath,
                '[I][2026-05-14] Executing "/bin/bash" for \'[NONE]\'\n',
            );
        }, 15);

        const { value, markerSeen } = await gate.runSetup(logPath, () => {
            spawned++;
            return 'proc-a';
        });

        const elapsed = Date.now() - start;
        expect(value).toBe('proc-a');
        expect(spawned).toBe(1);
        expect(markerSeen).toBe(true);
        /* Should release well before the watchdog. Generous bound to absorb
         * Windows fs jitter; the point is "much less than watchdogMs". */
        expect(elapsed).toBeLessThan(300);
    });

    test('serializes concurrent acquirers FIFO and releases after marker', async () => {
        const gate = createNsJailSetupGate({
            pollIntervalMs: 2,
            watchdogMs: 500,
        });
        const logA = await tmpFile('a.log');
        const logB = await tmpFile('b.log');
        const logC = await tmpFile('c.log');

        const order: string[] = [];

        const a = gate.runSetup(logA, () => {
            order.push('spawn-a');
            return 'a';
        });
        const b = gate.runSetup(logB, () => {
            order.push('spawn-b');
            return 'b';
        });
        const c = gate.runSetup(logC, () => {
            order.push('spawn-c');
            return 'c';
        });

        /* Let microtasks drain so A's spawn runs but B and C are still queued. */
        await new Promise(r => setTimeout(r, 5));
        expect(order).toEqual(['spawn-a']);
        expect(gate.pending()).toBe(2);

        fs.writeFileSync(logA, 'pre [I] Executing "/x" for stuff\n');
        await a;
        /* Yield so B's chained `.then` runs its spawn(). */
        await new Promise(r => setTimeout(r, 5));
        expect(order).toEqual(['spawn-a', 'spawn-b']);
        expect(gate.pending()).toBe(1);

        fs.writeFileSync(logB, 'pre Executing "/y" for stuff\n');
        await b;
        await new Promise(r => setTimeout(r, 5));
        expect(order).toEqual(['spawn-a', 'spawn-b', 'spawn-c']);
        expect(gate.pending()).toBe(0);

        fs.writeFileSync(logC, 'pre Executing "/z" for stuff\n');
        await c;
    });

    test('watchdog releases the gate when no marker ever arrives', async () => {
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 60,
        });
        const logPath = await tmpFile();
        /* Never write to the log. Every poll iteration sees ENOENT, which is
         * the expected pre-flush state — it must NOT be reported as a
         * pollError, otherwise oncall would see a misleading "fs error" on
         * every plain watchdog fire (e.g. a job whose NsJail flushed slowly). */
        const start = Date.now();
        const { markerSeen, pollError } = await gate.runSetup(
            logPath,
            () => 'a',
        );
        const elapsed = Date.now() - start;
        expect(markerSeen).toBe(false);
        expect(pollError).toBeUndefined();
        /* Watchdog fired ~at 60ms. Loose upper bound to absorb scheduler jitter
         * on Windows. */
        expect(elapsed).toBeGreaterThanOrEqual(50);
        expect(elapsed).toBeLessThan(500);
    });

    test('abortSignal releases the gate immediately so a failed spawn does not stall the queue', async () => {
        /* Codex P1 follow-up on PR #1651: without abort, every async spawn
         * failure (ENOENT/EACCES) pays the full watchdogMs while holding the
         * serialized gate, amplifying latency for every queued job behind it.
         * Verifies the gate honors AbortSignal: it should return well before
         * watchdog when the signal fires (simulating child 'error'/'close'). */
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 500,
        });
        const logPath = await tmpFile();
        const controller = new AbortController();

        /* Abort shortly after spawn, simulating an ENOENT 'error' event firing
         * from a missing nsjail binary. */
        setTimeout(() => controller.abort(), 20);

        const start = Date.now();
        const { markerSeen, pollError } = await gate.runSetup(
            logPath,
            () => 'aborted',
            controller.signal,
        );
        const elapsed = Date.now() - start;

        expect(markerSeen).toBe(false);
        expect(pollError).toBeUndefined();
        /* Should release within ~one poll interval of the abort, not at the
         * 500ms watchdog. Generous upper bound to absorb scheduler jitter. */
        expect(elapsed).toBeLessThan(150);
    });

    test('queue does not stall when one job aborts mid-poll — next job runs immediately', async () => {
        /* The end-to-end "no latency amplification" assertion. Two jobs
         * back-to-back: the first aborts (simulating a failed spawn), the
         * second must start within milliseconds of the abort — not after the
         * watchdog fires. */
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 1000,
        });
        const logPath1 = await tmpFile();
        const logPath2 = await tmpFile();
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 20);
        /* Make the second job's marker appear instantly so it's ready to
         * release the moment its turn at the gate starts. */
        fs.writeFileSync(
            logPath2,
            '[I][2026-05-14] Executing "/bin/bash" for \'[NONE]\'\n',
        );

        const start = Date.now();
        const [r1, r2] = await Promise.all([
            gate.runSetup(logPath1, () => 'first', ctrl.signal),
            gate.runSetup(logPath2, () => 'second'),
        ]);
        const elapsed = Date.now() - start;

        expect(r1.markerSeen).toBe(false);
        expect(r2.markerSeen).toBe(true);
        /* Without the abort, this would take ~1000ms (first job hits watchdog
         * before releasing for the second). With abort: well under 100ms. */
        expect(elapsed).toBeLessThan(200);
    });

    test('does not match the literal "Executing" without the leading space prefix', async () => {
        /* NsJail's INFO-level line always renders as `[I][<ts>] Executing ...`
         * — the gate keys on ` Executing ` (with leading space) so user code
         * that prints "Executing" at column 0 cannot prematurely trip release. */
        const gate = createNsJailSetupGate({
            pollIntervalMs: 2,
            watchdogMs: 60,
        });
        const logPath = await tmpFile();
        fs.writeFileSync(logPath, 'Executing user code without prefix\n');
        const { markerSeen } = await gate.runSetup(logPath, () => 'a');
        expect(markerSeen).toBe(false);
    });

    test('a spawn() exception releases the gate so the next waiter proceeds', async () => {
        const gate = createNsJailSetupGate({
            pollIntervalMs: 2,
            watchdogMs: 500,
        });
        const logA = await tmpFile('a.log');
        const logB = await tmpFile('b.log');

        const failing = gate.runSetup(logA, () => {
            throw new Error('spawn boom');
        });
        const second = gate.runSetup(logB, () => 'b');

        await expect(failing).rejects.toThrow('spawn boom');

        fs.writeFileSync(logB, 'x Executing y\n');
        const { value, markerSeen } = await second;
        expect(value).toBe('b');
        expect(markerSeen).toBe(true);
    });

    test('64 concurrent acquirers run in strict spawn-order and the chain drains', async () => {
        /* High-N stress: catches FIFO violations, promise-chain leaks, and the
         * "watchdog releases the chain too eagerly" failure mode. Each fake log
         * gets its marker written on a staggered schedule so the gate has to
         * actually wait per-acquirer rather than racing through. */
        const N = 64;
        const gate = createNsJailSetupGate({
            pollIntervalMs: 1,
            watchdogMs: 5000,
        });
        const order: number[] = [];
        const logs: string[] = [];

        /* Resolve logs first so the schedule starts deterministically — racing
         * tmpFile() and runSetup() concurrently introduces nondeterminism that
         * makes the test flaky on Windows fs jitter. */
        for (let i = 0; i < N; i++) {
            logs.push(await tmpFile(`burst-${i}.log`));
        }

        const runs: Promise<{ value: number; markerSeen: boolean }>[] = [];
        for (let i = 0; i < N; i++) {
            runs.push(
                gate.runSetup(logs[i], () => {
                    order.push(i);
                    return i;
                }),
            );
        }

        /* Drip-feed markers ~5ms apart. The gate must wait for each marker
         * before letting the next acquirer spawn. */
        let scheduled = 0;
        const interval = setInterval(() => {
            const i = scheduled++;
            if (i >= N) {
                clearInterval(interval);
                return;
            }
            fs.writeFileSync(logs[i], `pre [I] Executing "/x${i}"\n`);
        }, 5);

        const results = await Promise.all(runs);
        clearInterval(interval);

        expect(results.length).toBe(N);
        expect(results.every(r => r.markerSeen)).toBe(true);
        expect(order).toEqual(Array.from({ length: N }, (_v, i) => i));
        expect(gate.pending()).toBe(0);
    });

    test('persistent non-ENOENT readFile errors keep the gate held until the watchdog', async () => {
        /* Defense-in-depth: a transient EACCES/EISDIR/EIO must NOT release the
         * gate early, because that would let the next NsJail launch its mount
         * setup while the previous one is still in the unsafe window — exactly
         * the overlap this gate exists to prevent. The gate keeps polling
         * (best-effort) and only releases once the watchdog fires; the last
         * error is surfaced so the caller can log a diagnostic reason. */
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 80,
            readFile: async () => {
                const err = new Error('EISDIR') as NodeJS.ErrnoException;
                err.code = 'EISDIR';
                throw err;
            },
        });
        const start = Date.now();
        const { markerSeen, pollError } = await gate.runSetup(
            '/anywhere',
            () => 'a',
        );
        const elapsed = Date.now() - start;
        expect(markerSeen).toBe(false);
        expect(pollError?.code).toBe('EISDIR');
        /* Held for at least the watchdog window — proves we did NOT fail open. */
        expect(elapsed).toBeGreaterThanOrEqual(70);
        expect(elapsed).toBeLessThan(500);
    });

    test('a non-ENOENT error followed by ENOENTs preserves the diagnostic until watchdog', async () => {
        /* If an EACCES happens once and then the file goes back to ENOENT
         * (e.g. another process unlinked the inaccessible log), the gate
         * should still surface EACCES at the watchdog rather than overwriting
         * the diagnostic with the benign "not yet" signal. */
        let calls = 0;
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 80,
            readFile: async () => {
                calls++;
                if (calls === 1) {
                    const err = new Error('EACCES') as NodeJS.ErrnoException;
                    err.code = 'EACCES';
                    throw err;
                }
                const err = new Error('ENOENT') as NodeJS.ErrnoException;
                err.code = 'ENOENT';
                throw err;
            },
        });
        const { markerSeen, pollError } = await gate.runSetup(
            '/anywhere',
            () => 'a',
        );
        expect(markerSeen).toBe(false);
        expect(pollError?.code).toBe('EACCES');
    });

    test('a transient readFile error followed by the marker still releases on the marker', async () => {
        /* If a read fails once but the file becomes readable before the
         * watchdog, the gate should release on the marker as normal and clear
         * pollError (no spurious diagnostic). */
        const logPath = await tmpFile();
        let calls = 0;
        const gate = createNsJailSetupGate({
            pollIntervalMs: 5,
            watchdogMs: 500,
            readFile: async p => {
                calls++;
                if (calls === 1) {
                    const err = new Error('EAGAIN') as NodeJS.ErrnoException;
                    err.code = 'EAGAIN';
                    throw err;
                }
                return fsp.readFile(p, 'utf8');
            },
        });
        setTimeout(() => {
            fs.writeFileSync(logPath, 'q Executing r\n');
        }, 20);
        const { markerSeen, pollError } = await gate.runSetup(
            logPath,
            () => 'a',
        );
        expect(markerSeen).toBe(true);
        expect(pollError).toBeUndefined();
    });
});
