import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
    mkdtemp,
    mkdir,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadProjectRoots, projectRootArguments } from './project-roots.js';
import { LocalWorkspaceTools } from './workspace.js';
import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';
import type { BridgeWorkerCapabilities } from './protocol.js';
import { WorkspaceRootAccess } from './root-access.js';

const exec = promisify(execFile);
test('admission validates the captured root even while a replacement checkout occupies its path', async t => {
    const root = await fixture(t);
    const selected = join(root, 'app');
    await writeFile(
        join(selected, '.git/commondir'),
        '../../nested/api/.git\n',
    );
    const originalOpen = WorkspaceRootAccess.open;
    t.mock.method(
        WorkspaceRootAccess,
        'open',
        async (...args: Parameters<typeof originalOpen>) => {
            const held = await originalOpen(...args);
            await rename(selected, `${selected}-original`);
            await exec('git', ['init', '--initial-branch=dev', selected]);
            const originalClose = held.close.bind(held);
            held.close = async () => {
                await rm(selected, { recursive: true, force: true });
                await rename(`${selected}-original`, selected);
                await originalClose();
            };
            return held;
        },
    );
    await assert.rejects(
        loadProjectRoots(root, ['app']),
        /Git common directory/,
    );
    assert.equal(
        await readFile(join(selected, '.git/commondir'), 'utf8'),
        '../../nested/api/.git\n',
    );
});

test('admission cannot borrow a replacement checkout Git validity', async t => {
    const root = await fixture(t);
    const selected = join(root, 'app');
    await rm(join(selected, '.git/HEAD'));
    const originalOpen = WorkspaceRootAccess.open;
    t.mock.method(
        WorkspaceRootAccess,
        'open',
        async (...args: Parameters<typeof originalOpen>) => {
            const held = await originalOpen(...args);
            await rename(selected, `${selected}-original`);
            await exec('git', ['init', '--initial-branch=dev', selected]);
            const originalClose = held.close.bind(held);
            held.close = async () => {
                await rm(selected, { recursive: true, force: true });
                await rename(`${selected}-original`, selected);
                await originalClose();
            };
            return held;
        },
    );
    await assert.rejects(
        loadProjectRoots(root, ['app']),
        /standalone Git checkout/,
    );
});
test(
    'real worker CLI registers only explicitly selected project roots',
    { timeout: 10000 },
    async t => {
        const root = await fixture(t);
        let accept: (capabilities: BridgeWorkerCapabilities) => void = () => {};
        const registered = new Promise<BridgeWorkerCapabilities>(resolve => {
            accept = resolve;
        });
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                response.setHeader('Content-Type', 'application/json');
                if (request.url?.endsWith('/bridge/workers/register')) {
                    const body = JSON.parse(
                        Buffer.concat(chunks).toString(),
                    ) as {
                        workerId: string;
                        incarnationId: string;
                        capabilities: BridgeWorkerCapabilities;
                    };
                    accept(body.capabilities);
                    response.end(
                        JSON.stringify({
                            protocolVersion: 1,
                            workerId: body.workerId,
                            incarnationId: body.incarnationId,
                            registeredAt: new Date().toISOString(),
                            leaseTtlMs: 60000,
                        }),
                    );
                } else
                    response.end(
                        JSON.stringify({
                            protocolVersion: 1,
                            serverElapsedMs: 0,
                        }),
                    );
            });
        });
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const child = spawn(
            process.execPath,
            [
                fileURLToPath(new URL('./cli.js', import.meta.url)),
                'run',
                '--project-root',
                root,
                '--project',
                'app',
                '--project',
                'nested/api',
            ],
            {
                env: {
                    PATH: process.env.PATH,
                    LIBRECHAT_CODE_URL: `http://127.0.0.1:${address.port}/v1`,
                    LIBRECHAT_CODE_WORKER_ID: 'test-worker',
                    LIBRECHAT_CODE_WORKER_TOKEN: 'test-token',
                },
                stdio: 'ignore',
            },
        );
        t.after(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        });
        const capabilities = await registered;
        child.kill();
        await once(child, 'exit');
        assert.deepEqual(
            capabilities.workspaceTools?.workspaces?.map(
                workspace => workspace.name,
            ),
            ['app', 'nested/api'],
        );
        assert.ok(
            capabilities.workspaceTools?.workspaces?.every(workspace =>
                workspace.id.startsWith('project-'),
            ),
        );
        assert.equal(JSON.stringify(capabilities).includes(root), false);
    },
);

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'selected-projects-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['app', 'nested/api']) {
        await mkdir(join(root, name), { recursive: true });
        await exec('git', ['init', '--initial-branch=dev', join(root, name)]);
    }
    return root;
}

