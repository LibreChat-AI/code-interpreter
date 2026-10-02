import assert from 'node:assert/strict';
import test from 'node:test';
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    lstat,
    realpath,
    rm,
    symlink,
    rename,
    readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    parseDependencySnapshot,
    loadDependencySnapshot,
    publishDependencySnapshot,
    restoreDependencySnapshot,
    withDependencySnapshot,
} from './dependency-snapshots.js';
import { prepareCodeEnvironment } from './environment-preparation.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';
import type { EnvironmentPreparationOptions } from './environment-preparation.js';

async function fixture(t: test.TestContext) {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'dependency-snapshot-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const a = join(directory, 'a'),
        b = join(directory, 'b'),
        storePath = join(directory, 'store');
    for (const path of [a, b, storePath]) await mkdir(path, { mode: 0o700 });
    const store = await loadDependencySnapshot(
        parseDependencySnapshot({ store: storePath, paths: ['node_modules'] }),
    );
    const ai = await captureWorkspaceRootIdentity(a),
        bi = await captureWorkspaceRootIdentity(b);
    return { directory, a, b, store, ai, bi, key: 'a'.repeat(64) };
}

test('snapshot schema restricts installed directories, overlapping paths and finite bounds', () => {
    const valid = {
        store: '/private/store',
        paths: ['node_modules', 'packages/api/node_modules'],
    };
    assert.equal(parseDependencySnapshot(valid).maxFiles, 200_000);
    for (const paths of [
        ['.git'],
        ['../node_modules'],
        ['node_modules', 'node_modules/pkg/node_modules'],
        ['node_modules', 'node_modules'],
    ])
        assert.throws(() => parseDependencySnapshot({ ...valid, paths }));
    assert.throws(() =>
        parseDependencySnapshot({ ...valid, maxBytes: Infinity }),
    );
    assert.throws(() =>
        parseDependencySnapshot({ ...valid, store: 'relative' }),
    );
});

// These assertions exercise real filesystem cloning, not a mocked successful copy.
test(
    'real clone snapshots isolate writable files, preserve checkout-local links and never replace installations',
    {
        skip:
            process.platform !== 'darwin' &&
            process.env.LIBRECHAT_CODE_LIVE_SNAPSHOT_TESTS !== '1',
    },
    async t => {
        const { a, b, store, ai, bi, key } = await fixture(t);
        await mkdir(join(a, 'node_modules'));
        await writeFile(
            join(a, 'node_modules', 'package.js'),
            'module.exports = 42',
        );
        await mkdir(join(a, 'packages'));
        await mkdir(join(b, 'packages'));
        await symlink('../packages', join(a, 'node_modules', 'local'));
        await withDependencySnapshot(store, key, () =>
            publishDependencySnapshot(store, key, a, ai),
        );
        assert.equal(
            await withDependencySnapshot(store, key, () =>
                restoreDependencySnapshot(store, key, b, bi),
            ),
            true,
        );
        assert.notEqual(
            (await lstat(join(a, 'node_modules', 'package.js'))).ino,
            (await lstat(join(b, 'node_modules', 'package.js'))).ino,
        );
        await writeFile(join(b, 'node_modules', 'package.js'), 'changed');
        assert.equal(
            await readFile(join(a, 'node_modules', 'package.js'), 'utf8'),
            'module.exports = 42',
        );
        assert.equal(
            await readFile(join(store.store, key, '0', 'package.js'), 'utf8'),
            'module.exports = 42',
        );
        assert.equal(await restoreDependencySnapshot(store, key, b, bi), false);
        assert.equal(
            await readFile(join(b, 'node_modules', 'package.js'), 'utf8'),
            'changed',
        );
    },
);

