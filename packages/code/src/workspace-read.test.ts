import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { FileHandle } from 'node:fs/promises';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';
import { WorkspaceRootAccess } from './root-access.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { readRepositoryInstructions } from './instructions.js';
import {
    BRIDGE_WORKSPACE_READ_MAX_BYTES as MAX_BYTES,
    isWorkspaceToolResult,
} from './protocol.js';
import type { WorkspaceReadFileRequest } from './protocol.js';

async function fixture(t: TestContext, held = false) {
    const parent = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'workspace-read-'))
    );
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'root');
    await fs.mkdir(root);
    const tools = await LocalWorkspaceTools.create({
        workspaces: [
            {
                id: 'primary',
                root,
                writable: true,
                ...(held
                    ? { identity: await captureWorkspaceRootIdentity(root) }
                    : {}),
            },
        ],
        repositoryInstructions: true,
    });
    const read = async (
        startLine?: number,
        maxLines?: number,
        signal?: AbortSignal,
        path = 'file'
    ) => {
        const request: WorkspaceReadFileRequest = {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(maxLines !== undefined ? { maxLines } : {}),
        };
        const result = await tools.execute(request, signal);
        assert.ok(
            isWorkspaceToolResult(request, result),
            'current protocol accepts the window'
        );
        assert.equal(result.operation, 'read_file');
        return result;
    };
    const probe = await fs.open(join(root, 'file'), 'w+');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    return { parent, root, tools, read, prototype };
}

function hasCode(code: string) {
    return (error: unknown) =>
        error instanceof WorkspaceToolError && error.code === code;
}

test('small windows from large files use bounded descriptor reads, not readFile', async t => {
    const { root, read, prototype } = await fixture(t, true);
    await fs.writeFile(
        join(root, 'file'),
        'first\nsecond\n' + 'tail\n'.repeat(300_000)
    );
    const originalRead = prototype.read;
    let bytesRead = 0;
    t.mock.method(prototype, 'readFile', () => assert.fail('whole-file read'));
    t.mock.method(
        prototype,
        'read',
        async function (
            this: FileHandle,
            ...args: Parameters<typeof originalRead>
        ) {
            const result = await originalRead.apply(this, args);
            bytesRead += result.bytesRead;
            return result;
        }
    );
    const result = await read(1, 2);
    assert.equal(result.content, 'first\nsecond');
    assert.equal(result.nextStartLine, 3);
    assert.ok(bytesRead <= 64 * 1024 + 3);
});

test('sequential line and byte pagination reconstructs large content exactly', async t => {
    const { root, read } = await fixture(t);
    const lines = Array.from(
        { length: 1_201 },
        (_, i) => `${i}: ${'é🦊'.repeat(300)}`
    );
    await fs.writeFile(join(root, 'file'), '\ufeff' + lines.join('\n') + '\n');
    const collected: string[] = [];
    let start = 1;
    for (;;) {
        const result = await read(start, 500);
        assert.ok(Buffer.byteLength(result.content) <= MAX_BYTES);
        collected.push(...result.content.split('\n'));
        assert.equal(result.endLine, collected.length);
        if (!result.truncated) break;
        assert.ok(result.nextStartLine! > start);
        start = result.nextStartLine!;
    }
    assert.deepEqual(collected, lines);
    const defaults = await read();
    assert.equal(defaults.endLine, 200);
    assert.equal(defaults.nextStartLine, 201);
});

test('byte ceilings include separators and never split or repeat an oversized line', async t => {
    const { root, read } = await fixture(t);
    const exact = 'a'.repeat(MAX_BYTES);
    await fs.writeFile(
        join(root, 'file'),
        exact + '\nx\n' + 'z'.repeat(MAX_BYTES + 1)
    );
    const first = await read(1, 500);
    assert.equal(first.content, exact);
    assert.equal(first.nextStartLine, 2);
    const second = await read(2, 500);
    assert.equal(second.content, 'x');
    assert.equal(second.nextStartLine, 3);
    await assert.rejects(read(3), error => {
        assert.ok(hasCode('READ_LIMIT_EXCEEDED')(error));
        assert.match(
            (error as Error).message,
            /line 3.*later startLine.*search_text/
        );
        assert.ok((error as Error).message.length < 300);
        return true;
    });
    await fs.writeFile(
        join(root, 'file'),
        'a'.repeat(MAX_BYTES - 2) + '\nb\nc'
    );
    const separators = await read(1, 500);
    assert.equal(Buffer.byteLength(separators.content), MAX_BYTES);
    assert.equal(separators.endLine, 2);
    assert.equal(separators.nextStartLine, 3);
});

