import assert from 'node:assert/strict';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { provision } from './provision.js';
import { readToken } from './credential.js';
import { endpoint } from './config.js';

test('atomic provisioning is concurrent, idempotent and restart safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credential-'));
    await chmod(root, 0o755);
    const path = join(root, 'token');
    try {
        await Promise.all(Array.from({ length: 8 }, () => provision(path)));
        const token = await readToken(path);
        assert.match(token, /^[a-f0-9]{64}$/);
        await provision(path);
        assert.equal(await readToken(path), token);
    } finally {
        await rm(root, { recursive: true });
    }
});

test('existing invalid tokens, symlinks and non-files fail closed without regeneration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credential-'));
    await chmod(root, 0o755);
    try {
        const target = join(root, 'valid');
        await writeFile(target, 'a'.repeat(64), { mode: 0o444 });
        for (const [name, value, mode] of [
            ['short', 'a', 0o444],
            ['uppercase', 'A'.repeat(64), 0o444],
            ['oversize', 'a'.repeat(4096), 0o444],
            ['writable', 'a'.repeat(64), 0o644],
        ] as const) {
            const path = join(root, name);
            await writeFile(path, value, { mode });
            await assert.rejects(provision(path));
            assert.equal(await readFile(path, 'utf8'), value);
        }
        for (const [name, destination] of [
            ['link', target],
            ['dangling', join(root, 'missing')],
        ]) {
            const path = join(root, name!);
            await symlink(destination!, path);
            await assert.rejects(provision(path));
        }
        const directory = join(root, 'directory');
        await mkdir(directory);
        await assert.rejects(readToken(directory));
    } finally {
        await rm(root, { recursive: true });
    }
});

test('endpoint defaults and deployment overrides are bounded literal IP addresses', () => {
    const previous = {
        host: process.env.EXTRACTION_HOST,
        port: process.env.EXTRACTION_PORT,
    };
    try {
        delete process.env.EXTRACTION_HOST;
        delete process.env.EXTRACTION_PORT;
        assert.deepEqual(endpoint(), { host: '0.0.0.0', port: 8000 });
        process.env.EXTRACTION_HOST = '::';
        process.env.EXTRACTION_PORT = '9000';
        assert.deepEqual(endpoint(), { host: '::', port: 9000 });
        for (const port of ['0', '65536', '08', '-1', 'x']) {
            process.env.EXTRACTION_PORT = port;
            assert.throws(endpoint);
        }
        process.env.EXTRACTION_PORT = '8000';
        process.env.EXTRACTION_HOST = '/socket/forbidden';
        assert.throws(endpoint);
    } finally {
        for (const [key, value] of [
            ['EXTRACTION_HOST', previous.host],
            ['EXTRACTION_PORT', previous.port],
        ]) {
            if (value === undefined) delete process.env[key!];
            else process.env[key!] = value;
        }
    }
});
