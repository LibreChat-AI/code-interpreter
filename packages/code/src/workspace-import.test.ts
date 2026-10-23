import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import {
  isBridgeWorkspaceImportFileRequest,
  isRelayedWorkspaceImportFileRequest,
  isValidBridgeWorkspaceToolCapabilities,
  isWorkspaceImportFilePath,
  isWorkspaceToolRequest,
  isWorkspaceToolResult,
} from './protocol.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { BridgeWorker } from './worker.js';
import { createWorkspaceFileImporter, HttpWorkspaceFileImporter } from './workspace-import.js';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';

import type { WorkspaceImportFileRequest, WorkspaceToolRequest } from './protocol.js';
import type { HttpWorkspaceFileImporterOptions } from './workspace-import.js';

const GRANT = 'ceg1.grant-for-one-object';
const SESSION = 'session-handle';
const OBJECT = 'object-handle';
const incarnationId = 'incarnation-00000001';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function importRequest(
  bytes: Buffer,
  overrides: Partial<WorkspaceImportFileRequest> = {},
): WorkspaceImportFileRequest {
  return {
    protocolVersion: 1,
    operation: 'import_file',
    workspaceId: 'primary',
    path: 'uploads/archive.zip',
    source: { storage_session_id: SESSION, id: OBJECT },
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    egressGrant: GRANT,
    ...overrides,
  };
}

interface EgressStub {
  url: string;
  hits: number;
  body: Buffer;
  /** Replace the default response (exact body, declared length, valid grant). */
  respond?: (req: IncomingMessage, res: ServerResponse) => void;
}

/** A local egress gateway: serves one object to one grant, like the real object route. */
async function egressStub(t: TestContext, body: Buffer): Promise<EgressStub> {
  const stub: EgressStub = { url: '', hits: 0, body };
  const server = createServer((req, res) => {
    stub.hits += 1;
    if (stub.respond) return stub.respond(req, res);
    if (
      req.method !== 'GET' ||
      req.url !== `/v1/egress/sessions/${SESSION}/objects/${OBJECT}` ||
      req.headers['x-codeapi-egress-grant'] !== GRANT
    ) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-length': String(stub.body.byteLength) }).end(stub.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/egress`;
  return stub;
}

async function workspace(
  t: TestContext,
  stub: EgressStub,
  options: { writable?: boolean; held?: boolean; importer?: Partial<HttpWorkspaceFileImporterOptions> } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'librechat-code-import-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    importer: new HttpWorkspaceFileImporter({ upstreamUrl: stub.url, ...options.importer }),
    workspaces: [{
      id: 'primary',
      root,
      writable: options.writable ?? true,
      ...(options.held === false ? {} : { identity: await captureWorkspaceRootIdentity(root) }),
    }],
  });
  return { root, tools };
}

async function rejection(promise: Promise<unknown>): Promise<WorkspaceToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkspaceToolError, String(error));
    return error;
  }
  assert.fail('expected a WorkspaceToolError');
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith('.tmp'));
}

test('import requests follow write_file path rules and refuse Git metadata', () => {
  const bytes = Buffer.from('payload');
  assert.equal(isWorkspaceToolRequest(importRequest(bytes)), true);
  for (const path of [
    '../escape.bin', '/etc/passwd', 'C:/x.bin', 'a\\b.bin', 'dir/', 'dir/.', '.git', '.git/config',
    'src/.git/hooks/pre-commit', '.GIT/config', '.Git./x', 'a/.git /x', 'GIT~1/config', '.g\u200cit/config',
    '.git::$INDEX_ALLOCATION/config', '.GIT:stream', '.git. ::$INDEX_ALLOCATION/hooks/x', 'git~1::$INDEX_ALLOCATION/x',
  ]) {
    assert.equal(isWorkspaceImportFilePath(path), false, path);
    assert.equal(isWorkspaceToolRequest(importRequest(bytes, { path })), false, path);
  }
  for (const path of ['archive.zip', 'uploads/photo.png', '.gitignore', '.github/workflow.yml', 'docs/.gitkeep', 'notes/10:30 standup.md']) {
    assert.equal(isWorkspaceImportFilePath(path), true, path);
  }
  for (const invalid of [
    { sha256: 'A'.repeat(64) },
    { sha256: 'a'.repeat(63) },
    { bytes: -1 },
    { bytes: 1.5 },
    { source: { storage_session_id: SESSION } },
    { source: { storage_session_id: SESSION, id: OBJECT, name: 'x' } },
    { source: { storage_session_id: 'a\nb', id: OBJECT } },
    { overwrite: 'yes' },
    { egressGrant: '' },
  ] as Array<Record<string, unknown>>) {
    assert.equal(isWorkspaceToolRequest({ ...importRequest(bytes), ...invalid }), false, JSON.stringify(invalid));
  }
  assert.equal(isWorkspaceToolRequest({ ...importRequest(bytes), content: 'x' }), false);

  const { egressGrant: _grant, ...callerRequest } = importRequest(bytes);
  assert.equal(isBridgeWorkspaceImportFileRequest(callerRequest), true);
  assert.equal(isBridgeWorkspaceImportFileRequest(importRequest(bytes)), false, 'callers never supply the grant');
  assert.equal(isRelayedWorkspaceImportFileRequest(importRequest(bytes)), true);
  assert.equal(isRelayedWorkspaceImportFileRequest(callerRequest), false);
});

