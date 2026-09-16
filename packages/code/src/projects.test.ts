import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    assert.match(before.projects[0].head!, /^[a-f0-9]{40}$/);
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
    assert.equal(projectRemote('https://example.com/org/repo/extra'), null);
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
