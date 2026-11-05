import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    PACKAGE_NAME,
    REGISTRY,
    publicationDecision,
    registryValue,
    releasePlan,
    validateManifest,
    validatePackFiles,
    verifyCandidate,
    versionParts,
} from './code-package-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(
    await readFile(join(root, 'packages/code/package.json'), 'utf8')
);
const requiredFiles = [
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
    'dist/cli.js',
    'dist/native-process-child.js',
    ...Object.values(manifest.exports).flatMap(entry =>
        [entry.import, entry.types].map(path => path.slice(2))
    ),
].filter((path, index, all) => all.indexOf(path) === index);

for (const [version, tag] of [
    ['0.1.0-rc.1', 'next'],
    ['1.2.3', 'latest'],
]) {
    test(`routes ${version} to ${tag} only from the matching tag or main dispatch`, () => {
        assert.deepEqual(
            releasePlan(version, 'push', `refs/tags/code-v${version}`),
            { version, tag }
        );
        assert.deepEqual(
            releasePlan(
                version,
                'workflow_dispatch',
                'refs/heads/main',
                version
            ),
            { version, tag }
        );
        assert.deepEqual(
            releasePlan(version, 'pull_request', 'refs/pull/1/merge'),
            { version, tag }
        );
    });
}

for (const version of [
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.2.3-rc1',
    '1.2.3-beta.1',
    '1.2.3+build',
    '1.2.3\n',
    '1.2.3-rc.01',
    '../package',
    'latest',
    '',
    null,
]) {
    test(`rejects ambiguous version ${JSON.stringify(version)}`, () =>
        assert.throws(() => versionParts(version)));
}

test('rejects wrong tag, branch, dispatch version, and unsupported release triggers', () => {
    assert.throws(
        () => releasePlan('1.2.3', 'push', 'refs/tags/v1.2.3'),
        /Tag must match/
    );
    assert.throws(
        () => releasePlan('1.2.3', 'push', 'refs/tags/code-v1.2.4'),
        /Tag must match/
    );
    assert.throws(
        () =>
            releasePlan(
                '1.2.3',
                'workflow_dispatch',
                'refs/heads/topic',
                '1.2.3'
            ),
        /from main/
    );
    assert.throws(
        () =>
            releasePlan(
                '1.2.3',
                'workflow_dispatch',
                'refs/heads/main',
                '1.2.4'
            ),
        /must match/
    );
    assert.throws(
        () => releasePlan('1.2.3', 'workflow_run', 'refs/heads/main'),
        /Unsupported/
    );
});

test('published versions are immutable and retries do not move dist-tags', () => {
    const candidate = {
        version: '1.2.3',
        tag: 'latest',
        integrity: 'sha512-tested',
    };
    assert.equal(
        publicationDecision(candidate, candidate.integrity, {
            latest: '2.0.0',
        }),
        'skip'
    );
    assert.throws(
        () => publicationDecision(candidate, 'sha512-other', {}),
        /different bytes/
    );
    assert.equal(
        publicationDecision(candidate, undefined, { latest: '1.2.2' }),
        'publish'
    );
    assert.throws(
        () => publicationDecision(candidate, undefined, { latest: '1.2.4' }),
        /backwards/
    );
});

test('release candidates cannot roll next backwards and stable wins over its prerelease', () => {
    const candidate = {
        version: '0.1.0-rc.2',
        tag: 'next',
        integrity: 'sha512-tested',
    };
    assert.equal(
        publicationDecision(candidate, undefined, { next: '0.1.0-rc.1' }),
        'publish'
    );
    assert.throws(
        () => publicationDecision(candidate, undefined, { next: '0.1.0-rc.3' }),
        /backwards/
    );
    assert.throws(
        () => publicationDecision(candidate, undefined, { next: '0.1.0' }),
        /backwards/
    );
    assert.equal(
        publicationDecision(
            { ...candidate, version: '0.1.0', tag: 'latest' },
            undefined,
            { latest: '0.1.0-rc.2' }
        ),
        'publish'
    );
    assert.equal(publicationDecision(candidate, undefined, {}), 'publish');
});