test('import results must echo the request and account for every byte', () => {
  const bytes = Buffer.from('payload');
  const request = importRequest(bytes);
  const result = {
    protocolVersion: 1,
    operation: 'import_file',
    workspaceId: 'primary',
    path: request.path,
    created: true,
    bytesWritten: bytes.byteLength,
    sha256: request.sha256,
  };
  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(isWorkspaceToolResult(request, { ...result, created: false, unchanged: true, bytesWritten: 0 }), true);
  assert.equal(isWorkspaceToolResult(request, { ...result, created: false, unchanged: true }), false);
  assert.equal(isWorkspaceToolResult(request, { ...result, unchanged: true, bytesWritten: 0 }), false);
  assert.equal(isWorkspaceToolResult(request, { ...result, created: false }), false, 'a create cannot replace');
  assert.equal(isWorkspaceToolResult({ ...request, overwrite: true }, { ...result, created: false }), true);
  assert.equal(isWorkspaceToolResult(request, { ...result, bytesWritten: 3 }), false);
  assert.equal(isWorkspaceToolResult(request, { ...result, sha256: 'b'.repeat(64) }), false);
  assert.equal(isWorkspaceToolResult(request, { ...result, path: 'other.zip' }), false);
  assert.equal(isWorkspaceToolResult(request, { ...result, content: 'x' }), false);
});

test('a worker imports by default whenever it can, and an explicit opt-out removes it', async (t) => {
  const upstreamUrl = 'https://code.example.test/egress';
  const enabled = createWorkspaceFileImporter({ optOut: false, writable: true, upstreamUrl });
  assert.ok(enabled instanceof HttpWorkspaceFileImporter, 'on by default');
  for (const value of ['true', ' TRUE ', '']) {
    assert.ok(createWorkspaceFileImporter({ optOut: false, enabled: value, writable: true, upstreamUrl }));
  }
  assert.equal(createWorkspaceFileImporter({ optOut: true, writable: true, upstreamUrl }), undefined, '--no-workspace-imports');
  assert.equal(createWorkspaceFileImporter({ optOut: false, enabled: 'false', writable: true, upstreamUrl }), undefined);
  assert.equal(createWorkspaceFileImporter({ optOut: false, enabled: 'False', writable: true, upstreamUrl }), undefined);
  assert.equal(createWorkspaceFileImporter({ optOut: false, writable: true }), undefined, 'no relay upstream');
  assert.equal(createWorkspaceFileImporter({ optOut: false, writable: true, upstreamUrl: '  ' }), undefined);
  assert.equal(createWorkspaceFileImporter({ optOut: false, writable: false, upstreamUrl }), undefined, 'writes disabled');
  assert.throws(() => createWorkspaceFileImporter({ optOut: false, enabled: 'yes', writable: true, upstreamUrl }), /must be true or false/);
  assert.equal(createWorkspaceFileImporter({ optOut: false, writable: true, upstreamUrl, maxBytes: 4096 })?.maxBytes, 4096);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'librechat-code-import-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const advertised = await LocalWorkspaceTools.create({ importer: enabled, workspaces: [{ id: 'primary', root, writable: true }] });
  assert.ok(advertised.capabilities.operations.includes('import_file'));
  const optedOut = await LocalWorkspaceTools.create({
    importer: createWorkspaceFileImporter({ optOut: true, writable: true, upstreamUrl }),
    workspaces: [{ id: 'primary', root, writable: true }],
  });
  assert.equal(optedOut.capabilities.operations.includes('import_file'), false);
});

