import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
    chmod,
    mkdtemp,
    mkdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { discoverProjects, projectRemote } from './projects.js';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'code-projects-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
async function repo(root: string, path: string) {
    const directory = join(root, path);
    await mkdir(directory, { recursive: true });
    await exec('git', ['init', '--initial-branch=dev', directory]);
    return directory;
}

test('discovers real sibling repositories with stable IDs and bounded metadata', async t => {
    const root = await fixture(t);
    const a = await repo(root, 'a');
    await repo(root, 'nested/b');
    await exec('git', [
        '-C',
        a,
        'remote',
        'add',
        'origin',
        'https://user:secret@github.com/example/app.git?token=secret',
    ]);
    await exec('git', [
        '-C',
        a,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
    ]);
    const before = await discoverProjects({ root });
    assert.equal(before.incomplete, false);
    assert.equal(before.truncated, false);
    assert.deepEqual(
        before.projects.map(p => p.path),
        ['a', 'nested/b']
    );
    assert.equal(before.projects[0].remote, 'github.com/example/app');
    assert.equal(before.projects[0].branch, 'dev');
    assert.match(before.projects[0].head!, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    assert.equal(before.projects[1].head, null);
    assert.ok(!JSON.stringify(before).includes('secret'));
    await exec('git', ['-C', a, 'checkout', '-b', 'next']);
    const after = await discoverProjects({ root });
    assert.deepEqual(
        after.projects.map(p => p.id),
        before.projects.map(p => p.id)
    );
    assert.equal(after.projects[0].branch, 'next');
});

test('does not walk dependencies, hidden directories, symlinks or repository children', async t => {
    const root = await fixture(t);
    await repo(root, 'node_modules/ignored');
    await repo(root, '.hidden/ignored');
    await repo(root, 'parent');
    await repo(root, 'parent/nested');
    const outside = await fixture(t);
    await repo(outside, 'external');
    await symlink(outside, join(root, 'alias'), 'dir');
    const inventory = await discoverProjects({ root });
    assert.deepEqual(
        inventory.projects.map(p => p.path),
        ['parent']
    );
});

test('linked worktrees are reported incomplete until shared git metadata is admitted', async t => {
    const root = await fixture(t);
    await mkdir(join(root, 'linked'));
    await writeFile(
        join(root, 'linked', '.git'),
        'gitdir: /outside/metadata\n'
    );
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.incomplete, true);
    assert.deepEqual(inventory.projects, []);
});

test('oversized Git metadata is incomplete rather than silently reported absent', async t => {
    const root = await fixture(t);
    const directory = await repo(root, 'app');
    await exec('git', [
        '-C',
        directory,
        'config',
        'remote.origin.url',
        'x'.repeat(10_000),
    ]);
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.incomplete, true);
    assert.equal(inventory.projects[0].remote, null);
});

test('a valid branch beyond the metadata bound reports incomplete', async t => {
    const root = await fixture(t);
    const directory = await repo(root, 'app');
    const branch = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)].join(
        '/'
    );
    await exec('git', [
        '-C',
        directory,
        'symbolic-ref',
        'HEAD',
        `refs/heads/${branch}`,
    ]);
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.incomplete, true);
    assert.equal(inventory.projects[0].branch, null);
});

test('unreadable Git markers report incomplete', async t => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
        t.skip('requires POSIX permissions under an unprivileged account');
        return;
    }
    const root = await fixture(t);
    const directory = await repo(root, 'app');
    await chmod(directory, 0o400);
    try {
        assert.equal(
            (await discoverProjects({ root: directory })).incomplete,
            true
        );
    } finally {
        await chmod(directory, 0o700);
    }
});

test('root resolution consumes the processing budget and pre-abort wins', async t => {
    const root = await fixture(t);
    let ticks = 0;
    t.mock.method(Date, 'now', () => (ticks++ === 0 ? 0 : 20_000));
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.truncated, true);
    assert.deepEqual(inventory.projects, []);
    const reason = new Error('cancelled before filesystem access');
    await assert.rejects(
        discoverProjects({
            root: join(root, 'missing'),
            signal: AbortSignal.abort(reason),
        }),
        error => error === reason
    );
});

test('empty directory completion checks a late deadline and cancellation', async t => {
    const root = await fixture(t);
    const original = fs.opendir;
    let clock = 0;
    let cancel: AbortController | undefined;
    t.mock.method(Date, 'now', () => clock);
    const openMock = t.mock.method(
        fs,
        'opendir',
        async (path: Parameters<typeof fs.opendir>[0]) => {
            const directory = await original(path);
            clock = 20_000;
            cancel?.abort();
            return directory;
        }
    );
    syncBuiltinESMExports();
    try {
        assert.equal((await discoverProjects({ root })).truncated, true);
        clock = 0;
        cancel = new AbortController();
        await assert.rejects(
            discoverProjects({ root, signal: cancel.signal }),
            { name: 'AbortError' }
        );
    } finally {
        openMock.mock.restore();
        syncBuiltinESMExports();
    }
});