test('EOF, empty lines, CRLF, BOM-only files, and starts beyond EOF retain their contract', async t => {
    const { root, read } = await fixture(t);
    for (const [source, expected] of [
        ['', ['']],
        ['\ufeff', ['']],
        ['\n', ['']],
        ['\n\n', ['', '']],
        ['a\n', ['a']],
        ['a\r\nb\r\n', ['a\r', 'b\r']],
        ['a\nb', ['a', 'b']],
        ['\ufeff\ufeffa', ['\ufeffa']],
    ] as const) {
        await fs.writeFile(join(root, 'file'), source);
        for (let line = 1; line <= expected.length; line++) {
            const result = await read(line, 1);
            assert.equal(result.content, expected[line - 1]);
            assert.equal(result.endLine, line);
            assert.equal(result.truncated, line < expected.length);
        }
        const past = await read(expected.length + 1);
        assert.equal(past.content, '');
        assert.equal(past.endLine, expected.length);
        assert.equal(past.truncated, false);
    }
});

test('streaming decoding handles short reads, split UTF-8, CRLF, and UTF-16 surrogates', async t => {
    const { root, read, prototype } = await fixture(t);
    const originalRead = prototype.read;
    t.mock.method(
        prototype,
        'read',
        async function (
            this: FileHandle,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number
        ) {
            return originalRead.call(this, {
                buffer,
                offset,
                length: Math.min(length, 1),
                position,
            });
        }
    );
    const text = 'é🦊\r\n\ufeffsecond\n';
    const little = Buffer.from(text, 'utf16le');
    const big = Buffer.from(little).swap16();
    for (const source of [
        Buffer.from('\ufeff' + text),
        Buffer.concat([Buffer.from([0xff, 0xfe]), little]),
        Buffer.concat([Buffer.from([0xfe, 0xff]), big]),
    ]) {
        await fs.writeFile(join(root, 'file'), source);
        const result = await read();
        assert.equal(result.content, 'é🦊\r\n\ufeffsecond');
        assert.equal(result.endLine, 2);
        assert.equal(result.truncated, false);
    }
});

test('UTF-8 replacement decoding and binary bytes are bounded text, not file validation', async t => {
    const { root, read } = await fixture(t);
    await fs.writeFile(
        join(root, 'file'),
        Buffer.from([0x61, 0x0a, 0xff, 0x00, 0xe2, 0x82])
    );
    const first = await read(1, 1);
    assert.equal(first.content, 'a');
    assert.equal(first.truncated, true);
    const second = await read(2);
    assert.equal(second.content, '\ufffd\0\ufffd');
    await fs.writeFile(join(root, 'file'), Buffer.alloc(MAX_BYTES / 2, 0xff));
    await assert.rejects(read(), hasCode('READ_LIMIT_EXCEEDED'));
});

test('scanning skips huge earlier lines without accumulating them', async t => {
    const { root, read } = await fixture(t);
    await fs.writeFile(
        join(root, 'file'),
        'x'.repeat(4 * MAX_BYTES) + '\nrequested\n'
    );
    assert.equal((await read(2, 1)).content, 'requested');
});

