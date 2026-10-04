import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ExtractionError, policy } from './protocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Backend } from './backend.js';
import type { Format } from './protocol.js';

export const capabilities = Object.freeze({
    version: 1,
    operation: 'document.extract-text',
    formats: ['pdf', 'docx'],
    structure: {
        pdf: 'ordered pages, one-based index',
        docx: 'document body, paragraphs and tables',
    },
    limits: {
        ...policy,
        concurrency: 2,
        expandedBytes: 32 * 1024 * 1024,
        archiveEntries: 512,
    },
});
const status = (code: string): number => {
    if (code === 'BUSY') return 429;
    if (code === 'UNAVAILABLE') return 503;
    if (code === 'DEADLINE') return 504;
    if (
        code === 'INPUT_LIMIT' ||
        code === 'OUTPUT_LIMIT' ||
        code === 'DECOMPRESSION_LIMIT' ||
        code === 'STRUCTURE_LIMIT'
    )
        return 413;
    if (code === 'INVALID_REQUEST') return 400;
    return 422;
};
function reply(res: ServerResponse, code: number, bytes: Buffer): void {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bytes.length,
        Connection: 'close',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
}
function requestFormat(req: IncomingMessage): Format {
    const seen = new Set<string>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!.toLowerCase();
        if (
            name.startsWith('x-extraction-') &&
            !['x-extraction-version', 'x-extraction-format'].includes(name)
        ) {
            throw new ExtractionError('INVALID_REQUEST');
        }
        if (
            [
                'content-length',
                'content-type',
                'x-extraction-version',
                'x-extraction-format',
            ].includes(name)
        ) {
            if (seen.has(name)) throw new ExtractionError('INVALID_REQUEST');
            seen.add(name);
        }
    }
    if (
        req.headers['content-type'] !== 'application/octet-stream' ||
        req.headers['x-extraction-version'] !== '1' ||
        req.headers['transfer-encoding']
    ) {
        throw new ExtractionError('INVALID_REQUEST');
    }
    const format = req.headers['x-extraction-format'];
    if (format !== 'pdf' && format !== 'docx')
        throw new ExtractionError('INVALID_REQUEST');
    const length = req.headers['content-length'];
    if (typeof length !== 'string' || !/^[1-9]\d*$/.test(length))
        throw new ExtractionError('INVALID_REQUEST');
    if (
        !Number.isSafeInteger(Number(length)) ||
        Number(length) > policy.inputBytes
    )
        throw new ExtractionError('INPUT_LIMIT');
    return format;
}
export function extractionServer(
    backend: Backend,
    deadlineMs: number = policy.deadlineMs
) {
    if (
        !Number.isInteger(deadlineMs) ||
        deadlineMs <= 0 ||
        deadlineMs > policy.deadlineMs
    )
        throw new Error('INVALID_DEADLINE');
    let admitted = 0;
    const server = createServer(
        {
            maxHeaderSize: 4096,
            requireHostHeader: true,
            connectionsCheckingInterval: 1000,
        },
        (req, res) => {
            void handle(req, res);
        }
    );
    server.maxConnections = 16;
    server.maxRequestsPerSocket = 1;
    server.headersTimeout = 5000;
    server.requestTimeout = policy.deadlineMs;
    server.setTimeout(policy.deadlineMs, socket => socket.destroy());
    server.on('checkContinue', (req, res) => {
        reply(res, 400, Buffer.from('{"error":{"code":"INVALID_REQUEST"}}'));
    });
    async function handle(
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> {
        if (req.method === 'GET' && req.url === '/v1/capabilities') {
            reply(
                res,
                backend.healthy ? 200 : 503,
                Buffer.from(JSON.stringify(capabilities))
            );
            return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/extract-text') {
            reply(
                res,
                404,
                Buffer.from('{"error":{"code":"INVALID_REQUEST"}}')
            );
            return;
        }
        let format: Format;
        try {
            format = requestFormat(req);
        } catch (error) {
            const code =
                error instanceof ExtractionError
                    ? error.code
                    : 'INVALID_REQUEST';
            reply(
                res,
                status(code),
                Buffer.from(JSON.stringify({ error: { code } }))
            );
            return;
        }
        if (!backend.healthy || admitted >= 2) {
            const code = backend.healthy ? 'BUSY' : 'UNAVAILABLE';
            reply(
                res,
                status(code),
                Buffer.from(JSON.stringify({ error: { code } }))
            );
            return;
        }
        admitted++;
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(new ExtractionError('DEADLINE')),
            deadlineMs
        );
        const aborted = () =>
            controller.abort(new ExtractionError('CANCELLED'));
        controller.signal.addEventListener(
            'abort',
            () => {
                if (!req.complete) req.destroy();
                if (res.headersSent) res.destroy();
            },
            { once: true }
        );
        req.once('aborted', aborted);
        res.once('close', () => {
            if (!res.writableFinished) aborted();
        });
        const delivered = new Promise<void>(resolve => {
            res.once('finish', resolve);
            res.once('close', resolve);
        });
        let job: string | undefined;
        let bytes: Buffer | undefined;
        let failure: unknown;
        try {
            controller.signal.throwIfAborted();
            job = await backend.create();
            const file = await open(join(job, 'input'), 'wx', 0o600);
            const digest = createHash('sha256');
            let size = 0;
            try {
                for await (const chunk of req) {
                    controller.signal.throwIfAborted();
                    size += chunk.length;
                    if (size > policy.inputBytes)
                        throw new ExtractionError('INPUT_LIMIT');
                    digest.update(chunk);
                    await file.writeFile(chunk);
                }
            } finally {
                await file.close();
            }
            if (size !== Number(req.headers['content-length']))
                throw new ExtractionError('INVALID_REQUEST');
            controller.signal.throwIfAborted();
            bytes = await backend.run(
                job,
                format,
                digest.digest('hex'),
                controller.signal
            );
        } catch (error) {
            failure = error;
        } finally {
            if (job) {
                try {
                    await backend.cleanup(job);
                } catch (error) {
                    failure = error;
                }
            }
        }
        try {
            if (controller.signal.aborted && !failure)
                failure = controller.signal.reason;
            if (controller.signal.reason instanceof ExtractionError)
                failure = controller.signal.reason;
            if (!res.destroyed) {
                if (failure || !bytes) {
                    const code =
                        failure instanceof ExtractionError
                            ? failure.code
                            : 'UNAVAILABLE';
                    reply(
                        res,
                        status(code),
                        Buffer.from(JSON.stringify({ error: { code } }))
                    );
                } else reply(res, 200, bytes);
            }
            await delivered;
        } finally {
            clearTimeout(timeout);
            req.removeListener('aborted', aborted);
            admitted--;
        }
    }
    return server;
}
