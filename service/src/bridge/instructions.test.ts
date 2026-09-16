import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import express from 'express';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { BridgeWorker } from '../../../packages/code/src/worker';
import { LocalWorkspaceTools } from '../../../packages/code/src/workspace';
import { applyPrincipal } from '../auth/principal';
import { createWorkspaceToolsRouter } from '../workspace-tools/router';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';
import { RedisBridgePairingStore } from './pairing';

test('repository snapshots traverse the HTTP bridge and real workspace executor', async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'instruction-http-')),
    );
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisBridgeStore(redis);
    const controller = new AbortController();
    const app = express();
    app.use(express.json());
    app.use(
        '/v1/bridge',
        createBridgeRouter({
            store,
            pairings: new RedisBridgePairingStore(redis),
            authMode: 'static',
            adminToken: 'local-test-only',
            configuredWorkerId: 'instructions-worker',
        }),
    );
    app.use(
        '/v1',
        (req, _res, next) => {
            applyPrincipal(req, {
                userId: 'test-user',
                tenantId: 'test-tenant',
                principalSource: 'librechat_jwt',
            });
            next();
        },
        createWorkspaceToolsRouter({
            backend: 'remote-bridge',
            configuredWorkerId: 'instructions-worker',
            dynamicWorkers: false,
            store,
        }),
    );
    const server = createServer(app);
    let running: Promise<void> | undefined;
    try {
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Missing address');
        const base = `http://127.0.0.1:${address.port}/v1`;
        await writeFile(
            join(root, 'AGENTS.md'),
            'Exact\r\nrepository guidance\n',
        );
        const tools = await LocalWorkspaceTools.create({
            workspaces: [{ id: 'primary', root }],
            repositoryInstructions: true,
        });
        const worker = new BridgeWorker({
            codeApiUrl: base,
            token: 'local-test-only',
            workerId: 'instructions-worker',
            sandboxEndpoint: 'http://127.0.0.1:1/api/v2',
            leaseWaitMs: 50,
            capabilities: {
                statefulWorkspace: false,
                sandboxProfile: 'test',
                runtimes: [],
                workspaceTools: tools.capabilities,
            },
            workspaceTools: tools,
            instructionDescriptors: () => tools.instructionDescriptors(),
        });
        await worker.register();
        const status = await fetch(
            `${base}/bridge/workers/instructions-worker/status`,
            { headers: { Authorization: 'Bearer local-test-only' } },
        ).then(r => r.json());
        const descriptor =
            status.capabilities.workspaceTools.workspaces[0].instructions[0];
        expect(descriptor.path).toBe('AGENTS.md');
        running = worker.run(controller.signal);
        const request = {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'AGENTS.md',
            instructionSha256: descriptor.sha256,
        };
        const read = () =>
            fetch(`${base}/workspace-tools/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });
        const response = await read();
        expect(response.status).toBe(200);
        expect((await response.json()).content).toBe(
            'Exact\r\nrepository guidance\n',
        );
        await writeFile(join(root, 'AGENTS.md'), 'changed');
        expect((await read()).status).toBe(422);
    } finally {
        controller.abort();
        await running;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        redis.disconnect();
        await rm(root, { recursive: true, force: true });
    }
}, 10000);