test('cancellation during scanning and collection closes every read handle', async t => {
    for (const startLine of [1, 300_000]) {
        const { root, read, prototype } = await fixture(t);
        await fs.writeFile(join(root, 'file'), 'line\n'.repeat(300_000));
        const controller = new AbortController();
        const originalRead = prototype.read;
        const handles = new Set<FileHandle>();
        let calls = 0;
        const mock = t.mock.method(
            prototype,
            'read',
            async function (
                this: FileHandle,
                ...args: Parameters<typeof originalRead>
            ) {
                handles.add(this);
                const result = await originalRead.apply(this, args);
                if (++calls === 2) controller.abort();
                return result;
            }
        );
        await assert.rejects(
            read(startLine, 500, controller.signal),
            hasCode('EXECUTION_ABORTED')
        );
        assert.ok(handles.size > 0);
        for (const handle of handles) assert.equal(handle.fd, -1);
        mock.mock.restore();
    }
});

test('far-away starts hit the scan deadline and close the descriptor', async t => {
    const { root, read, prototype } = await fixture(t);
    await fs.writeFile(join(root, 'file'), 'line\n'.repeat(300_000));
    const originalRead = prototype.read;
    const now = performance.now();
    let elapsed = 0;
    let handle: FileHandle | undefined;
    t.mock.method(performance, 'now', () => now + elapsed);
    t.mock.method(
        prototype,
        'read',
        async function (
            this: FileHandle,
            ...args: Parameters<typeof originalRead>
        ) {
            handle = this;
            const result = await originalRead.apply(this, args);
            elapsed += 6_000;
            return result;
        }
    );
    await assert.rejects(read(300_000), hasCode('READ_LIMIT_EXCEEDED'));
    assert.equal(handle?.fd, -1);
});

test('growth is capped at the opened extent and truncation produces a valid EOF window', async t => {
    for (const change of ['grow', 'truncate'] as const) {
        const { root, read, prototype } = await fixture(t);
        const path = join(root, 'file');
        await fs.writeFile(path, 'first\nsecond\n');
        const originalRead = prototype.read;
        let calls = 0;
        const mock = t.mock.method(
            prototype,
            'read',
            async function (
                this: FileHandle,
                ...args: Parameters<typeof originalRead>
            ) {
                const result = await originalRead.apply(this, args);
                if (++calls === 1) {
                    if (change === 'grow')
                        await fs.appendFile(path, 'appended\n');
                    else await fs.truncate(path, 3);
                }
                return result;
            }
        );
        const result = await read();
        assert.equal(
            result.content,
            change === 'grow' ? 'first\nsecond' : 'fir'
        );
        assert.equal(result.truncated, false);
        mock.mock.restore();
    }
});

test('file and root replacement cannot redirect a held streaming read; descriptors close', async t => {
    const { parent, root, read, prototype } = await fixture(t, true);
    const path = join(root, 'file');
    await fs.writeFile(path, 'original\n' + 'inside\n'.repeat(200_000));
    await fs.writeFile(join(parent, 'secret'), 'outside secret');
    const originalRead = prototype.read;
    const originalOpen = WorkspaceRootAccess.open;
    let rootHandle: FileHandle | undefined;
    let fileHandle: FileHandle | undefined;
    t.mock.method(
        WorkspaceRootAccess,
        'open',
        async (...args: Parameters<typeof originalOpen>) => {
            const access = await originalOpen(...args);
            rootHandle = access.handle;
            return access;
        }
    );
    let calls = 0;
    t.mock.method(
        prototype,
        'read',
        async function (
            this: FileHandle,
            ...args: Parameters<typeof originalRead>
        ) {
            fileHandle = this;
            const result = await originalRead.apply(this, args);
            if (++calls === 1) {
                await fs.rename(path, join(root, 'old-file'));
                await fs.symlink(join(parent, 'secret'), path);
                await fs.rename(root, join(parent, 'old-root'));
                await fs.mkdir(root);
                await fs.writeFile(path, 'replacement');
            }
            return result;
        }
    );
    const result = await read(2, 500);
    assert.equal(result.content, Array(500).fill('inside').join('\n'));
    assert.equal(result.nextStartLine, 502);
    assert.equal(fileHandle?.fd, -1);
    assert.equal(rootHandle?.fd, -1);
    await assert.rejects(read(), hasCode('REGISTRATION_INVALID'));
});

