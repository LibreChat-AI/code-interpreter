import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    WorkspaceRootAccess,
    withWorkspaceRoot,
    open,
    realpath,
    stat,
    lstat,
    rename,
    link,
    unlink,
    spawn,
} from './root-access.js';
import { LocalWorkspaceTools } from './workspace.js';
import type { WorkspaceToolRequest } from './protocol.js';

test('search-only directories support known files and command cwd without enumeration', async t => {
    if (process.getuid?.() === 0)
        return t.skip(
            'requires an unprivileged user to verify search permissions',
        );
    const root = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'root-search-')),
    );
    const nested = join(root, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(join(nested, 'known'), 'known-value');
    const identity = await fs.stat(root, { bigint: true });
    t.after(async () => {
        await fs.chmod(root, 0o700);
        await fs.chmod(nested, 0o700);
        await fs.rm(root, { recursive: true, force: true });
    });
    await fs.chmod(root, 0o111);
    await fs.chmod(nested, 0o111);
    await assert.rejects(fs.readdir(nested), { code: 'EACCES' });
    await withWorkspaceRoot(
        root,
        { path: root, dev: String(identity.dev), ino: String(identity.ino) },
        async () => {
            const reader = await open(join(nested, 'known'), 'r');
            try {
                assert.equal(await reader.readFile('utf8'), 'known-value');
            } finally {
                await reader.close();
            }
            assert.equal((await stat(nested)).isDirectory(), true);
            assert.equal(await realpath(nested), nested);
            await new Promise<void>((accept, reject) => {
                const child = spawn('/bin/cat', ['known'], { cwd: nested });
                let output = '';
                child.stdout!.on('data', chunk => {
                    output += chunk.toString();
                });
                child.once('error', reject);
                child.once('close', code => {
                    try {
                        assert.equal(code, 0);
                        assert.equal(output, 'known-value');
                        accept();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },
    );
});

test('held roots allow internal directory links and reject external ancestors', async t => {
    const directory = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'root-links-')),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const root = join(directory, 'root');
    await fs.mkdir(join(root, 'nested'), { recursive: true });
    await fs.mkdir(join(directory, 'outside'));
    await fs.writeFile(join(root, 'nested', 'value'), 'inside');
    await fs.symlink('nested', join(root, 'inside'));
    await fs.symlink('../outside', join(root, 'outside'));
    const identity = await fs.stat(root, { bigint: true });
    const originalOpen = WorkspaceRootAccess.open;
    let held: WorkspaceRootAccess | undefined;
    t.mock.method(
        WorkspaceRootAccess,
        'open',
        async (...args: Parameters<typeof originalOpen>) => {
            held = await originalOpen(...args);
            return held;
        },
    );
    await withWorkspaceRoot(
        root,
        { path: root, dev: String(identity.dev), ino: String(identity.ino) },
        async () => {
            assert.equal(
                (await lstat(join(root, 'inside'))).isSymbolicLink(),
                true,
            );
            const reader = await open(join(root, 'inside', 'value'), 'r');
            try {
                assert.equal(await reader.readFile('utf8'), 'inside');
            } finally {
                await reader.close();
            }
            await assert.rejects(
                open(
                    join(root, 'outside', 'escape'),
                    constants.O_CREAT | constants.O_WRONLY,
                    0o600,
                ),
                { code: 'EACCES' },
            );
        },
    );
    assert.equal(held?.handle.fd, -1);
    assert.deepEqual(await fs.readdir(join(directory, 'outside')), []);
});

test('held root file operations cannot be redirected by replacing its pathname', async () => {
    const directory = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'root-access-')),
    );
    const root = join(directory, 'project');
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'original'), 'original');
    const identity = await fs.stat(root, { bigint: true });
    try {
        await withWorkspaceRoot(
            root,
            {
                path: root,
                dev: String(identity.dev),
                ino: String(identity.ino),
            },
            async () => {
                await fs.rename(root, `${root}.old`);
                await fs.mkdir(root);
                await fs.writeFile(join(root, 'original'), 'replacement');
                assert.equal(
                    await realpath(join(root, 'original')),
                    join(root, 'original'),
                );
                assert.equal((await stat(root)).isDirectory(), true);
                assert.equal(
                    (await lstat(join(root, 'original'))).isFile(),
                    true,
                );
                const reader = await open(join(root, 'original'), 'r');
                try {
                    assert.equal(await reader.readFile('utf8'), 'original');
                } finally {
                    await reader.close();
                }
                const writer = await open(
                    join(root, 'new'),
                    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                    0o600,
                );
                try {
                    await writer.writeFile('new');
                    await writer.sync();
                } finally {
                    await writer.close();
                }
                await link(join(root, 'new'), join(root, 'linked'));
                await rename(join(root, 'new'), join(root, 'renamed'));
                await unlink(join(root, 'linked'));
                const child = spawn('/bin/sh', ['-c', 'cat original'], {
                    cwd: root,
                });
                let output = '';
                let error = '';
                child.stdout.on('data', chunk => {
                    output += chunk;
                });
                child.stderr.on('data', chunk => {
                    error += chunk;
                });
                child.stdin.end();
                const code = await new Promise(resolve =>
                    child.on('close', resolve),
                );
                assert.equal(code, 0, error);
                assert.equal(output, 'original');
            },
        );
        assert.equal(
            await fs.readFile(join(root, 'original'), 'utf8'),
            'replacement',
        );
        assert.equal(
            await fs.readFile(join(`${root}.old`, 'renamed'), 'utf8'),
            'new',
        );
        assert.deepEqual(await fs.readdir(root), ['original']);
        await assert.rejects(
            WorkspaceRootAccess.open(root, {
                path: root,
                dev: String(identity.dev),
                ino: String(identity.ino),
            }),
        );
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

for (const operation of [
    'read_file',
    'write_file',
    'edit_file',
    'list_files',
    'search_text',
    'instructions',
] as const) {
    test(`selected ${operation} stays bound when the root is replaced after acquisition`, async t => {
        const directory = await fs.realpath(
            await fs.mkdtemp(join(tmpdir(), 'root-caller-')),
        );
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const root = join(directory, 'project');
        await fs.mkdir(root);
        await fs.writeFile(join(root, 'original.txt'), 'original');
        await fs.writeFile(join(root, 'AGENTS.md'), 'Original instructions');
        const identity = await fs.stat(root, { bigint: true });
        const tools = await LocalWorkspaceTools.create({
            repositoryInstructions: true,
            workspaces: [
                {
                    id: 'selected',
                    root,
                    writable: true,
                    identity: {
                        path: root,
                        dev: String(identity.dev),
                        ino: String(identity.ino),
                    },
                },
            ],
        });
        const originalOpen = WorkspaceRootAccess.open;
        t.mock.method(
            WorkspaceRootAccess,
            'open',
            async (...args: Parameters<typeof originalOpen>) => {
                const access = await originalOpen(...args);
                await fs.rename(root, `${root}.old`);
                await fs.mkdir(root);
                await fs.writeFile(
                    join(root, 'replacement.txt'),
                    'replacement',
                );
                await fs.writeFile(
                    join(root, 'AGENTS.md'),
                    'Replacement instructions',
                );
                return access;
            },
        );
        if (operation === 'instructions') {
            const descriptors = await tools.instructionDescriptors();
            const { createHash } = await import('node:crypto');
            assert.equal(
                descriptors?.get('selected')?.[0].sha256,
                createHash('sha256')
                    .update('Original instructions')
                    .digest('hex'),
            );
        } else {
            const request = {
                protocolVersion: 1,
                workspaceId: 'selected',
                operation,
                ...(operation === 'write_file'
                    ? { path: 'new.txt', content: 'created', overwrite: false }
                    : {}),
                ...(operation === 'read_file' ? { path: 'original.txt' } : {}),
                ...(operation === 'edit_file'
                    ? {
                          path: 'original.txt',
                          oldText: 'original',
                          newText: 'edited',
                      }
                    : {}),
                ...(operation === 'search_text' ? { query: 'original' } : {}),
            } as WorkspaceToolRequest;
            const result = await tools.execute(request);
            assert.equal(
                JSON.stringify(result).includes('replacement.txt'),
                false,
            );
            if (operation === 'read_file')
                assert.equal(
                    (result as { content: string }).content,
                    'original',
                );
            if (operation === 'write_file')
                assert.equal(
                    await fs.readFile(join(`${root}.old`, 'new.txt'), 'utf8'),
                    'created',
                );
            if (operation === 'edit_file')
                assert.equal(
                    await fs.readFile(
                        join(`${root}.old`, 'original.txt'),
                        'utf8',
                    ),
                    'edited',
                );
        }
        assert.deepEqual((await fs.readdir(root)).sort(), [
            'AGENTS.md',
            'replacement.txt',
        ]);
    });
}

test('simultaneous roots retain independent descriptor contexts and release on failure', async t => {
    const directory = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'root-concurrency-')),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await Promise.all(
        ['a', 'b'].map(async name => {
            const root = join(directory, name);
            await fs.mkdir(root);
            await fs.writeFile(join(root, 'value'), name);
            const identity = await fs.stat(root, { bigint: true });
            await assert.rejects(
                withWorkspaceRoot(
                    root,
                    {
                        path: root,
                        dev: String(identity.dev),
                        ino: String(identity.ino),
                    },
                    async () => {
                        await fs.rename(root, `${root}.old`);
                        await fs.mkdir(root);
                        const file = await open(join(root, 'value'), 'r');
                        try {
                            assert.equal(await file.readFile('utf8'), name);
                        } finally {
                            await file.close();
                        }
                        throw new Error('cancelled request');
                    },
                ),
                /cancelled request/,
            );
        }),
    );
});
