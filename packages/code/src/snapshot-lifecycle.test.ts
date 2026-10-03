import assert from 'node:assert/strict';
import test from 'node:test';
import {
    mkdtemp,
    mkdir,
    realpath,
    writeFile,
    readFile,
    rm,
    lstat,
    utimes,
    symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    loadDependencySnapshot,
    parseDependencySnapshot,
} from './dependency-snapshots.js';
import {
    assertPreparationSpace,
    parseEnvironmentStorage,
    parseSnapshotLifecycle,
    pruneDependencySnapshots,
    SNAPSHOT_MANIFEST,
    STAGING_MANIFEST,
} from './snapshot-lifecycle.js';
import { withProcessLock } from './process-lock.js';
import { prepareCodeEnvironment } from './environment-preparation.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';

async function fixture(t: test.TestContext) {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'snapshot-lifecycle-')),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'store');
    await mkdir(path, { mode: 0o700 });
    const store = await loadDependencySnapshot(
        parseDependencySnapshot({
            store: path,
            paths: ['node_modules'],
            lifecycle: { maxStoreBytes: 10, maxEntries: 2, retentionMs: 1000 },
        }),
    );
    const add = async (key: string, bytes = 4, age = 0) => {
        const directory = join(store.store, key);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(
            join(directory, SNAPSHOT_MANIFEST),
            JSON.stringify({
                version: 1,
                key,
                bytes,
                files: 1,
                createdAt: Date.now(),
            }),
            { mode: 0o600 },
        );
        const lastUsed = new Date(Date.now() - age);
        await utimes(join(directory, SNAPSHOT_MANIFEST), lastUsed, lastUsed);
        return directory;
    };
    return {
        root,
        store,
        add,
        a: 'a'.repeat(64),
        b: 'b'.repeat(64),
        c: 'c'.repeat(64),
    };
}

test('storage policy is opt-in, bounded and fails before a setup command', async t => {
    assert.equal(parseEnvironmentStorage({}).minFreeBytes, 5 * 1024 ** 3);
    assert.throws(() => parseEnvironmentStorage({ minFreeBytes: -1 }));
    assert.throws(() => parseSnapshotLifecycle({ retentionMs: Infinity }));
    await assertPreparationSpace(
        '/',
        { minFreeBytes: 5, setupReserveBytes: 2 },
        async () => 7n,
    );
    await assert.rejects(
        assertPreparationSpace(
            '/',
            { minFreeBytes: 5, setupReserveBytes: 2 },
            async () => 6n,
        ),
        /no setup command was started/,
    );
    const { root } = await fixture(t);
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    const identity = await captureWorkspaceRootIdentity(checkout);
    let executions = 0;
    await assert.rejects(
        prepareCodeEnvironment({
            root: checkout,
            identity,
            setup: { command: 'install', timeoutMs: 1000 },
            receiptPath: join(root, 'receipt'),
            context: '',
            storage: {
                minFreeBytes: Number.MAX_SAFE_INTEGER,
                setupReserveBytes: 0,
            },
            execute: async () => {
                executions++;
                return { exitCode: 0, timedOut: false };
            },
        }),
        /deferred/,
    );
    assert.equal(executions, 0);
});

test('low space reclaims once before deferring setup', async t => {
    const policy = { minFreeBytes: 5, setupReserveBytes: 2 };
    let free = 6n;
    let reclaims = 0;
    await assertPreparationSpace('/', policy, async () => free, async () => {
        reclaims++;
        free = 7n;
    });
    assert.equal(reclaims, 1);
    await assertPreparationSpace('/', policy, async () => free, async () => {
        reclaims++;
    });
    assert.equal(reclaims, 1, 'enough space never triggers reclamation');
    await assert.rejects(
        assertPreparationSpace('/', policy, async () => 6n, async () => {
            reclaims++;
        }),
        /no setup command was started/,
    );
    assert.equal(reclaims, 2);

    const { root } = await fixture(t);
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    let executions = 0;
    let reclaimed = 0;
    await assert.rejects(
        prepareCodeEnvironment({
            root: checkout,
            identity: await captureWorkspaceRootIdentity(checkout),
            setup: { command: 'install', timeoutMs: 1000 },
            receiptPath: join(root, 'receipt'),
            context: '',
            storage: { minFreeBytes: Number.MAX_SAFE_INTEGER, setupReserveBytes: 0 },
            reclaimSpace: async () => {
                reclaimed++;
            },
            execute: async () => {
                executions++;
                return { exitCode: 0, timedOut: false };
            },
        }),
        /deferred/,
    );
    assert.equal(reclaimed, 1);
    assert.equal(executions, 0);
});

