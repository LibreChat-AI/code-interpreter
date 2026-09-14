import assert from 'node:assert/strict';
import {
    mkdtemp,
    mkdir,
    writeFile,
    rm,
    symlink,
    link,
    open,
    realpath,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    parseCodeEnvironment,
    loadCodeEnvironment,
    assertEnvironmentDefinitionsOutsideRoots,
    EnvironmentWorkspaceTools,
} from './environment.js';
import { LocalWorkspaceTools, SandboxWorkspaceTools } from './workspace.js';
import { isValidBridgeWorkspaceToolCapabilities } from './protocol.js';
import type { WorkspaceExecuteCommandRequest } from './protocol.js';

test('environment YAML validates setup and rejects unsupported policy or action fields', () => {
    const definition = parseCodeEnvironment(
        'name: app\nroot: ./project\nsetup:\n  command: npm ci\n',
    );
    assert.equal(definition.setup?.timeoutMs, 300_000);
    for (const suffix of [
        'scope: { users: [anyone] }',
        'actions: [{}]',
        'unknown: true',
        'setup: { command: npm ci, timeoutMs: 600000 }',
        'setup: { command: npm ci, timeoutMs: -1 }',
        'setup: { command: npm ci, env: { SECRET: x } }',
        'name: duplicate',
        'repo: https://token@github.com/a/b',
    ])
        assert.throws(() =>
            parseCodeEnvironment(`name: app\nroot: ./project\n${suffix}\n`),
        );
    assert.throws(() => parseCodeEnvironment('name: &id app\nroot: *id'));
    assert.throws(() => parseCodeEnvironment('x'.repeat(65_537)));
    for (const field of ['setup', 'actions']) {
        const command = '漢'.repeat(12_000);
        const suffix =
            field === 'setup'
                ? `setup: { command: '${command}' }`
                : `actions: [{ name: test, command: '${command}' }]`;
        assert.throws(() =>
            parseCodeEnvironment(`name: app\nroot: project\n${suffix}`),
        );
    }
});

test('named actions use the loaded definition, reject stale revisions and preserve command restrictions', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-env-action-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const local = await LocalWorkspaceTools.create({
        workspaces: [{ id: 'app', root: directory }],
    });
    const executed: WorkspaceExecuteCommandRequest[] = [];
    const commands = new SandboxWorkspaceTools({
        workspaceTools: local,
        commandWorkspaces: ['app'],
        commandSandbox: {
            mutationFailuresAreAtomic: true,
            async execute(request) {
                executed.push(request);
                return {
                    protocolVersion: 1,
                    operation: 'execute_command',
                    workspaceId: 'app',
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                    timedOut: false,
                    truncated: false,
                };
            },
        },
    });
    const environments = [
        {
            path: '/operator/environment.yaml',
            fingerprint: 'a'.repeat(64),
            definition: {
                name: 'app',
                root: directory,
                actions: [
                    { name: 'test', command: 'npm test', timeoutMs: 2000 },
                ],
            },
        },
    ];
    const tools = new EnvironmentWorkspaceTools(commands, environments);
    assert.ok(isValidBridgeWorkspaceToolCapabilities(tools.capabilities));
    assert.deepEqual(tools.capabilities.workspaces[0].environment?.actions, [
        'test',
    ]);
    assert.equal(
        JSON.stringify(tools.capabilities).includes('npm test'),
        false,
    );
    const request: WorkspaceExecuteCommandRequest = {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'app',
        command: 'untrusted placeholder',
        timeoutMs: 5000,
        environmentAction: { name: 'test', fingerprint: 'a'.repeat(64) },
    };
    await tools.execute(request);
    assert.equal(executed[0].command, 'npm test');
    assert.equal(executed[0].timeoutMs, 2000);
    assert.equal(executed[0].environmentAction, undefined);
    for (const altered of [
        { ...request, workspaceId: 'other' },
        { ...request, cwd: 'nested' },
        {
            ...request,
            environmentAction: { name: 'test', fingerprint: 'b'.repeat(64) },
        },
        {
            ...request,
            environmentAction: { name: 'other', fingerprint: 'a'.repeat(64) },
        },
    ])
        await assert.rejects(
            tools.execute(altered),
            /unavailable or its definition changed/,
        );
    await assert.rejects(commands.execute(request), /not resolved/);
    const readOnly = new EnvironmentWorkspaceTools(local, environments);
    assert.deepEqual(
        readOnly.capabilities.workspaces[0].environment?.actions,
        [],
    );
    await assert.rejects(readOnly.execute(request));
    assert.equal(executed.length, 1);
});