test('selected projects retain identity across order and branch changes without granting their parent', async t => {
    const root = await fixture(t);
    const selected = await loadProjectRoots(root, ['app', 'nested/api']);
    assert.deepEqual(
        selected.map(project => project.name),
        ['app', 'nested/api'],
    );
    assert.ok(
        selected.every(project => project.root !== root && !project.writable),
    );
    await exec('git', [
        '-C',
        join(root, 'app'),
        'symbolic-ref',
        'HEAD',
        'refs/heads/next',
    ]);
    const restarted = await loadProjectRoots(root, ['nested/api', 'app']);
    assert.equal(restarted[1].id, selected[0].id);
    assert.equal(restarted[0].id, selected[1].id);
    const otherRoot = await fixture(t);
    assert.notEqual(
        (await loadProjectRoots(otherRoot, ['app']))[0].id,
        selected[0].id,
    );
});

test('real file operations use the selected project boundary', async t => {
    const root = await fixture(t);
    const selected = await loadProjectRoots(root, ['app', 'nested/api']);
    const tools = await LocalWorkspaceTools.create({
        workspaces: selected.map(project => ({ ...project, writable: true })),
    });
    await tools.execute({
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: selected[1].id,
        path: 'created.txt',
        content: 'second project',
    });
    assert.equal(
        await readFile(join(root, 'nested/api/created.txt'), 'utf8'),
        'second project',
    );
    await assert.rejects(
        tools.execute({
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: selected[0].id,
            path: '../nested/api/created.txt',
        }),
    );
    await assert.rejects(
        tools.execute({
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'nested/api/created.txt',
        }),
    );
    await assert.rejects(readFile(join(root, 'app/created.txt')));
});

test('rejects missing, escaped, aliased, duplicate and linked-worktree selections', async t => {
    const root = await fixture(t);
    await mkdir(join(root, 'linked'));
    await writeFile(
        join(root, 'linked/.git'),
        'gitdir: ../app/.git/worktrees/linked\n',
    );
    await symlink(join(root, 'app'), join(root, 'alias'), 'dir');
    for (const projects of [
        [],
        ['..'],
        ['/tmp'],
        ['missing'],
        ['alias'],
        ['linked'],
        ['app', './app'],
        Array(33).fill('app'),
    ]) {
        await assert.rejects(loadProjectRoots(root, projects));
    }
    await assert.rejects(
        loadProjectRoots(root, ['.']),
        /standalone Git checkout/,
    );
});

test('project CLI arguments require explicit bounded selections', () => {
    assert.equal(projectRootArguments(['run']), undefined);
    assert.deepEqual(
        projectRootArguments([
            'run',
            '--project-root=/srv/projects',
            '--project',
            'app',
            '--project=nested/api',
        ]),
        { root: '/srv/projects', projects: ['app', 'nested/api'] },
    );
    for (const args of [
        ['--project-root'],
        ['--project-root=/srv'],
        ['--project=app'],
        ['--project-root=/srv', '--project-root=/other', '--project=app'],
        ['--project-root=/srv', '--project', '--allow-workspace-writes'],
    ]) {
        assert.throws(() => projectRootArguments(args));
    }
});

test('rejects a directory-form git marker redirecting to shared metadata', async t => {
    const root = await fixture(t);
    await writeFile(
        join(root, 'app/.git/commondir'),
        '../../nested/api/.git\n',
    );
    await assert.rejects(
        loadProjectRoots(root, ['app']),
        /Git common directory/,
    );
});

test('replacement after selection cannot become a file or native execution root', async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const [selected] = await loadProjectRoots(root, ['app']);
    const tools = await LocalWorkspaceTools.create({
        workspaces: [{ ...selected, writable: true }],
    });
    await rename(selected.root, `${selected.root}-previous`);
    await symlink(join(outside, 'app'), selected.root, 'dir');
    await assert.rejects(
        LocalWorkspaceTools.create({ workspaces: [selected] }),
        /Invalid workspace registration/,
    );
    await assert.rejects(
        tools.execute({
            protocolVersion: 1,
            operation: 'write_file',
            workspaceId: selected.id,
            path: 'escaped.txt',
            content: 'blocked',
        }),
        /changed after admission/,
    );
    const executor = new NativeProcessWorkspaceCommandSandbox({
        workspaceRoot: selected.root,
        workspaceIdentity: selected.identity,
    });
    try {
        await assert.rejects(executor.prepare());
    } finally {
        await executor.close().catch(() => undefined);
    }
    await assert.rejects(readFile(join(outside, 'app/escaped.txt')), {
        code: 'ENOENT',
    });
});

test('CLI rejects mixed registration and overlapping selected projects before connecting', async t => {
    const root = await fixture(t);
    await exec('git', ['init', '--initial-branch=dev', root]);
    for (const extra of [
        ['--worker-dir', root],
        ['--project', '.'],
    ]) {
        const result = spawnSync(
            process.execPath,
            [
                fileURLToPath(new URL('./cli.js', import.meta.url)),
                'run',
                '--project-root',
                root,
                '--project',
                'app',
                ...extra,
            ],
            {
                encoding: 'utf8',
                timeout: 5000,
                env: {
                    PATH: process.env.PATH,
                    LIBRECHAT_CODE_URL: 'http://127.0.0.1:1',
                    LIBRECHAT_CODE_WORKER_ID: 'test-worker',
                    LIBRECHAT_CODE_WORKER_TOKEN: 'test-token',
                },
            },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /cannot be combined|must not overlap/);
    }
});
