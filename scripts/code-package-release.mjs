import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    appendFile,
    lstat,
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@librechat/code';
export const REGISTRY = 'https://registry.npmjs.org/';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_ROOT = join(ROOT, 'packages/code');
const MAX_PACKED_BYTES = 1024 * 1024;
const MAX_UNPACKED_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 300;

export function versionParts(version) {
    assert.ok(
        typeof version === 'string' && version.length <= 128,
        'Package version is required and must be at most 128 characters'
    );
    const match =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(
            version
        );
    assert.ok(match, 'Use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N');
    return match
        .slice(1)
        .map(part => (part === undefined ? undefined : BigInt(part)));
}

export function releasePlan(version, event, ref, expectedVersion = '') {
    const parts = versionParts(version);
    assert.ok(
        ['pull_request', 'push', 'workflow_dispatch'].includes(event),
        'Unsupported release event'
    );
    if (event === 'push')
        assert.equal(
            ref,
            `refs/tags/code-v${version}`,
            'Tag must match the package version'
        );
    if (event === 'workflow_dispatch') {
        assert.equal(
            ref,
            'refs/heads/main',
            'Dispatch package releases from main'
        );
        assert.equal(
            expectedVersion,
            version,
            'Requested version must match the committed package version'
        );
    }
    return { version, tag: parts[3] === undefined ? 'latest' : 'next' };
}

function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    if (a[3] === b[3]) return 0;
    if (a[3] === undefined) return 1;
    if (b[3] === undefined) return -1;
    return a[3] > b[3] ? 1 : -1;
}

export function publicationDecision(candidate, existingIntegrity, distTags) {
    assert.ok(
        distTags && typeof distTags === 'object' && !Array.isArray(distTags),
        'Invalid registry dist-tags'
    );
    if (existingIntegrity !== undefined) {
        assert.equal(
            existingIntegrity,
            candidate.integrity,
            'Published version has different bytes; use a new version'
        );
        return 'skip';
    }
    const current = distTags[candidate.tag];
    if (current !== undefined) {
        assert.ok(
            compareVersions(candidate.version, current) >= 0,
            `Refusing to move ${candidate.tag} backwards`
        );
    }
    return 'publish';
}

export function validateManifest(manifest) {
    assert.equal(manifest.name, PACKAGE_NAME);
    versionParts(manifest.version);
    assert.equal(manifest.private, undefined, 'Worker package must be public');
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(
        manifest.repository?.url,
        'git+https://github.com/LibreChat-AI/code-interpreter.git'
    );
    assert.equal(manifest.repository?.directory, 'packages/code');
    assert.deepEqual(manifest.publishConfig, {
        access: 'public',
        registry: REGISTRY,
    });
    assert.deepEqual(manifest.bin, {
        'lc-code': './dist/cli.js',
        'librechat-code': './dist/cli.js',
    });
    assert.ok(manifest.exports?.['./browser-enrollment']);
}

export function validatePackFiles(paths, manifest) {
    assert.ok(
        paths.length > 0 && paths.length <= MAX_FILES,
        'Package file-count budget exceeded'
    );
    assert.equal(
        new Set(paths).size,
        paths.length,
        'Package contains duplicate entries'
    );
    for (const path of paths) {
        assert.ok(
            /^(package\.json|README\.md|LICENSE|NOTICE|dist\/[a-z0-9-]+\.(js|js\.map|d\.ts))$/.test(
                path
            ),
            `Unexpected package file: ${path}`
        );
        assert.ok(!/\.(test|spec)\./.test(path), 'Tests must not be published');
    }
    const required = [
        'package.json',
        'LICENSE',
        'NOTICE',
        'dist/cli.js',
        'dist/native-process-child.js',
    ];
    for (const entry of Object.values(manifest.exports)) {
        assert.ok(
            entry &&
                typeof entry.import === 'string' &&
                typeof entry.types === 'string'
        );
        required.push(
            entry.import.replace(/^\.\//, ''),
            entry.types.replace(/^\.\//, '')
        );
    }
    for (const path of required)
        assert.ok(paths.includes(path), `Missing package file: ${path}`);
}

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        ...options,
    });
}