test('environment roots resolve relative to the definition and fingerprints cover setup', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-env-definition-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'project'));
    const path = join(directory, 'environment.yaml');
    await writeFile(
        path,
        'name: app\nroot: project\nsetup: { command: "printf first" }\n',
    );
    const first = await loadCodeEnvironment(path);
    assert.ok(first.definition.root.endsWith('/project'));
    await assertEnvironmentDefinitionsOutsideRoots(
        [first],
        [{ id: 'app', root: first.definition.root }],
    );
    await writeFile(
        path,
        'name: app\nroot: project\nsetup: { command: "printf second" }\n',
    );
    assert.notEqual(
        (await loadCodeEnvironment(path)).fingerprint,
        first.fingerprint,
    );
    await assert.rejects(() =>
        assertEnvironmentDefinitionsOutsideRoots(
            [first],
            [
                {
                    id: 'parent',
                    root: first.definition.root.slice(0, -'/project'.length),
                },
            ],
        ),
    );
    await symlink(path, join(directory, 'project', 'alias.yaml'));
    const alias = await loadCodeEnvironment(
        join(directory, 'project', 'alias.yaml'),
    );
    await assert.rejects(() =>
        assertEnvironmentDefinitionsOutsideRoots(
            [alias],
            [{ id: 'app', root: first.definition.root }],
        ),
    );
    assert.equal(
        (await loadCodeEnvironment(join(directory, 'project', 'alias.yaml')))
            .path,
        first.path,
    );
});

test('rejects a trusted definition with an in-workspace hard link', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-env-hardlink-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'project'));
    const path = join(directory, 'environment.yaml');
    await writeFile(path, 'name: app\nroot: project\n');
    await link(path, join(directory, 'project', 'alias.yaml'));
    await assert.rejects(loadCodeEnvironment(path), /one link/);
});

test('rejects nested aliases passing through a workspace-controlled link', async t => {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'code-env-nested-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, 'project');
    const trusted = join(directory, 'trusted');
    await mkdir(root);
    await mkdir(trusted);
    await writeFile(
        join(trusted, 'environment.yaml'),
        `name: app\nroot: ${root}\n`,
    );
    await symlink(trusted, join(root, 'pivot'));
    await symlink(join(root, 'pivot'), join(directory, 'alias'));
    const loaded = await loadCodeEnvironment(
        join(directory, 'alias', 'environment.yaml'),
    );
    await assert.rejects(
        () =>
            assertEnvironmentDefinitionsOutsideRoots(
                [loaded],
                [{ id: 'app', root }],
            ),
        /outside|mount alias/,
    );
});

test('reads complete definitions despite short filesystem reads', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-env-short-read-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'project'));
    const path = join(directory, 'environment.yaml');
    await writeFile(
        path,
        'name: app\nroot: project\nsetup: { command: echo prepared }\n',
    );
    const sample = await open(path);
    const prototype = Object.getPrototypeOf(sample);
    const read = prototype.read;
    await sample.close();
    t.mock.method(
        prototype,
        'read',
        function (
            this: unknown,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
        ) {
            return read.call(
                this,
                buffer,
                offset,
                Math.min(length, 7),
                position,
            );
        },
    );
    assert.equal(
        (await loadCodeEnvironment(path)).definition.setup?.command,
        'echo prepared',
    );
});

test('rejects a root routed through another workspace and malformed UTF-8', async t => {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'code-env-root-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const rootA = join(directory, 'a');
    const rootB = join(directory, 'b');
    await mkdir(rootA);
    await mkdir(rootB);
    await symlink(rootA, join(rootB, 'pivot'));
    const path = join(directory, 'environment.yaml');
    await writeFile(path, `name: a\nroot: ${join(rootB, 'pivot')}\n`);
    const loaded = await loadCodeEnvironment(path);
    await assert.rejects(
        () =>
            assertEnvironmentDefinitionsOutsideRoots(
                [loaded],
                [
                    { id: 'a', root: rootA },
                    { id: 'b', root: rootB },
                ],
            ),
        /root traversal|mount alias/,
    );
    await symlink(rootA, join(rootA, 'self-pivot'));
    await writeFile(path, `name: a\nroot: ${join(rootA, 'self-pivot')}\n`);
    const selfControlled = await loadCodeEnvironment(path);
    await assert.rejects(
        () =>
            assertEnvironmentDefinitionsOutsideRoots(
                [selfControlled],
                [{ id: 'a', root: rootA }],
            ),
        /root traversal|mount alias/,
    );
    await writeFile(
        path,
        Buffer.concat([
            Buffer.from(`name: a\nroot: ${rootA}\nsetup: { command: echo `),
            Buffer.from([0xff]),
            Buffer.from(' }'),
        ]),
    );
    await assert.rejects(loadCodeEnvironment(path), /encoded data/);
});

test('rejects a FIFO definition without waiting for a writer', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-env-fifo-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'environment.yaml');
    execFileSync('mkfifo', ['-m', '600', path], { timeout: 2000 });
    await assert.rejects(loadCodeEnvironment(path), /Invalid environment file/);
});

test('rejects a filesystem-identical control directory despite a different root path', async t => {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'code-env-identity-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const trusted = join(directory, 'trusted');
    const alias = join(directory, 'alias');
    const project = join(directory, 'project');
    await mkdir(trusted);
    await mkdir(project);
    await symlink(trusted, alias);
    const path = join(trusted, 'environment.yaml');
    await writeFile(path, `name: app\nroot: ${project}\n`);
    const loaded = await loadCodeEnvironment(path);
    // Unlike realpath-based containment, inode comparison also covers bind-mount aliases.
    await assert.rejects(
        assertEnvironmentDefinitionsOutsideRoots(
            [loaded],
            [{ id: 'alias', root: alias }],
        ),
        /outside|mount alias/,
    );
});
