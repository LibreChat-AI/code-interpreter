import assert from 'node:assert/strict';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    parseCodeEnvironment,
    loadCodeEnvironment,
    assertEnvironmentDefinitionsOutsideRoots,
} from './environment.js';
import {
    parseEnvironmentResources,
    loadEnvironmentResource,
    assertEnvironmentResourcesStable,
} from './environment-resources.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';

test('shared resources are explicit bounded known cache kinds, not arbitrary environment or filesystem grants', () => {
    assert.equal(
        parseCodeEnvironment(
            'name: app\nroot: app\nresources:\n  - kind: npm-cache\n    path: /cache/npm\n    access: read-write\n',
        ).resources?.[0].kind,
        'npm-cache',
    );
    for (const value of [
        [],
        [{ kind: 'secrets', path: '/cache', access: 'read-write' }],
        [{ kind: 'npm-cache', path: '../cache', access: 'read-write' }],
        [{ kind: 'uv-cache', path: '/cache', access: 'all' }],
        [
            {
                kind: 'uv-cache',
                path: '/cache',
                access: 'read-only',
                env: 'GH_TOKEN',
            },
        ],
        [1],
        [
            { kind: 'uv-cache', path: '/cache', access: 'read-only' },
            { kind: 'uv-cache', path: '/other', access: 'read-only' },
        ],
    ])
        assert.throws(() => parseEnvironmentResources(value));
});

test('resource roots must be stable private directories and outside source grants', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'code-resources-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, 'root');
    const cache = join(directory, 'cache');
    await mkdir(root);
    await mkdir(cache, { mode: 0o700 });
    const resource = {
        kind: 'npm-cache' as const,
        path: cache,
        access: 'read-write' as const,
    };
    const loaded = await loadEnvironmentResource(resource);
    await assertEnvironmentResourcesStable([loaded]);
    await chmod(cache, 0o755);
    await assert.rejects(loadEnvironmentResource(resource), /owner-only/);
    await chmod(cache, 0o700);
    await symlink(cache, join(directory, 'alias'));
    await assert.rejects(
        loadEnvironmentResource({
            ...resource,
            path: join(directory, 'alias'),
        }),
        /symlink/,
    );
    await rename(cache, join(directory, 'old'));
    await mkdir(cache, { mode: 0o700 });
    await assert.rejects(assertEnvironmentResourcesStable([loaded]), /changed/);
    const file = join(directory, 'app.yaml');
    await writeFile(
        file,
        `name: app\nroot: ${root}\nresources:\n  - kind: npm-cache\n    path: ${cache}\n    access: read-write\n`,
        { mode: 0o600 },
    );
    const environment = await loadCodeEnvironment(file);
    const [cacheRoot] = environment.resources!;
    await assert.rejects(
        assertEnvironmentDefinitionsOutsideRoots(
            [
                {
                    path: cacheRoot.path,
                    sourceParents: cacheRoot.controlPaths,
                    fingerprint: '',
                    definition: { name: 'cache', root: cacheRoot.path },
                },
            ],
            [{ id: 'root', root: directory }],
        ),
        /workspace|root|definition/i,
    );
});

test(
    'real native SRT shares only declared stores across independent checkouts and refuses readonly writes',
    {
        skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
        timeout: 30_000,
    },
    async t => {
        const directory = await mkdtemp(join(tmpdir(), 'code-resources-live-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const cache = join(directory, 'cache');
        const browser = join(directory, 'browsers');
        await mkdir(cache, { mode: 0o700 });
        await mkdir(browser, { mode: 0o700 });
        await writeFile(join(browser, 'version'), 'pinned-browser');
        const resources = await Promise.all([
            loadEnvironmentResource({
                kind: 'npm-cache',
                path: cache,
                access: 'read-write',
            }),
            loadEnvironmentResource({
                kind: 'playwright-browsers',
                path: browser,
                access: 'read-only',
            }),
        ]);
        const sandboxes = await Promise.all(
            ['a', 'b'].map(async name => {
                const root = join(directory, name);
                await mkdir(root);
                const identity = await captureWorkspaceRootIdentity(root);
                await writeFile(join(root, 'private'), 'other-checkout');
                const sandbox = new NativeProcessWorkspaceCommandSandbox({
                    workspaceRoot: identity.path,
                    workspaceIdentity: identity,
                    homeDirectory: directory,
                    resources,
                });
                await sandbox.prepare();
                return sandbox;
            }),
        );
        t.after(async () => {
            for (const sandbox of sandboxes) await sandbox.close();
        });
        const execute = (index: number, command: string) =>
            sandboxes[index].execute({
                protocolVersion: 1,
                operation: 'execute_command',
                workspaceId: 'primary',
                command,
                timeoutMs: 5000,
            });
        const results = await Promise.all(
            sandboxes.map((_, i) =>
                execute(
                    i,
                    'printf "%s\\n" "$npm_config_cache"; printf once >> "$npm_config_cache/marker"; cat "$PLAYWRIGHT_BROWSERS_PATH/version"',
                ),
            ),
        );
        for (const result of results) {
            assert.equal(result.exitCode, 0, result.stderr);
            assert.match(result.stdout, /pinned-browser/);
        }
        assert.equal(await readFile(join(cache, 'marker'), 'utf8'), 'onceonce');
        assert.notEqual(
            (
                await execute(
                    0,
                    'printf forbidden > "$PLAYWRIGHT_BROWSERS_PATH/version"',
                )
            ).exitCode,
            0,
        );
        assert.equal(
            await readFile(join(browser, 'version'), 'utf8'),
            'pinned-browser',
        );
        assert.notEqual(
            (await execute(0, `cat '${join(directory, 'b', 'private')}'`))
                .exitCode,
            0,
        );
    },
);