async function output(values) {
    for (const [key, value] of Object.entries(values)) {
        assert.ok(!/[\r\n]/.test(String(value)));
        console.log(`${key}=${value}`);
        if (process.env.GITHUB_OUTPUT)
            await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
}

async function sourceManifest() {
    const manifest = JSON.parse(
        await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    );
    const lock = JSON.parse(
        await readFile(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8')
    );
    validateManifest(manifest);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    return manifest;
}

async function plan() {
    const manifest = await sourceManifest();
    const selected = releasePlan(
        manifest.version,
        process.env.GITHUB_EVENT_NAME,
        process.env.GITHUB_REF,
        process.env.EXPECTED_VERSION
    );
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
        run('git', [
            'merge-base',
            '--is-ancestor',
            'HEAD',
            'refs/remotes/origin/main',
        ]);
    }
    const sha = run('git', ['rev-parse', 'HEAD']).trim();
    assert.match(sha, /^[a-f0-9]{40}$/);
    await output({ ...selected, sha });
}

async function pack(directory) {
    const manifest = await sourceManifest();
    directory = resolve(directory);
    await mkdir(directory, { recursive: true });
    const result = JSON.parse(
        run(
            'npm',
            ['pack', PACKAGE_ROOT, '--pack-destination', directory, '--json'],
            { timeout: 180_000 }
        )
    );
    assert.equal(result.length, 1);
    const info = result[0];
    validatePackFiles(
        info.files.map(file => file.path),
        manifest
    );
    assert.ok(
        info.unpackedSize <= MAX_UNPACKED_BYTES,
        'Package unpacked-size budget exceeded'
    );
    const filename = `librechat-code-${manifest.version}.tgz`;
    assert.equal(info.filename, filename);
    const bytes = await readFile(join(directory, filename));
    assert.ok(
        bytes.length <= MAX_PACKED_BYTES,
        'Package compressed-size budget exceeded'
    );
    const integrity = `sha512-${createHash('sha512')
        .update(bytes)
        .digest('base64')}`;
    assert.equal(integrity, info.integrity);
    const candidate = {
        name: PACKAGE_NAME,
        version: manifest.version,
        tag:
            versionParts(manifest.version)[3] === undefined ? 'latest' : 'next',
        filename,
        integrity,
        sha: run('git', ['rev-parse', 'HEAD']).trim(),
    };
    await writeFile(
        join(directory, 'candidate.json'),
        `${JSON.stringify(candidate, null, 2)}\n`
    );
    await verifyCandidate(directory);
    await output({
        filename,
        integrity,
        compressedBytes: bytes.length,
        unpackedBytes: info.unpackedSize,
    });
}

export async function verifyCandidate(directory) {
    const candidate = JSON.parse(
        await readFile(join(directory, 'candidate.json'), 'utf8')
    );
    assert.equal(candidate.name, PACKAGE_NAME);
    const parts = versionParts(candidate.version);
    assert.equal(candidate.tag, parts[3] === undefined ? 'latest' : 'next');
    assert.equal(candidate.filename, `librechat-code-${candidate.version}.tgz`);
    assert.match(candidate.sha, /^[a-f0-9]{40}$/);
    const path = join(directory, candidate.filename);
    const stats = await lstat(path);
    assert.ok(
        stats.isFile() && stats.size > 0 && stats.size <= MAX_PACKED_BYTES,
        'Invalid package artifact size or type'
    );
    assert.equal(
        candidate.integrity,
        `sha512-${createHash('sha512')
            .update(await readFile(path))
            .digest('base64')}`,
        'Package bytes do not match the candidate integrity'
    );
    const archivePaths = run('tar', ['-tzf', path]).trim().split('\n');
    const entries = run('tar', ['-tvzf', path]).trim().split('\n');
    assert.ok(
        entries.length === archivePaths.length &&
            entries.every(entry => entry.startsWith('-')),
        'Package archive must contain only regular files'
    );
    const unpacked = run('tar', ['-xOzf', path], {
        encoding: 'buffer',
        maxBuffer: MAX_UNPACKED_BYTES + 1,
    });
    assert.ok(
        unpacked.length <= MAX_UNPACKED_BYTES,
        'Package unpacked-size budget exceeded'
    );
    assert.ok(
        archivePaths.every(entry => entry.startsWith('package/')),
        'Invalid package archive root'
    );
    const manifest = JSON.parse(
        run('tar', ['-xOzf', path, 'package/package.json'])
    );
    validateManifest(manifest);
    assert.equal(manifest.version, candidate.version);
    validatePackFiles(
        archivePaths.map(entry => entry.slice('package/'.length)),
        manifest
    );
    for (const name of ['LICENSE', 'NOTICE']) {
        assert.equal(
            run('tar', ['-xOzf', path, `package/${name}`]),
            await readFile(join(ROOT, name), 'utf8'),
            `Package ${name} differs from the repository`
        );
    }
    return candidate;
}

export function registryValue(result) {
    if (result.error || result.signal || !Number.isInteger(result.status)) {
        throw new Error('npm registry lookup did not complete');
    }
    if (result.status === 0) {
        assert.ok(result.stdout.trim(), 'npm registry returned empty metadata');
        try {
            return JSON.parse(result.stdout);
        } catch {
            throw new Error('npm registry returned invalid metadata');
        }
    }
    let error;
    try {
        error = JSON.parse(result.stdout).error;
    } catch {
        /* Fail closed without echoing registry output. */
    }
    if (error?.code === 'E404') return undefined;
    throw new Error(
        'npm registry lookup failed; authentication, transport, or registry errors are not an absent version'
    );
}

function npmView(spec, field) {
    const result = spawnSync(
        'npm',
        [
            'view',
            spec,
            field,
            '--json',
            '--registry',
            REGISTRY,
            '--fetch-retries=0',
            '--fetch-timeout=15000',
        ],
        {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 20_000,
            maxBuffer: 1024 * 1024,
        }
    );
    return registryValue(result);
}

async function publish(directory) {
    assert.equal(
        process.env.CODE_PACKAGE_PUBLISH,
        'true',
        'Publishing requires explicit workflow authorization'
    );
    assert.equal(
        process.env.GITHUB_ACTIONS,
        'true',
        'Publish only from the trusted GitHub workflow'
    );
    assert.ok(
        process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
        'Trusted publishing OIDC is unavailable'
    );
    const candidate = await verifyCandidate(resolve(directory));
    releasePlan(
        candidate.version,
        process.env.GITHUB_EVENT_NAME,
        process.env.GITHUB_REF,
        process.env.EXPECTED_VERSION
    );
    assert.equal(
        run('git', ['rev-parse', 'HEAD']).trim(),
        candidate.sha,
        'Candidate must match the checked-out source commit'
    );
    run('git', [
        'merge-base',
        '--is-ancestor',
        candidate.sha,
        'refs/remotes/origin/main',
    ]);
    const decision = publicationDecision(
        candidate,
        npmView(`${PACKAGE_NAME}@${candidate.version}`, 'dist.integrity'),
        npmView(PACKAGE_NAME, 'dist-tags') ?? {}
    );
    if (decision === 'skip') {
        console.log(
            'Identical package version is already published; no package or dist-tag changes made.'
        );
        return;
    }
    run(
        'npm',
        [
            'publish',
            resolve(directory, candidate.filename),
            '--ignore-scripts',
            '--access',
            'public',
            '--tag',
            candidate.tag,
            '--registry',
            REGISTRY,
        ],
        { stdio: 'inherit', timeout: 180_000 }
    );
    assert.equal(
        npmView(`${PACKAGE_NAME}@${candidate.version}`, 'dist.integrity'),
        candidate.integrity,
        'Published artifact integrity does not match the tested candidate'
    );
    console.log(
        `Verified published ${PACKAGE_NAME}@${candidate.version} (${candidate.tag}).`
    );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        const [command, directory] = process.argv.slice(2);
        if (command === 'plan') await plan();
        else if (command === 'pack' && directory) await pack(directory);
        else if (command === 'verify' && directory) {
            const candidate = await verifyCandidate(resolve(directory));
            await output({
                filename: candidate.filename,
                version: candidate.version,
                tag: candidate.tag,
            });
        } else if (command === 'publish' && directory) await publish(directory);
        else
            throw new Error(
                'Usage: code-package-release.mjs plan | pack|verify|publish <directory>'
            );
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
