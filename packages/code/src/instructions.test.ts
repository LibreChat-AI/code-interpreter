import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryInstructions } from './instructions.js';
import { LocalWorkspaceTools } from './workspace.js';
import { isWorkspaceToolResult } from './protocol.js';
import { BridgeWorker } from './worker.js';

test('instruction discovery selects one fixed name and refuses symlink fallback', async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'repository-instructions-')),
    );
    try {
        await writeFile(join(root, 'CLAUDE.md'), 'fallback\n');
        assert.equal(
            (await readRepositoryInstructions(root))?.content,
            'fallback\n',
        );
        await writeFile(join(root, 'AGENTS.md'), 'preferred\n');
        assert.equal(
            (await readRepositoryInstructions(root))?.content,
            'preferred\n',
        );
        await rm(join(root, 'AGENTS.md'));
        await symlink(join(root, 'CLAUDE.md'), join(root, 'AGENTS.md'));
        assert.equal(await readRepositoryInstructions(root), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('registration refreshes instruction metadata without changing the worker incarnation', async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'repository-instructions-')),
    );
    try {
        await writeFile(join(root, 'AGENTS.md'), 'first');
        const tools = await LocalWorkspaceTools.create({
            workspaces: [{ id: 'primary', root }],
            repositoryInstructions: true,
        });
        const registrations: Array<{
            incarnationId: string;
            capabilities: {
                workspaceTools: {
                    workspaces: Array<{
                        instructions?: Array<{ sha256: string }>;
                    }>;
                };
            };
        }> = [];
        const worker = new BridgeWorker({
            codeApiUrl: 'https://code.example/v1',
            token: 'test',
            workerId: 'vm-1',
            incarnationId: 'incarnation-00000001',
            sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
            capabilities: {
                statefulWorkspace: false,
                sandboxProfile: 'test',
                runtimes: [],
                workspaceTools: tools.capabilities,
            },
            workspaceTools: tools,
            instructionDescriptors: () => tools.instructionDescriptors(),
            fetchImpl: async (_url, init) => {
                registrations.push(JSON.parse(String(init?.body)));
                return Response.json({
                    protocolVersion: 1,
                    workerId: 'vm-1',
                    incarnationId: 'incarnation-00000001',
                    registeredAt: new Date().toISOString(),
                    leaseTtlMs: 60000,
                    supportedWorkspaceToolOperations: [
                        'read_file',
                        'search_text',
                        'list_files',
                    ],
                    supportedWorkspaceListFileFeatures: ['after_path'],
                });
            },
        });
        await worker.register();
        const first =
            registrations.at(-1)!.capabilities.workspaceTools.workspaces[0]
                .instructions![0].sha256;
        await writeFile(join(root, 'AGENTS.md'), 'second');
        await worker.register();
        assert.notEqual(
            registrations.at(-1)!.capabilities.workspaceTools.workspaces[0]
                .instructions![0].sha256,
            first,
        );
        assert.ok(
            registrations.every(
                item => item.incarnationId === 'incarnation-00000001',
            ),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('bounded UTF-8 snapshots refresh and hash-fence authorized reads', async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'repository-instructions-')),
    );
    try {
        await writeFile(join(root, 'AGENTS.md'), 'a'.repeat(32767) + '🙂tail');
        const snapshot = await readRepositoryInstructions(root);
        assert.equal(snapshot?.descriptor.truncated, true);
        assert.equal(snapshot?.descriptor.bytes, 32767);
        const tools = await LocalWorkspaceTools.create({
            workspaces: [{ id: 'primary', root }],
            repositoryInstructions: true,
        });
        const request = {
            protocolVersion: 1 as const,
            operation: 'read_file' as const,
            workspaceId: 'primary',
            path: 'AGENTS.md',
            instructionSha256: snapshot!.descriptor.sha256,
        };
        const result = await tools.execute(request);
        assert.equal(isWorkspaceToolResult(request, result), true);
        assert.equal(isWorkspaceToolResult(request, { ...result, content: 'forged', endLine: 1 }), false);
        assert.equal(
            (await tools.instructionDescriptors())?.get('primary')?.[0]?.sha256,
            snapshot?.descriptor.sha256,
        );
        await writeFile(join(root, 'AGENTS.md'), 'new instructions\n');
        await assert.rejects(
            tools.execute(request),
            /changed or are unavailable/,
        );
        assert.notEqual(
            (await tools.instructionDescriptors())?.get('primary')?.[0]?.sha256,
            snapshot?.descriptor.sha256,
        );
        const disabled = await LocalWorkspaceTools.create({
            workspaces: [{ id: 'primary', root }],
        });
        assert.equal(await disabled.instructionDescriptors(), undefined);
        await assert.rejects(disabled.execute(request));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an older bridge can reject metadata without breaking later registrations', async () => {
    let metadataRequests = 0;
    let accepted = 0;
    const capabilities = {
        protocolVersion: 1 as const,
        operations: ['read_file' as const],
        workspaces: [{ id: 'primary', name: 'Primary' }],
    };
    const worker = new BridgeWorker({
        codeApiUrl: 'https://code.example/v1',
        token: 'test',
        workerId: 'vm-1',
        incarnationId: 'incarnation-00000001',
        sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
        capabilities: {
            statefulWorkspace: false,
            sandboxProfile: 'test',
            runtimes: [],
            workspaceTools: capabilities,
        },
        workspaceTools: {
            capabilities,
            execute: async () => {
                throw new Error('not expected');
            },
        },
        instructionDescriptors: async () => new Map([['primary', []]]),
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            if (
                body.capabilities.workspaceTools?.workspaces[0].instructions !==
                undefined
            ) {
                metadataRequests++;
                return Response.json(
                    { error: 'Unknown workspace field' },
                    { status: 400 },
                );
            }
            accepted++;
            return Response.json({
                protocolVersion: 1,
                workerId: 'vm-1',
                incarnationId: 'incarnation-00000001',
                registeredAt: new Date().toISOString(),
                leaseTtlMs: 60000,
                supportedWorkspaceToolOperations: ['read_file'],
            });
        },
    });
    await worker.register();
    await worker.register();
    assert.equal(metadataRequests, 1);
    assert.ok(accepted >= 2);
});