test('import_file is advertised only beside writes, on writable roots, with an importer', async (t) => {
  const stub = await egressStub(t, Buffer.from('x'));
  const writable = await realpath(await mkdtemp(join(tmpdir(), 'librechat-code-import-')));
  const readOnly = await realpath(await mkdtemp(join(tmpdir(), 'librechat-code-import-')));
  t.after(() => Promise.all([rm(writable, { recursive: true }), rm(readOnly, { recursive: true })]));
  const importer = new HttpWorkspaceFileImporter({ upstreamUrl: stub.url });

  const mixed = await LocalWorkspaceTools.create({
    importer,
    workspaces: [{ id: 'primary', root: writable, writable: true }, { id: 'docs', root: readOnly }],
  });
  assert.ok(mixed.capabilities.operations.includes('import_file'));
  assert.ok(mixed.capabilities.workspaces[0]?.operations?.includes('import_file'));
  assert.equal(mixed.capabilities.workspaces[1]?.operations?.includes('import_file'), false);
  assert.equal(isValidBridgeWorkspaceToolCapabilities(mixed.capabilities), true);
  const denied = await rejection(mixed.execute({ ...importRequest(Buffer.from('x')), workspaceId: 'docs' }));
  assert.equal(denied.code, 'WRITE_DISABLED');
  assert.equal(stub.hits, 0);

  const allReadOnly = await LocalWorkspaceTools.create({ importer, workspaces: [{ id: 'docs', root: readOnly }] });
  assert.equal(allReadOnly.capabilities.operations.includes('import_file'), false);
  const withoutRelay = await LocalWorkspaceTools.create({ workspaces: [{ id: 'primary', root: writable, writable: true }] });
  assert.equal(withoutRelay.capabilities.operations.includes('import_file'), false);
  assert.equal((await rejection(withoutRelay.execute(importRequest(Buffer.from('x'))))).code, 'WRITE_UNAVAILABLE');
});

test('imports binary bytes atomically into new 0755 parents as a 0644 file, whatever the umask', async (t) => {
  const bytes = Buffer.concat([Buffer.from([0, 0xff, 0x50, 0x4b, 3, 4, 0]), randomBytes(256 * 1024)]);
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const request = importRequest(bytes, { path: 'uploads/2026/archive.zip' });
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));

  const result = await tools.execute(request);
  assert.deepEqual(result, {
    protocolVersion: 1,
    operation: 'import_file',
    workspaceId: 'primary',
    path: request.path,
    created: true,
    bytesWritten: bytes.byteLength,
    sha256: request.sha256,
  });
  assert.equal(isWorkspaceToolResult(request, result), true);
  const target = join(root, 'uploads', '2026', 'archive.zip');
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  assert.equal((await stat(join(root, 'uploads'))).mode & 0o777, 0o755);
  assert.equal((await stat(join(root, 'uploads', '2026'))).mode & 0o777, 0o755);
  assert.deepEqual(await temporaryFiles(join(root, 'uploads', '2026')), []);
  assert.equal(stub.hits, 1);
});

test('re-importing identical bytes is idempotent and never downloads again', async (t) => {
  const bytes = randomBytes(4096);
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const request = importRequest(bytes, { path: 'photo.png' });
  await tools.execute(request);
  const installed = await stat(join(root, 'photo.png'));

  const again = await tools.execute(request);
  assert.deepEqual(again, {
    protocolVersion: 1,
    operation: 'import_file',
    workspaceId: 'primary',
    path: 'photo.png',
    created: false,
    unchanged: true,
    bytesWritten: 0,
    sha256: request.sha256,
  });
  assert.equal(isWorkspaceToolResult(request, again), true);
  assert.equal(stub.hits, 1);
  assert.equal((await stat(join(root, 'photo.png'))).ino, installed.ino);
});