test('dry-run is non-destructive; cleanup removes only expired owned entries and retains unknown or linked data', async t => {
    const { store, add, a, b, c, root } = await fixture(t);
    const old = await add(a, 4, 10_000);
    await add(b);
    await mkdir(join(store.store, 'unrecognized'));
    await writeFile(join(store.store, 'unrecognized', 'source'), 'keep');
    await symlink(root, join(store.store, c));
    const preview = await pruneDependencySnapshots(store, { dryRun: true });
    assert.deepEqual(preview.removed, [a]);
    assert.equal((await lstat(old)).isDirectory(), true);
    const actual = await pruneDependencySnapshots(store);
    assert.deepEqual(actual.removed, [a]);
    await assert.rejects(lstat(old), { code: 'ENOENT' });
    assert.equal(
        await readFile(join(store.store, 'unrecognized', 'source'), 'utf8'),
        'keep',
    );
    assert.equal((await lstat(join(store.store, c))).isSymbolicLink(), true);
    assert.equal(actual.retainedBytes, 4);
});

test('cleanup preserves active keys and current preparation even when over budget', async t => {
    const { store, add, a, b } = await fixture(t);
    await add(a, 4, 10_000);
    await add(b, 4, 10_000);
    await withProcessLock(join(store.store, `${a}.lock`), async () => {
        const result = await pruneDependencySnapshots(store, { currentKey: b });
        assert.deepEqual(result.removed, []);
        assert.deepEqual(result.skippedActive, [a]);
        await assert.rejects(
            pruneDependencySnapshots(store, {
                currentKey: b,
                incomingBytes: 10,
            }),
            /budget is full/,
        );
    });
    assert.equal((await lstat(join(store.store, a))).isDirectory(), true);
});

test('publication budgets evict LRU entries and serialize commits without deleting source', async t => {
    const { store, add, a, b, c, root } = await fixture(t);
    await add(a, 4, 500);
    await add(b, 4, 100);
    const source = join(root, 'dirty-worktree');
    await mkdir(source);
    await writeFile(join(source, 'uncommitted'), 'keep');
    let published = false;
    const result = await pruneDependencySnapshots(store, {
        currentKey: c,
        incomingBytes: 4,
        incomingEntries: 1,
        publish: async () => {
            published = true;
        },
    });
    assert.deepEqual(result.removed, [a]);
    assert.equal(published, true);
    assert.equal(await readFile(join(source, 'uncommitted'), 'utf8'), 'keep');
});

test('operator CLI previews by default and applies only after explicit flag', async t => {
    const { store, add, a, root } = await fixture(t);
    await add(a, 4, 10_000);
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    const config = join(root, 'environment.yaml');
    await writeFile(
        config,
        `name: app\nroot: ${checkout}\nsetup:\n  command: npm ci\n  reuse:\n    inputs: [package-lock.json]\n    checkCommand: test -d node_modules\n    snapshot:\n      store: ${store.store}\n      paths: [node_modules]\n      lifecycle:\n        retentionMs: 1000\n`,
        { mode: 0o600 },
    );
    const run = promisify(execFile);
    const cli = new URL('./cli.js', import.meta.url).pathname;
    const args = [cli, 'prune-environment-storage', '--environment', config];
    const preview = await run(process.execPath, args);
    assert.deepEqual(JSON.parse(preview.stdout).removed, [a]);
    assert.equal((await lstat(join(store.store, a))).isDirectory(), true);
    const applied = await run(process.execPath, [...args, '--apply']);
    assert.deepEqual(JSON.parse(applied.stdout).removed, [a]);
    await assert.rejects(lstat(join(store.store, a)), { code: 'ENOENT' });
});

test('abandoned staging is reclaimed only with an ownership manifest and a free key lock', async t => {
    const { store, a } = await fixture(t);
    const name = `.staging-${a}-abcdef`;
    const directory = join(store.store, name);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
        join(directory, STAGING_MANIFEST),
        JSON.stringify({
            version: 1,
            key: a,
            bytes: 0,
            files: 1,
            createdAt: Date.now(),
        }),
        { mode: 0o600 },
    );
    await withProcessLock(join(store.store, `${a}.lock`), async () => {
        const active = await pruneDependencySnapshots(store);
        assert.deepEqual(active.skippedActive, [name]);
        assert.deepEqual(active.removed, []);
    });
    const result = await pruneDependencySnapshots(store);
    assert.deepEqual(result.removed, [name]);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
});