test('unsafe links and bounded traversal never publish a partial snapshot', async t => {
    const { a, store, ai, key } = await fixture(t);
    await mkdir(join(a, 'node_modules'));
    await symlink('/etc/passwd', join(a, 'node_modules', 'escape'));
    await assert.rejects(
        publishDependencySnapshot(store, key, a, ai),
        /checkout-local/,
    );
    assert.deepEqual(await readdir(store.store), []);
    await rm(join(a, 'node_modules', 'escape'));
    await writeFile(join(a, 'node_modules', 'large'), 'large');
    await assert.rejects(
        publishDependencySnapshot({ ...store, maxBytes: 1 }, key, a, ai),
        /maxBytes/,
    );
    assert.deepEqual(await readdir(store.store), []);
});

test('kernel lock serializes publishers, supports cancellation and rejects a replaced store', async t => {
    const { store, key } = await fixture(t);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
        release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    const first = withDependencySnapshot(store, key, async () => {
        entered();
        await blocked;
    });
    await started;
    const controller = new AbortController();
    const second = withDependencySnapshot(
        store,
        key,
        async () => assert.fail('cancelled lock ran'),
        controller.signal,
    );
    controller.abort();
    await assert.rejects(second);
    release();
    await first;
    await rename(store.store, `${store.store}-old`);
    await mkdir(store.store, { mode: 0o700 });
    await assert.rejects(
        withDependencySnapshot(store, key, async () => {}),
        /changed after admission/,
    );
});

test(
    'real native preparation shares dependencies between checkouts, invalidates changed inputs and denies store access',
    {
        skip:
            process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1' ||
            (process.platform !== 'darwin' &&
                process.env.LIBRECHAT_CODE_LIVE_SNAPSHOT_TESTS !== '1'),
    },
    async t => {
        const { a, b, store, directory, ai, bi } = await fixture(t);
        for (const root of [a, b])
            await writeFile(join(root, 'package-lock.json'), 'version-one');
        const commands: string[] = [];
        const setup: EnvironmentPreparationOptions['setup'] = {
            command:
                "mkdir -p node_modules; printf 'module.exports = 42' > node_modules/package.js",
            timeoutMs: 5000,
            reuse: {
                inputs: ['package-lock.json'],
                checkCommand: 'test -f node_modules/package.js',
                checkTimeoutMs: 3000,
                snapshot: {
                    store: store.store,
                    paths: store.paths,
                    maxBytes: store.maxBytes,
                    maxFiles: store.maxFiles,
                },
            },
        };
        const sandboxes = [ai, bi].map(
            identity =>
                new NativeProcessWorkspaceCommandSandbox({
                    workspaceRoot: identity.path,
                    workspaceIdentity: identity,
                    homeDirectory: directory,
                    protectedPaths: [store.store],
                    allowedDomains: [],
                }),
        );
        t.after(async () => {
            for (const sandbox of sandboxes) await sandbox.close();
        });
        const run = (index: number) => {
            const identity = [ai, bi][index];
            return prepareCodeEnvironment({
                root: identity.path,
                identity,
                setup,
                context: 'policy',
                snapshotStore: store,
                snapshotScope: 'project',
                receiptPath: join(store.store, `receipt-${index}.json`),
                execute: async (command, timeoutMs) => {
                    commands.push(command);
                    return sandboxes[index].execute({
                        protocolVersion: 1,
                        operation: 'execute_command',
                        workspaceId: 'primary',
                        command,
                        timeoutMs,
                        maxOutputBytes: 8192,
                    });
                },
            });
        };
        assert.equal(await run(0), 'prepared');
        assert.equal(await run(1), 'restored');
        assert.equal(
            commands.filter(command => command === setup.command).length,
            1,
        );
        await writeFile(join(b, 'package-lock.json'), 'version-two');
        assert.equal(await run(1), 'prepared');
        assert.equal(
            commands.filter(command => command === setup.command).length,
            2,
        );
        const denied = await sandboxes[0].execute({
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: 'primary',
            command: `ls '${store.store}'`,
            timeoutMs: 3000,
        });
        assert.notEqual(denied.exitCode, 0);
    },
);