test('different existing content conflicts unless overwrite is explicit', async (t) => {
  const bytes = Buffer.from('new report');
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const target = join(root, 'report.pdf');
  await writeFile(target, 'old report');
  await chmod(target, 0o755);

  const conflict = await rejection(tools.execute(importRequest(bytes, { path: 'report.pdf' })));
  assert.equal(conflict.code, 'EDIT_CONFLICT');
  assert.equal(conflict.mutationMayHaveCommitted, false);
  assert.equal(await readFile(target, 'utf8'), 'old report');
  assert.equal(stub.hits, 0, 'a conflict is decided before any transfer');

  const replaced = await tools.execute(importRequest(bytes, { path: 'report.pdf', overwrite: true }));
  assert.equal((replaced as { created: boolean }).created, false);
  assert.equal(await readFile(target, 'utf8'), 'new report');
  assert.equal((await stat(target)).mode & 0o777, 0o644, 'an import is never executable');
});

test('a hash or size mismatch installs nothing and removes the parents it created', async (t) => {
  const bytes = Buffer.from('expected bytes');
  const stub = await egressStub(t, Buffer.from('tampered bytes'));
  const { root, tools } = await workspace(t, stub);

  const mismatch = await rejection(tools.execute(importRequest(bytes, { path: 'fresh/dir/file.bin' })));
  assert.equal(mismatch.code, 'INVALID_REQUEST');
  assert.equal(mismatch.mutationMayHaveCommitted, false);
  assert.match(mismatch.message, /SHA-256/);
  assert.deepEqual(await readdir(root), [], 'created parents are rolled back');

  stub.respond = (_req, res) => {
    res.writeHead(200);
    res.write(bytes);
    res.end(Buffer.from('and then some'));
  };
  const oversize = await rejection(tools.execute(importRequest(bytes, { path: 'file.bin' })));
  assert.equal(oversize.code, 'INVALID_REQUEST');
  assert.match(oversize.message, /larger than its declared size/);

  stub.respond = (_req, res) => res.writeHead(200, { 'content-length': '3' }).end('abc');
  const declared = await rejection(tools.execute(importRequest(bytes, { path: 'file.bin' })));
  assert.equal(declared.code, 'INVALID_REQUEST');

  stub.respond = (_req, res) => res.writeHead(200).end(bytes.subarray(0, 4));
  const short = await rejection(tools.execute(importRequest(bytes, { path: 'file.bin' })));
  assert.match(short.message, /smaller than its declared size/);
  assert.deepEqual(await readdir(root), []);
});

test('the staged file is verified after it is synced, not only the bytes that arrived', async (t) => {
  const bytes = randomBytes(64 * 1024);
  const stub = await egressStub(t, bytes);
  const { root } = await workspace(t, stub);
  const relay = new HttpWorkspaceFileImporter({ upstreamUrl: stub.url });
  const tools = await LocalWorkspaceTools.create({
    importer: {
      maxBytes: relay.maxBytes,
      availableBytes: (directory) => relay.availableBytes(directory),
      async open(request, signal) {
        const chunks = await relay.open(request, signal);
        return (async function* tamper() {
          let first = true;
          for await (const chunk of chunks) {
            yield chunk;
            if (!first) continue;
            first = false;
            // Another local writer rewrites already-staged bytes before the transfer finishes.
            const [staged] = await temporaryFiles(root);
            assert.ok(staged);
            await writeFile(join(root, staged), Buffer.alloc(chunk.byteLength, 0x41), { flag: 'r+' });
          }
        })();
      },
    },
    workspaces: [{ id: 'primary', root, writable: true, identity: await captureWorkspaceRootIdentity(root) }],
  });
  const tampered = await rejection(tools.execute(importRequest(bytes, { path: 'payload.bin' })));
  assert.equal(tampered.code, 'INVALID_REQUEST');
  assert.match(tampered.message, /SHA-256/);
  assert.deepEqual(await readdir(root), []);
});

