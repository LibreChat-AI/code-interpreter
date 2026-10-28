import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExtractionError, policy, validateResult } from './protocol.js';
import type { Format } from './protocol.js';

export interface Backend {
    healthy: boolean;
    create(): Promise<string>;
    run(
        job: string,
        format: Format,
        digest: string,
        signal: AbortSignal
    ): Promise<Buffer>;
    cleanup(job: string): Promise<void>;
}
export interface Runtime {
    jobs: string;
    guard: string;
    python: string;
    worker: string;
}
const parserErrors = new Set([
    'INVALID_DOCUMENT',
    'EMPTY_OUTPUT',
    'OUTPUT_LIMIT',
    'DECOMPRESSION_LIMIT',
    'STRUCTURE_LIMIT',
    'ENCRYPTED_DOCUMENT',
    'UNSUPPORTED_ENCODING',
    'UNSUPPORTED_CONTENT',
    'RESOURCE_LIMIT',
]);
export class RestrictedBackend implements Backend {
    healthy = true;
    constructor(private readonly runtime: Runtime) {}
    async create(): Promise<string> {
        if (!this.healthy) throw new ExtractionError('UNAVAILABLE');
        return mkdtemp(join(this.runtime.jobs, 'job-'));
    }
    private async execute(
        job: string,
        mode: string,
        signal: AbortSignal
    ): Promise<string> {
        signal.throwIfAborted();
        const status = await open(
            join(job, 'status'),
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_RDWR,
            0o600
        );
        try {
            signal.throwIfAborted();
            const child = spawn(
                this.runtime.guard,
                [job, this.runtime.python, this.runtime.worker, mode],
                {
                    detached: true,
                    stdio: ['ignore', status.fd, 'ignore'],
                    env: {},
                }
            );
            const kill = () => {
                if (
                    child.pid &&
                    child.exitCode === null &&
                    child.signalCode === null
                ) {
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                            this.healthy = false;
                    }
                }
            };
            signal.addEventListener('abort', kill, { once: true });
            if (signal.aborted) kill();
            let spawnError = false;
            child.on('error', () => {
                spawnError = true;
            });
            const code = await new Promise<number | null>(resolve =>
                child.once('close', resolve)
            );
            signal.removeEventListener('abort', kill);
            signal.throwIfAborted();
            const stat = await status.stat();
            if (
                spawnError ||
                !stat.isFile() ||
                stat.nlink !== 1 ||
                stat.size > 1024
            )
                throw new ExtractionError('UNAVAILABLE');
            const buffer = Buffer.alloc(1025);
            const { bytesRead } = await status.read(
                buffer,
                0,
                buffer.length,
                0
            );
            if (bytesRead > 1024) throw new ExtractionError('UNAVAILABLE');
            const output = buffer.toString('ascii', 0, bytesRead);
            if (code !== 0) {
                const value = output.trim();
                if (parserErrors.has(value))
                    throw new ExtractionError(value as 'INVALID_DOCUMENT');
                throw new ExtractionError(
                    code === null ? 'RESOURCE_LIMIT' : 'UNAVAILABLE'
                );
            }
            return output;
        } finally {
            await status.close();
        }
    }
    async probe(): Promise<void> {
        const job = await this.create();
        try {
            const output = await this.execute(
                job,
                'probe',
                AbortSignal.timeout(policy.deadlineMs)
            );
            if (output.trim() !== 'READY')
                throw new ExtractionError('UNAVAILABLE');
        } finally {
            await this.cleanup(job);
        }
    }
    async run(
        job: string,
        format: Format,
        digest: string,
        signal: AbortSignal
    ): Promise<Buffer> {
        await this.execute(job, format, signal);
        const file = await open(
            join(job, 'result'),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
            const stat = await file.stat();
            if (
                !stat.isFile() ||
                stat.nlink !== 1 ||
                stat.size > policy.resultBytes
            ) {
                throw new ExtractionError('OUTPUT_LIMIT');
            }
            const buffer = Buffer.alloc(stat.size + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > policy.resultBytes)
                throw new ExtractionError('OUTPUT_LIMIT');
            const bytes = buffer.subarray(0, bytesRead);
            signal.throwIfAborted();
            validateResult(bytes, format, digest);
            return bytes;
        } finally {
            await file.close();
        }
    }
    async cleanup(job: string): Promise<void> {
        try {
            await rm(job, { recursive: true, force: true, maxRetries: 0 });
        } catch {
            this.healthy = false;
            throw new ExtractionError('UNAVAILABLE');
        }
    }
}

/** Used by focused worker tests, not by HTTP callers. */
export async function writeInput(job: string, input: Buffer): Promise<void> {
    await writeFile(join(job, 'input'), input, { flag: 'wx', mode: 0o600 });
}
