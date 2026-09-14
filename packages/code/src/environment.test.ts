import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
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
    assertEnvironmentDefinitionsOutsideRoots(
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
    assert.throws(() =>
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
    assert.equal(
        (await loadCodeEnvironment(join(directory, 'project', 'alias.yaml')))
            .path,
        first.path,
    );
});
