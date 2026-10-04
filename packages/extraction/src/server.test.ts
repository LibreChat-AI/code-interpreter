import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { test } from 'node:test';
import { extractionServer } from './server.js';
import { ExtractionError, policy } from './protocol.js';
import type { Backend } from './backend.js';

async function fixture(deadline = 500) {
    const root = await mkdtemp(join(tmpdir(), 'extraction-test-'));
    const events: string[] = [];
    const backend: Backend = {
        healthy: true,
        create: async () => {
            events.push('create');
            return mkdtemp(join(root, 'job-'));
        },
        run: async () => {
            events.push('run');
            return Buffer.from('{"segments":[]}');
        },
        cleanup: async job => {
            events.push('cleanup');
            await rm(job, { recursive: true });
        },
    };
    const server = extractionServer(backend, deadline);
    const socketPath = join(root, 'service.sock');
    server.listen(socketPath);
    await once(server, 'listening');
    return {
        backend,
        events,
        root,
        socketPath,
        server,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        },
    };
}
const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': '4',
    'X-Extraction-Version': '1',
    'X-Extraction-Format': 'pdf',
};
async function send(
    socketPath: string,
    overrides = {},
    path = '/v1/extract-text'
) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
            {
                socketPath,
                path,
                method: 'POST',
                headers: { ...headers, ...overrides },
            },
            res => {
                let body = '';
                res.on('data', bytes => {
                    body += bytes;
                });
                res.on('end', () => resolve({ status: res.statusCode!, body }));
            }
        );
        req.on('error', reject);
        req.end('test');
    });
}
test('binary upload executes once and cleanup completes before success', async () => {
    const f = await fixture();
    try {
        assert.equal((await send(f.socketPath)).status, 200);
        assert.deepEqual(f.events, ['create', 'run', 'cleanup']);
        assert.deepEqual(await readdir(f.root), ['service.sock']);
    } finally {
        await f.close();
    }
});
test('closed parameters and declared input limit are rejected before admission', async () => {
    const f = await fixture();
    try {
        for (const changes of [
            { 'X-Extraction-Format': 'xls' },
            { 'X-Extraction-Version': '2' },
            { 'X-Extraction-Url': 'https://example.com' },
            { 'Content-Type': 'text/plain' },
        ]) {
            assert.equal((await send(f.socketPath, changes)).status, 400);
        }
        assert.equal(
            (await send(f.socketPath, {}, '/v1/extract-text?path=x')).status,
            404
        );
        assert.equal(
            (
                await send(f.socketPath, {
                    'Content-Length': String(policy.inputBytes + 1),
                })
            ).status,
            413
        );
        assert.equal(f.events.length, 0);
    } finally {
        await f.close();
    }
});
test('cleanup failure suppresses success and quarantines backend', async () => {
    const f = await fixture();
    f.backend.cleanup = async () => {
        f.backend.healthy = false;
        throw new ExtractionError('UNAVAILABLE');
    };
    try {
        assert.equal((await send(f.socketPath)).status, 503);
        assert.equal((await send(f.socketPath)).status, 503);
        assert.equal(f.events.filter(e => e === 'run').length, 1);
    } finally {
        await f.close();
    }
});
test('deadline aborts execution and waits for its close before cleanup', async () => {
    const f = await fixture(50);
    f.backend.run = async (_job, _format, _digest, signal) => {
        await new Promise<void>(resolve =>
            signal.addEventListener(
                'abort',
                () => {
                    setTimeout(() => {
                        f.events.push('closed');
                        resolve();
                    }, 15);
                },
                { once: true }
            )
        );
        signal.throwIfAborted();
        return Buffer.alloc(0);
    };
    try {
        assert.equal((await send(f.socketPath)).status, 504);
        assert.deepEqual(f.events, ['create', 'closed', 'cleanup']);
    } finally {
        await f.close();
    }
});
test('upload disconnect and stalled upload both release scratch and admission', async () => {
    const f = await fixture(60);
    try {
        for (const disconnect of [true, false]) {
            const req = request({
                socketPath: f.socketPath,
                path: '/v1/extract-text',
                method: 'POST',
                headers,
            });
            req.on('error', () => {});
            req.flushHeaders();
            req.write('t');
            await new Promise(resolve => setTimeout(resolve, 20));
            if (disconnect) req.destroy();
            await new Promise(resolve => setTimeout(resolve, 80));
            assert.deepEqual(await readdir(f.root), ['service.sock']);
        }
        assert.equal(f.events.includes('run'), false);
        assert.equal((await send(f.socketPath)).status, 200);
    } finally {
        await f.close();
    }
});
test('two active jobs bound concurrency without a queue', async () => {
    const f = await fixture(200);
    let active = 0;
    f.backend.run = async (_job, _format, _digest, signal) => {
        active++;
        await new Promise<void>(resolve =>
            signal.addEventListener('abort', () => resolve(), { once: true })
        );
        signal.throwIfAborted();
        return Buffer.alloc(0);
    };
    try {
        const a = send(f.socketPath),
            b = send(f.socketPath);
        while (active !== 2)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal((await send(f.socketPath)).status, 429);
        assert.equal((await a).status, 504);
        assert.equal((await b).status, 504);
    } finally {
        await f.close();
    }
});
test('deadline closes stalled output readers while keeping their slots admitted', async () => {
    const f = await fixture(250);
    f.backend.run = async () => Buffer.alloc(policy.resultBytes, 'a');
    const clients = [0, 1].map(() => {
        const req = request(
            {
                socketPath: f.socketPath,
                path: '/v1/extract-text',
                method: 'POST',
                headers,
            },
            res => {
                res.pause();
                res.on('error', () => {});
            }
        );
        req.on('error', () => {});
        req.end('test');
        return req;
    });
    try {
        while (f.events.filter(e => e === 'cleanup').length !== 2)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal((await send(f.socketPath)).status, 429);
        await new Promise(resolve => setTimeout(resolve, 300));
        f.backend.run = async () => Buffer.from('{}');
        assert.equal((await send(f.socketPath)).status, 200);
    } finally {
        clients.forEach(client => client.destroy());
        await f.close();
    }
});
test('duplicate extraction control headers are rejected before worker creation', async () => {
    const f = await fixture();
    try {
        assert.equal(
            (
                await send(f.socketPath, {
                    'X-Extraction-Format': ['pdf', 'pdf'],
                })
            ).status,
            400
        );
        assert.equal(f.events.length, 0);
    } finally {
        await f.close();
    }
});