test('registry absence is distinct from transport, authentication, and malformed metadata', () => {
    assert.equal(
        registryValue({
            status: 1,
            stdout: JSON.stringify({ error: { code: 'E404' } }),
        }),
        undefined
    );
    assert.equal(
        registryValue({ status: 0, stdout: '"sha512-tested"' }),
        'sha512-tested'
    );
    for (const result of [
        {
            status: 1,
            stdout: JSON.stringify({
                error: { code: 'E403', detail: 'private diagnostic' },
            }),
        },
        { status: 1, stdout: JSON.stringify({ error: { code: 'E503' } }) },
        { status: null, stdout: '', error: new Error('private diagnostic') },
        { status: 1, stdout: 'private diagnostic' },
        { status: 0, stdout: '' },
        { status: 0, stdout: 'private diagnostic' },
    ])
        assert.throws(
            () => registryValue(result),
            error => {
                assert.ok(!error.message.includes('private diagnostic'));
                return true;
            }
        );
    assert.throws(
        () =>
            publicationDecision(
                { version: '1.0.0', tag: 'latest' },
                undefined,
                []
            ),
        /Invalid registry/
    );
});

test('manifest declares public provenance metadata and remains lockfile-aligned', async () => {
    validateManifest(manifest);
    const lock = JSON.parse(
        await readFile(join(root, 'packages/code/package-lock.json'), 'utf8')
    );
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.ok(versionParts(manifest.version));
    for (const altered of [
        { ...manifest, name: 'another-package' },
        { ...manifest, private: true },
        {
            ...manifest,
            repository: {
                ...manifest.repository,
                url: 'git+https://github.com/another/repo.git',
            },
        },
        {
            ...manifest,
            publishConfig: { access: 'restricted', registry: REGISTRY },
        },
        { ...manifest, bin: { 'librechat-code': './src/cli.ts' } },
    ])
        assert.throws(() => validateManifest(altered));
});

test('archive allowlist rejects tests, secrets, directories, links and untracked payloads', () => {
    validatePackFiles(requiredFiles, manifest);
    for (const extra of [
        '.env',
        'src/cli.ts',
        'node_modules/package/index.js',
        'dist/worker.test.js',
        'dist/scratch.json',
        'dist/../token.js',
        '../LICENSE',
        'dist/',
    ]) {
        assert.throws(() =>
            validatePackFiles([...requiredFiles, extra], manifest)
        );
    }
    assert.throws(
        () => validatePackFiles([...requiredFiles, 'dist/cli.js'], manifest),
        /duplicate/
    );
    assert.throws(
        () =>
            validatePackFiles(
                requiredFiles.filter(path => path !== 'LICENSE'),
                manifest
            ),
        /Missing/
    );
    assert.throws(
        () =>
            validatePackFiles(
                requiredFiles.filter(
                    path => path !== 'dist/native-process-child.js'
                ),
                manifest
            ),
        /Missing/
    );
    assert.throws(
        () =>
            validatePackFiles(
                Array.from({ length: 301 }, (_, i) => `dist/file-${i}.js`),
                manifest
            ),
        /budget/
    );
});