test('oversized lines and I/O failures close file and held-root descriptors', async t => {
    const { root, read, prototype } = await fixture(t, true);
    const originalRead = prototype.read;
    const originalOpen = WorkspaceRootAccess.open;
    let fileHandle: FileHandle | undefined;
    let rootHandle: FileHandle | undefined;
    t.mock.method(
        WorkspaceRootAccess,
        'open',
        async (...args: Parameters<typeof originalOpen>) => {
            const access = await originalOpen(...args);
            rootHandle = access.handle;
            return access;
        }
    );
    t.mock.method(
        prototype,
        'read',
        async function (
            this: FileHandle,
            ...args: Parameters<typeof originalRead>
        ) {
            fileHandle = this;
            return originalRead.apply(this, args);
        }
    );
    await fs.writeFile(join(root, 'file'), 'x'.repeat(MAX_BYTES + 1));
    await assert.rejects(read(), hasCode('READ_LIMIT_EXCEEDED'));
    assert.equal(fileHandle?.fd, -1);
    assert.equal(rootHandle?.fd, -1);
    t.mock.method(prototype, 'read', async function (this: FileHandle) {
        fileHandle = this;
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
    });
    await assert.rejects(read(), hasCode('INVALID_PATH'));
    assert.equal(fileHandle?.fd, -1);
    assert.equal(rootHandle?.fd, -1);
});

test('search, preview, edit, and digest-checked instruction limits remain separate', async t => {
    const { root, tools } = await fixture(t, true);
    await fs.writeFile(join(root, 'file'), 'needle\n'.repeat(200_000));
    const search = await tools.execute({
        protocolVersion: 1,
        operation: 'search_text',
        workspaceId: 'primary',
        path: 'file',
        query: 'needle',
    });
    assert.equal(search.operation, 'search_text');
    assert.deepEqual(search.matches, []);
    for (const operation of ['preview_edit', 'edit_file'] as const) {
        await assert.rejects(
            tools.execute({
                protocolVersion: 1,
                operation,
                workspaceId: 'primary',
                path: 'file',
                oldText: 'needle',
                newText: 'changed',
            }),
            hasCode(
                operation === 'preview_edit'
                    ? 'READ_LIMIT_EXCEEDED'
                    : 'WRITE_LIMIT_EXCEEDED'
            )
        );
    }
    await fs.writeFile(
        join(root, 'AGENTS.md'),
        'instructions\n'.repeat(200_000)
    );
    const snapshot = await readRepositoryInstructions(root);
    assert.ok(snapshot);
    const request: WorkspaceReadFileRequest = {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'AGENTS.md',
        instructionSha256: snapshot.descriptor.sha256,
    };
    const result = await tools.execute(request);
    assert.ok(isWorkspaceToolResult(request, result));
    assert.equal(result.operation, 'read_file');
    assert.equal(result.content, snapshot.content);
    assert.equal(result.truncated, true);
    assert.equal(result.nextStartLine, undefined);
    await fs.writeFile(join(root, 'AGENTS.md'), 'changed');
    await assert.rejects(tools.execute(request), hasCode('INVALID_PATH'));
});

test('byte-budget pagination reconstructs every complete line', async t => {
    const { root, read } = await fixture(t);
    const lines = Array.from(
        { length: 1_201 },
        (_, i) => `${i}: ${'é🦊'.repeat(400)}`
    );
    await fs.writeFile(join(root, 'file'), lines.join('\n') + '\n');
    const collected: string[] = [];
    let startLine = 1;
    for (;;) {
        const result = await read(startLine, 500);
        const selected = result.content.split('\n');
        assert.ok(Buffer.byteLength(result.content) <= MAX_BYTES);
        if (result.truncated)
            assert.ok(selected.length < 500, 'bytes forced continuation');
        collected.push(...selected);
        if (!result.truncated) break;
        assert.ok(result.nextStartLine! > startLine);
        startLine = result.nextStartLine!;
    }
    assert.deepEqual(collected, lines);
});
