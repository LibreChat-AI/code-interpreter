import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { startWarmupCommand } from './warmup';

type ProcessKill = (pid: number, signal?: NodeJS.Signals | number) => boolean;

function replaceProcessKill(replacement: ProcessKill): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'kill');
    Object.defineProperty(process, 'kill', {
        configurable: true,
        writable: true,
        value: replacement,
    });
    return () => {
        if (descriptor) Object.defineProperty(process, 'kill', descriptor);
    };
}

describe('startWarmupCommand', () => {
    test('waits for the command before reporting warmup complete', async () => {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'warmup-'));
        const marker = path.join(tmp, 'warmed');
        try {
            expect(await startWarmupCommand(`touch '${marker}'`, 5_000)).toBe(
                'completed',
            );
            expect(await fsp.readFile(marker, 'utf8')).toBe('');
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    });

    test('is a no-op when the command is unset or blank', async () => {
        expect(await startWarmupCommand(undefined)).toBe('skipped');
        expect(await startWarmupCommand('')).toBe('skipped');
        expect(await startWarmupCommand('   ')).toBe('skipped');
    });

    test('a failing command is surfaced without throwing', async () => {
        expect(
            await startWarmupCommand('/nonexistent-warmup-binary --flag'),
        ).toBe('failed');
        expect(await startWarmupCommand('exit 7')).toBe('failed');
    });

    test('terminates a warmup that exceeds its startup budget', async () => {
        const started = Date.now();
        expect(await startWarmupCommand('sleep 10', 30)).toBe('timed_out');
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    test('does not report completion while a normally-exited shell left a child running', async () => {
        if (process.platform === 'win32') return;

        const realKill = process.kill.bind(process) as ProcessKill;
        let killedGroup: number | undefined;
        const restoreProcessKill = replaceProcessKill((pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') killedGroup = pid;
            return realKill(pid, signal);
        });
        try {
            expect(await startWarmupCommand('sleep 10 &', 30, 2_000)).toBe(
                'timed_out',
            );
            expect(killedGroup).toBeDefined();
            expect(() => realKill(killedGroup as number, 0)).toThrow();
        } finally {
            restoreProcessKill();
            if (killedGroup != null) {
                try {
                    realKill(killedGroup, 'SIGKILL');
                } catch {
                    // Already reaped, which is the expected path.
                }
            }
        }
    });

    test('waits for the timed-out process group to disappear before resolving', async () => {
        if (process.platform === 'win32') return;

        const realKill = process.kill.bind(process) as ProcessKill;
        let groupPid: number | undefined;
        let delayedKill: ReturnType<typeof setTimeout> | undefined;
        const restoreProcessKill = replaceProcessKill((pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') {
                groupPid = pid;
                delayedKill = setTimeout(() => {
                    try {
                        realKill(pid, signal);
                    } catch {
                        // The group may have exited naturally before the delayed signal.
                    }
                }, 120);
                return true;
            }
            return realKill(pid, signal);
        });

        const started = Date.now();
        try {
            expect(await startWarmupCommand('sleep 10 & wait', 30, 2_000)).toBe(
                'timed_out',
            );
            expect(Date.now() - started).toBeGreaterThanOrEqual(100);
            expect(groupPid).toBeDefined();
            expect(() => realKill(groupPid as number, 0)).toThrow();
        } finally {
            restoreProcessKill();
            if (delayedKill) clearTimeout(delayedKill);
            if (groupPid != null) {
                try {
                    realKill(groupPid, 'SIGKILL');
                } catch {
                    // Already reaped, which is the expected path.
                }
            }
        }
    });

    test('fails startup within a bound when process-group disappearance cannot be proven', async () => {
        if (process.platform === 'win32') return;

        const realKill = process.kill.bind(process) as ProcessKill;
        let groupPid: number | undefined;
        const restoreProcessKill = replaceProcessKill((pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') {
                groupPid = pid;
                return realKill(pid, signal);
            }
            /* Model an EPERM/unknown probe outcome after SIGKILL: only ESRCH proves
             * the group is absent, so startup must remain fail-closed. */
            if (groupPid != null && pid === groupPid && signal === 0)
                return true;
            return realKill(pid, signal);
        });

        const started = Date.now();
        try {
            await expect(
                startWarmupCommand('sleep 10 & wait', 30, 80),
            ).rejects.toThrow(
                'Sandbox warmup process group did not exit within 80ms',
            );
            expect(Date.now() - started).toBeLessThan(2_000);
        } finally {
            restoreProcessKill();
            if (groupPid != null) {
                try {
                    realKill(groupPid, 'SIGKILL');
                } catch {
                    // The real group was already killed; only its probe was simulated.
                }
            }
        }
    });
});