test('late filesystem boundaries stop before starting the next operation', async t => {
    const root = await fixture(t);
    for (const boundary of [3, 4, 5]) {
        for (const abort of [false, true]) {
            let calls = 0;
            let clock = 0;
            const controller = new AbortController();
            const now = t.mock.method(Date, 'now', () => clock);
            const mocks = ['lstat', 'realpath', 'opendir'].map(name => {
                const original = fs[name as 'lstat'];
                return t.mock.method(
                    fs,
                    name as 'lstat',
                    async (...args: Parameters<typeof fs.lstat>) => {
                        calls++;
                        try {
                            return await original(...args);
                        } finally {
                            if (calls === boundary) {
                                clock = 20_000;
                                if (abort) controller.abort();
                            }
                        }
                    }
                );
            });
            syncBuiltinESMExports();
            try {
                const discovery = discoverProjects({
                    root,
                    signal: controller.signal,
                });
                if (abort)
                    await assert.rejects(discovery, { name: 'AbortError' });
                else assert.equal((await discovery).truncated, true);
                assert.equal(calls, boundary);
            } finally {
                for (const mock of mocks) mock.mock.restore();
                now.mock.restore();
                syncBuiltinESMExports();
            }
        }
    }
});

test('unsupported configured origins are distinguishable from missing origins', async t => {
    const root = await fixture(t);
    const directory = await repo(root, 'app');
    await exec('git', [
        '-C',
        directory,
        'config',
        'remote.origin.url',
        '/private/local/repo',
    ]);
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.incomplete, true);
    assert.equal(inventory.projects[0].remote, null);
});

test('project, entry and depth ceilings report partial discovery', async t => {
    const root = await fixture(t);
    await repo(root, 'a');
    await repo(root, 'b');
    await repo(root, 'nested/deeper/c');
    assert.equal(
        (await discoverProjects({ root, maxProjects: 1 })).truncated,
        true
    );
    assert.equal(
        (await discoverProjects({ root, maxEntries: 1 })).truncated,
        true
    );
    assert.equal(
        (await discoverProjects({ root, maxDepth: 1 })).truncated,
        true
    );
    await assert.rejects(discoverProjects({ root, maxDepth: 100 }), /limit/);
    await assert.rejects(
        discoverProjects({ root, signal: AbortSignal.abort() })
    );
});

test('root checkout uses dot and detached HEAD has no branch', async t => {
    const root = await fixture(t);
    await repo(root, '.');
    await exec('git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
    ]);
    await exec('git', ['-C', root, 'checkout', '--detach']);
    const inventory = await discoverProjects({ root });
    assert.equal(inventory.projects[0].path, '.');
    assert.equal(inventory.projects[0].branch, null);
});

test('repository identity retains host and drops credentials, query and fragments', () => {
    assert.equal(
        projectRemote('ssh://git@example.com:2222/org/repo.git'),
        'example.com:2222/org/repo'
    );
    assert.equal(
        projectRemote('https://example.com:8443/org/repo.git'),
        'example.com:8443/org/repo'
    );
    assert.equal(
        projectRemote('git@github.com:org/repo.git'),
        'github.com/org/repo'
    );
    assert.equal(
        projectRemote('ssh://git@example.com/org/repo.git'),
        'example.com/org/repo'
    );
    assert.equal(
        projectRemote('https://token@example.com/org/repo.git?secret#fragment'),
        'example.com/org/repo'
    );
    assert.equal(projectRemote('/home/user/private'), null);
    assert.equal(projectRemote('file:///home/user/private'), null);
    assert.equal(
        projectRemote('https://example.com/group/subgroup/repo.git'),
        'example.com/group/subgroup/repo'
    );
    assert.equal(
        projectRemote('git@example.com:group/subgroup/repo.git'),
        'example.com/group/subgroup/repo'
    );
});

test('CLI inventories a real checkout without pairing or starting a worker', async t => {
    const root = await fixture(t);
    await repo(root, 'app');
    const { stdout, stderr } = await exec(
        process.execPath,
        [
            fileURLToPath(new URL('./cli.js', import.meta.url)),
            'projects',
            '--root',
            root,
        ],
        { env: { PATH: process.env.PATH }, timeout: 15_000 }
    );
    const result = JSON.parse(stdout);
    assert.equal(stderr, '');
    assert.equal(result.projects[0].path, 'app');
    assert.equal(result.projects[0].branch, 'dev');
    assert.equal(result.incomplete, false);
    await assert.rejects(
        exec(process.execPath, [
            fileURLToPath(new URL('./cli.js', import.meta.url)),
            'projects',
        ]),
        /Usage: librechat-code projects/
    );
});