test('rollback never removes a directory that replaced one the import created', async (t) => {
  const bytes = randomBytes(32 * 1024);
  const stub = await egressStub(t, Buffer.concat([bytes.subarray(0, 1024), Buffer.alloc(bytes.byteLength - 1024)]));
  const { root } = await workspace(t, stub);
  const relay = new HttpWorkspaceFileImporter({ upstreamUrl: stub.url });
  const tools = await LocalWorkspaceTools.create({
    importer: {
      maxBytes: relay.maxBytes,
      availableBytes: (directory) => relay.availableBytes(directory),
      async open(request, signal) {
        const chunks = await relay.open(request, signal);
        return (async function* swap() {
          for await (const chunk of chunks) yield chunk;
          // Another local process moves the new parent aside and makes its own at that path.
          await rename(join(root, 'incoming'), join(root, 'moved'));
          await mkdir(join(root, 'incoming'));
        })();
      },
    },
    workspaces: [{ id: 'primary', root, writable: true, identity: await captureWorkspaceRootIdentity(root) }],
  });
  const failed = await rejection(tools.execute(importRequest(bytes, { path: 'incoming/file.bin' })));
  assert.equal(failed.code, 'INVALID_REQUEST');
  assert.equal(failed.mutationMayHaveCommitted, true, 'an unremovable created parent is reported, not hidden');
  assert.equal((await stat(join(root, 'incoming'))).isDirectory(), true);
});

test('the stall timeout covers waiting on the source, not slow consumer writes', async (t) => {
  const bytes = randomBytes(8 * 1024);
  const stub = await egressStub(t, bytes);
  stub.respond = (_req, res) => {
    res.writeHead(200, { 'content-length': String(bytes.byteLength) });
    res.write(bytes.subarray(0, 4096));
    setTimeout(() => res.end(bytes.subarray(4096)), 10);
  };
  const importer = new HttpWorkspaceFileImporter({ upstreamUrl: stub.url, stallTimeoutMs: 50 });
  const received: Buffer[] = [];
  for await (const chunk of await importer.open(importRequest(bytes) as WorkspaceImportFileRequest & { egressGrant: string })) {
    received.push(Buffer.from(chunk));
    await delay(150);
  }
  assert.deepEqual(Buffer.concat(received), bytes);
});

test('file and free-space limits fail before anything is written', async (t) => {
  const bytes = randomBytes(2048);
  const stub = await egressStub(t, bytes);
  const small = await workspace(t, stub, { importer: { maxBytes: 1024 } });
  const tooLarge = await rejection(small.tools.execute(importRequest(bytes, { path: 'big.bin' })));
  assert.equal(tooLarge.code, 'WRITE_LIMIT_EXCEEDED');
  assert.equal(stub.hits, 0);

  const full = await workspace(t, stub, { importer: { availableBytes: async () => 4096 } });
  const noSpace = await rejection(full.tools.execute(importRequest(bytes, { path: 'big.bin' })));
  assert.equal(noSpace.code, 'WRITE_LIMIT_EXCEEDED');
  assert.match(noSpace.message, /free space/);
  assert.equal(stub.hits, 0);
  assert.deepEqual(await readdir(full.root), []);
});

test('imports refuse symlinked parents, Git metadata, and requests without a grant', async (t) => {
  const bytes = Buffer.from('payload');
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'librechat-code-import-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'alias'));
  await symlink(outside, join(root, 'escape'));
  await mkdir(join(root, '.git'));

  for (const path of ['alias/file.bin', 'escape/file.bin']) {
    const refused = await rejection(tools.execute(importRequest(bytes, { path })));
    assert.equal(refused.code, 'INVALID_PATH', path);
  }
  assert.deepEqual(await readdir(join(root, 'real')), []);
  assert.deepEqual(await readdir(outside), []);

  const git = await rejection(tools.execute(importRequest(bytes, { path: '.git/hooks/post-checkout' })));
  assert.equal(git.code, 'INVALID_REQUEST');
  assert.deepEqual(await readdir(join(root, '.git')), []);

  await symlink(join(root, 'real', 'target.bin'), join(root, 'link.bin'));
  const linkTarget = await rejection(tools.execute(importRequest(bytes, { path: 'link.bin', overwrite: true })));
  assert.equal(linkTarget.code, 'INVALID_PATH');
  assert.equal((await lstat(join(root, 'link.bin'))).isSymbolicLink(), true);

  const { egressGrant: _grant, ...ungranted } = importRequest(bytes, { path: 'file.bin' });
  assert.equal((await rejection(tools.execute(ungranted))).code, 'INVALID_REQUEST');
  assert.equal(stub.hits, 0);
});

