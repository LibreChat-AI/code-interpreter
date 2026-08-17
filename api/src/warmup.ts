import { spawn } from 'child_process';
import { logger } from './logger';

export type WarmupOutcome = 'skipped' | 'completed' | 'failed' | 'timed_out';

const WARMUP_REAP_TIMEOUT_MS = 5_000;
const WARMUP_REAP_POLL_MS = 10;

function processGroupExists(pid: number): boolean {
    if (process.platform === 'win32') return false;
    try {
        process.kill(-pid, 0);
        return true;
    } catch (err) {
        /* ESRCH is the only positive evidence that the whole process group is
         * gone. EPERM and unexpected probe failures must fail closed: resolving
         * startup in those cases could snapshot a surviving warmup descendant. */
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function waitForWarmupReap(
    pid: number | undefined,
    childExited: () => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadlineAt = Date.now() + timeoutMs;
    for (;;) {
        const groupGone = pid == null || !processGroupExists(pid);
        if (childExited() && groupGone) return;

        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
            throw new Error(
                `Sandbox warmup process group did not exit within ${timeoutMs}ms`,
            );
        }
        await new Promise(resolve =>
            setTimeout(resolve, Math.min(WARMUP_REAP_POLL_MS, remainingMs)),
        );
    }
}

/**
 * Bounded warmup command run once at sandbox-API startup, OUTSIDE any job
 * sandbox and before the HTTP listener becomes ready.
 *
 * Purpose: pre-fault large read-mostly assets into the VM's page cache before
 * the first real job needs them. MicroVM rootfs reads are lazy and slow on
 * first touch, so a heavyweight import (e.g. chdb's ~400MB shared object) can
 * take 30-120s cold but milliseconds warm — a boot-time
 * `SANDBOX_WARMUP_COMMAND="/pkgs/python/3.14.4/bin/python3 -c 'import chdb'"`
 * moves that cost into the boot window instead of racing the user's first job.
 *
 * Command failures stay best-effort (logged, then startup continues), but
 * completion is awaited and bounded. A timed-out process group that cannot be
 * proven gone is fatal: this is important for Lambda MicroVM images, where
 * snapshotting a still-running detached warmup would clone that process into
 * every VM and would not guarantee warm state before the endpoint became
 * reachable.
 */
export async function startWarmupCommand(
    command = process.env.SANDBOX_WARMUP_COMMAND,
    timeoutMs = Number(process.env.SANDBOX_WARMUP_TIMEOUT_MS) || 180_000,
    reapTimeoutMs = WARMUP_REAP_TIMEOUT_MS,
): Promise<WarmupOutcome> {
    if (command == null || command.trim() === '') {
        return 'skipped';
    }
    const boundedTimeoutMs =
        Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.floor(timeoutMs)
            : 180_000;
    const boundedReapTimeoutMs =
        Number.isFinite(reapTimeoutMs) && reapTimeoutMs > 0
            ? Math.floor(reapTimeoutMs)
            : WARMUP_REAP_TIMEOUT_MS;
    const startedAt = Date.now();
    return new Promise<WarmupOutcome>((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let childExited = false;
        let exitCode: number | null | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let groupPollTimer: ReturnType<typeof setTimeout> | undefined;
        const clearTimers = (): void => {
            if (timer) clearTimeout(timer);
            if (groupPollTimer) clearTimeout(groupPollTimer);
        };
        const finish = (
            outcome: WarmupOutcome,
            code?: number | null,
            err?: unknown,
        ): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            const details = {
                command,
                code,
                elapsedMs: Date.now() - startedAt,
                err,
            };
            if (outcome === 'completed')
                logger.info(details, 'Sandbox warmup command finished');
            else
                logger.warn(
                    details,
                    `Sandbox warmup command ${outcome.replace('_', ' ')}`,
                );
            resolve(outcome);
        };
        const failStartup = (err: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            logger.error(
                { command, elapsedMs: Date.now() - startedAt, err },
                'Sandbox warmup process group could not be reaped',
            );
            reject(err);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn('bash', ['-c', command], {
                detached: true,
                stdio: 'ignore',
            });
        } catch (err) {
            finish('failed', undefined, err);
            return;
        }
        const finishAfterProcessGroupExit = (): void => {
            if (settled || timedOut || !childExited) return;
            if (child.pid == null || !processGroupExists(child.pid)) {
                finish(exitCode === 0 ? 'completed' : 'failed', exitCode);
                return;
            }
            /* A shell may exit successfully after backgrounding a descendant. Keep
             * the original warmup deadline active and do not advertise readiness
             * until its entire detached process group has gone. */
            groupPollTimer = setTimeout(
                finishAfterProcessGroupExit,
                WARMUP_REAP_POLL_MS,
            );
        };
        child.once('exit', code => {
            childExited = true;
            exitCode = code;
            finishAfterProcessGroupExit();
        });
        child.once('error', err => {
            if (!timedOut) finish('failed', undefined, err);
        });
        timer = setTimeout(() => {
            timedOut = true;
            if (groupPollTimer) clearTimeout(groupPollTimer);
            try {
                if (child.pid != null && process.platform !== 'win32') {
                    process.kill(-child.pid, 'SIGKILL');
                } else {
                    child.kill('SIGKILL');
                }
            } catch {
                child.kill('SIGKILL');
            }
            /* kill(2) only queues SIGKILL. Keep startup unready until Node has
             * reaped the direct child and POSIX confirms that no descendant remains
             * in its detached process group. If that cannot be proven within the
             * secondary bound, fail startup instead of snapshotting a live warmup. */
            void waitForWarmupReap(
                child.pid,
                () => childExited,
                boundedReapTimeoutMs,
            ).then(() => finish('timed_out', exitCode), failStartup);
        }, boundedTimeoutMs);
        logger.info(
            { command, timeoutMs: boundedTimeoutMs },
            'Sandbox warmup command started',
        );
    });
}
