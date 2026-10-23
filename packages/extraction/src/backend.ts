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
        const child = spawn(
            this.runtime.guard,
            [job, this.runtime.python, this.runtime.worker, mode],
            {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {},
            }
        );
        let output = '';
        let count = 0;
        let overflow = false;
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
        child.stdout.on('data', (chunk: Buffer) => {
            count += chunk.length;
            if (count > 1024) {
                overflow = true;
                kill();
            } else output += chunk.toString('ascii');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            count += chunk.length;
            if (count > 2048) {
                overflow = true;
                kill();
            }
        });
        const code = await new Promise<number | null>(resolve =>
            child.once('close', resolve)
        );
        signal.removeEventListener('abort', kill);
        signal.throwIfAborted();
        if (spawnError || overflow) throw new ExtractionError('UNAVAILABLE');
        if (code !== 0) {
            const value = output.trim();
            if (parserErrors.has(value))
                throw new ExtractionError(value as 'INVALID_DOCUMENT');
            throw new ExtractionError(
                code === null ? 'RESOURCE_LIMIT' : 'UNAVAILABLE'
            );
        }
        return output;
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
            constants.O_RDONLY | constants.O_NOFOLLOW
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
            const bytes = await file.readFile();
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
