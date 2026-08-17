import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { logger } from './logger';
import { config } from './config';

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

let child: ChildProcess | undefined;
let starting: Promise<void> | undefined;

function proxyBundlePath(): string {
    return (
        process.env.TCS_PROXY_BUNDLE ??
        path.resolve(__dirname, '..', '.build', 'tool-call-socket-proxy.cjs')
    );
}

function proxySocketPath(): string {
    return process.env.TCS_SOCKET || '/tmp/tcs.sock';
}

function proxyOwner(): { uid: string; gid: string } {
    const runningAsRoot =
        typeof process.getuid === 'function' && process.getuid() === 0;
    return {
        uid: String(runningAsRoot ? 65534 : (process.getuid?.() ?? 65534)),
        gid: String(runningAsRoot ? 65534 : (process.getgid?.() ?? 65534)),
    };
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection(socketPath);
        let settled = false;
        const finish = (ready: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ready);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(100, () => finish(false));
    });
}

async function waitUntilReady(
    started: ChildProcess,
    socketPath: string,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (started.exitCode !== null || started.signalCode !== null) {
            throw new Error(
                `tool-call socket proxy exited before readiness` +
                    ` (code=${String(started.exitCode)}, signal=${String(started.signalCode)})`,
            );
        }
        if (await socketAcceptsConnections(socketPath)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(
        `tool-call socket proxy did not become ready within ${timeoutMs}ms`,
    );
}

async function launch(): Promise<void> {
    const rawTarget = process.env.SANDBOX_FORWARD_TARGET?.trim() ?? '';
    if (config.allowed_local_network_port <= 0 || !rawTarget) {
        throw new Error('tool-call socket proxy is not configured');
    }

    const socketPath = proxySocketPath();
    const owner = proxyOwner();
    const started = spawn(
        process.env.TCS_NODE_BINARY || 'node',
        [proxyBundlePath()],
        {
            env: {
                ...process.env,
                TCS_SOCKET: socketPath,
                TCS_SOCKET_UID: owner.uid,
                TCS_SOCKET_GID: owner.gid,
                SANDBOX_FORWARD_TARGET: rawTarget,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    child = started;
    let rejectSpawnFailure: (error: Error) => void;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
        rejectSpawnFailure = reject;
    });
    /* A failed spawn emits `error`; it does not reliably set exitCode or
     * signalCode. Without an immediate listener Node treats ENOENT/EACCES as an
     * uncaught event and crashes the runner instead of failing this execution. */
    started.on('error', error => {
        if (child === started) child = undefined;
        const launchError = new Error(
            `tool-call socket proxy failed to spawn: ${error.message}`,
            { cause: error },
        );
        logger.error({ error }, 'tool-call socket proxy spawn failed');
        rejectSpawnFailure(launchError);
    });
    started.stdout?.on('data', (chunk: Buffer) => {
        logger.debug(
            { proxy: chunk.toString().trim() },
            'tool-call socket proxy',
        );
    });
    started.stderr?.on('data', (chunk: Buffer) => {
        logger.warn(
            { proxy: chunk.toString().trim() },
            'tool-call socket proxy stderr',
        );
    });
    started.once('exit', (code, signal) => {
        if (child === started) {
            child = undefined;
        }
        if (code !== 0 && signal !== 'SIGTERM') {
            logger.error(
                { code, signal },
                'tool-call socket proxy exited unexpectedly',
            );
        }
    });

    try {
        await Promise.race([
            waitUntilReady(started, socketPath, START_TIMEOUT_MS),
            spawnFailure,
        ]);
        logger.info(
            { socketPath, target: rawTarget },
            'Tool-call socket proxy started after MicroVM restore',
        );
    } catch (error) {
        started.kill('SIGKILL');
        if (child === started) child = undefined;
        throw error;
    }
}

/**
 * Starts Node only when an authenticated execute actually receives the
 * tool-call socket capability. Lambda MicroVM image creation snapshots the
 * already-running container; starting Node in entrypoint would therefore clone
 * its embedded OpenSSL process state into every VM. Lazy initialization keeps
 * Node entirely on the post-restore side of that boundary.
 */
async function ensureToolCallSocketProxyReadyOnce(): Promise<void> {
    const socketPath = proxySocketPath();
    const running = child;
    if (running && running.exitCode === null && running.signalCode === null) {
        if (await socketAcceptsConnections(socketPath)) return;
        running.kill('SIGKILL');
        if (child === running) child = undefined;
    }
    await launch();
}

export async function ensureToolCallSocketProxyReady(): Promise<void> {
    /* Serialize the whole probe/relaunch transaction, not only spawn readiness.
     * Otherwise concurrent recovery callers can both await a failed socket probe,
     * then each kill/relaunch through the shared `child` slot. Publishing this
     * promise before the first probe await makes every follower join one attempt. */
    if (starting) {
        await starting;
        return;
    }
    const attempt = ensureToolCallSocketProxyReadyOnce();
    starting = attempt;
    try {
        await attempt;
    } finally {
        /* A successful launch must not leave a resolved promise cached forever:
         * if the socket later disappears while the process is still alive, the
         * next caller has to kill/relaunch rather than return false readiness. */
        if (starting === attempt) starting = undefined;
    }
}

export async function stopToolCallSocketProxy(): Promise<void> {
    const running = child;
    child = undefined;
    starting = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null)
        return;

    await new Promise<void>(resolve => {
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            running.kill('SIGKILL');
            finish();
        }, STOP_TIMEOUT_MS);
        running.once('exit', finish);
        running.kill('SIGTERM');
    });
}