async function artifact(t) {
    const directory = await mkdtemp(join(tmpdir(), 'code-package-release-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const path of requiredFiles) {
        await mkdir(dirname(join(directory, 'package', path)), {
            recursive: true,
        });
        const content = path === 'package.json' ? JSON.stringify(manifest) : '';
        await writeFile(join(directory, 'package', path), content);
    }
    for (const name of ['LICENSE', 'NOTICE'])
        await cp(join(root, name), join(directory, 'package', name));
    const candidate = {
        name: PACKAGE_NAME,
        version: manifest.version,
        tag: releasePlan(manifest.version, 'pull_request', 'refs/pull/1/merge')
            .tag,
        filename: `librechat-code-${manifest.version}.tgz`,
        integrity: '',
        sha: 'a'.repeat(40),
    };
    const save = async () => {
        execFileSync('tar', [
            '-czf',
            join(directory, candidate.filename),
            '-C',
            directory,
            ...requiredFiles.map(path => `package/${path}`),
        ]);
        candidate.integrity = `sha512-${createHash('sha512')
            .update(await readFile(join(directory, candidate.filename)))
            .digest('base64')}`;
        await writeFile(
            join(directory, 'candidate.json'),
            JSON.stringify(candidate)
        );
    };
    await save();
    return { directory, candidate, save };
}

test('verifies the real archive bytes, version, exports, and repository legal contents', async t => {
    const { directory, candidate } = await artifact(t);
    assert.deepEqual(await verifyCandidate(directory), candidate);
    await writeFile(join(directory, candidate.filename), 'different bytes');
    await assert.rejects(verifyCandidate(directory), /candidate integrity/);
});

test('rejects legal-file drift even with a recomputed archive integrity', async t => {
    const { directory, save } = await artifact(t);
    await writeFile(
        join(directory, 'package/NOTICE'),
        'unreviewed legal contents'
    );
    await save();
    await assert.rejects(verifyCandidate(directory), /NOTICE differs/);
});

test('rejects candidate version, channel, filename and source mismatches', async t => {
    const { directory, candidate } = await artifact(t);
    for (const override of [
        { name: 'another-package' },
        { tag: 'latest' },
        { filename: '../escape.tgz' },
        { sha: 'not a commit' },
        { version: '0.1.0-rc.2', filename: 'librechat-code-0.1.0-rc.2.tgz' },
    ]) {
        await writeFile(
            join(directory, 'candidate.json'),
            JSON.stringify({ ...candidate, ...override })
        );
        await assert.rejects(verifyCandidate(directory));
    }
});

test('publish refuses local or unapproved execution before touching a candidate or registry', () => {
    for (const environment of [
        { CODE_PACKAGE_PUBLISH: 'false', GITHUB_ACTIONS: 'true' },
        { CODE_PACKAGE_PUBLISH: 'true', GITHUB_ACTIONS: 'false' },
        {
            CODE_PACKAGE_PUBLISH: 'true',
            GITHUB_ACTIONS: 'true',
            ACTIONS_ID_TOKEN_REQUEST_URL: '',
        },
    ]) {
        const result = spawnSync(
            process.execPath,
            [
                join(root, 'scripts/code-package-release.mjs'),
                'publish',
                '/does-not-exist',
            ],
            {
                encoding: 'utf8',
                env: { ...process.env, ...environment },
                timeout: 5000,
            }
        );
        assert.equal(result.status, 1);
        assert.match(
            result.stderr,
            /explicit workflow authorization|trusted GitHub workflow|OIDC is unavailable/
        );
        assert.ok(!result.stderr.includes('ENOENT'));
    }
});

test('workflow keeps publication opt-in, serialized, main-gated and separate from artifact verification', async () => {
    const require = createRequire(
        new URL('../packages/code/package.json', import.meta.url)
    );
    const { parse } = require('yaml');
    const workflow = parse(
        await readFile(join(root, '.github/workflows/code-package.yml'), 'utf8')
    );
    assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
    assert.deepEqual(workflow.on.push.tags, ['code-v*']);
    assert.equal(workflow.permissions['id-token'], undefined);
    assert.equal(workflow.jobs.pack.permissions['id-token'], undefined);
    assert.equal(workflow.jobs.verify.permissions, undefined);
    assert.deepEqual(workflow.jobs.publish.needs, ['pack', 'verify']);
    assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
    assert.equal(workflow.jobs.publish.environment, 'npm');
    assert.match(workflow.jobs.publish.if, /inputs.publish == true/);
    assert.match(
        workflow.jobs.publish.if,
        /github.repository == 'LibreChat-AI\/code-interpreter'/
    );
    assert.match(workflow.concurrency.group, /'release'/);
    const releaseChecks = workflow.jobs.pack.steps.find(
        step => step.name === 'Require successful main CI for releases'
    );
    assert.match(releaseChecks.run, /head_sha=\$SOURCE_SHA/);
    assert.match(releaseChecks.run, /status=success/);
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
            if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
            if (step.uses?.startsWith('actions/checkout@'))
                assert.equal(step.with['persist-credentials'], false);
        }
    }
    assert.equal(
        workflow.jobs.publish.steps.some(step =>
            /npm (ci|run build|pack)/.test(step.run ?? '')
        ),
        false,
        'Publishing must not rebuild the tested artifact'
    );
});