test('an unavailable or refusing relay fails cleanly as WRITE_UNAVAILABLE', async (t) => {
  const bytes = Buffer.from('payload');
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const refused = await rejection(tools.execute(importRequest(bytes, { egressGrant: 'ceg1.another-object' })));
  assert.equal(refused.code, 'WRITE_UNAVAILABLE');
  assert.equal(refused.mutationMayHaveCommitted, false);
  assert.deepEqual(await readdir(root), []);

  stub.respond = (_req, res) => {
    res.writeHead(200, { 'content-length': String(bytes.byteLength) });
    res.write(bytes.subarray(0, 2));
  };
  const stalled = await workspace(t, stub, { importer: { stallTimeoutMs: 50 } });
  const timedOut = await rejection(stalled.tools.execute(importRequest(bytes)));
  assert.equal(timedOut.code, 'WRITE_UNAVAILABLE');
  assert.match(timedOut.message, /stalled/);
  assert.deepEqual(await readdir(stalled.root), []);
});

test('a worker negotiates import_file and executes it as a guarded mutation', async (t) => {
  const bytes = randomBytes(8192);
  const stub = await egressStub(t, bytes);
  const { root, tools } = await workspace(t, stub);
  const lifecycle: string[] = [];
  const registrations: string[][] = [];
  const settlements: Array<Record<string, unknown>> = [];
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: tools.capabilities },
    workspaceTools: tools,
    workspaceMutationQuarantine: {
      async assertAvailable() {},
      async arm() { lifecycle.push('arm'); },
      async clear() { lifecycle.push('clear'); },
      async quarantine() { lifecycle.push('quarantine'); },
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = (init?.body == null ? {} : JSON.parse(String(init.body))) as Record<string, unknown>;
      if (url.endsWith('/register')) {
        registrations.push((body.capabilities as { workspaceTools: { operations: string[] } }).workspaceTools.operations);
        return Response.json({
          protocolVersion: 1, workerId: 'vm-1', incarnationId, registeredAt: new Date().toISOString(), leaseTtlMs: 60_000,
          supportedWorkspaceToolOperations: ['read_file', 'search_text', 'list_files', 'write_file', 'preview_edit', 'edit_file', 'import_file'],
          supportedWorkspaceWriteFileModes: ['replace', 'create'],
        });
      }
      if (!url.endsWith('/settle')) return Response.json({ protocolVersion: 1, cancelled: false });
      lifecycle.push('settle');
      settlements.push(body);
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  await worker.register();
  assert.ok(registrations.at(-1)?.includes('import_file'));

  const request: WorkspaceToolRequest = importRequest(bytes, { path: 'chat/upload.bin' });
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-import',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    remainingMs: 10_000,
    executionKind: 'workspace_tool',
    request,
  });
  assert.deepEqual(lifecycle, ['arm', 'settle', 'clear']);
  assert.equal(settlements[0]?.status, 'fulfilled');
  assert.deepEqual(await readFile(join(root, 'chat', 'upload.bin')), bytes);
});

test('a worker never advertises import_file to a Code API that cannot relay it', async (t) => {
  const stub = await egressStub(t, Buffer.from('x'));
  const { tools } = await workspace(t, stub);
  const registrations: string[][] = [];
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: tools.capabilities },
    workspaceTools: tools,
    workspaceMutationQuarantine: { async assertAvailable() {}, async arm() {}, async clear() {}, async quarantine() {} },
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { capabilities: { workspaceTools: { operations: string[] } } };
      registrations.push(body.capabilities.workspaceTools.operations);
      return Response.json({
        protocolVersion: 1, workerId: 'vm-1', incarnationId, registeredAt: new Date().toISOString(), leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: ['read_file', 'search_text', 'list_files', 'write_file', 'preview_edit', 'edit_file'],
        supportedWorkspaceWriteFileModes: ['replace', 'create'],
      });
    },
  });
  await worker.register();
  assert.ok(registrations.length > 0);
  for (const operations of registrations) assert.equal(operations.includes('import_file'), false);
});
