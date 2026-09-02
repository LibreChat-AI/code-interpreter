import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  isWorkspaceToolResult,
  LocalWorkspaceTools,
  WorkspaceToolError,
} from './workspace.js';

const execFileAsync = promisify(execFile);

test('reads a bounded range from a registered local workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'app.ts'),
    'first\nsecond\nthird\nfourth\n',
  );

  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  assert.deepEqual(
    await tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'src/app.ts',
      startLine: 2,
      maxLines: 2,
    }),
    {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'src/app.ts',
      content: 'second\nthird',
      startLine: 2,
      endLine: 3,
      truncated: true,
      nextStartLine: 4,
    },
  );
});

test('rejects traversal outside a registered workspace without leaking its host path', async (t) => {
  const parent = await mkdtemp(
    join(tmpdir(), 'librechat-code-workspace-parent-'),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(root);
  await writeFile(join(parent, 'secret.txt'), 'host secret');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: '../secret.txt',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid workspace/i);
      assert.equal(error.message.includes(parent), false);
      return true;
    },
  );
});

test('rejects non-scalar Unicode workspace paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '\ufffd.txt'), 'needle');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: '\ud800.txt',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'needle',
      path: '\ud800.txt',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('rejects a symlink that escapes a registered workspace', async (t) => {
  const parent = await mkdtemp(
    join(tmpdir(), 'librechat-code-workspace-parent-'),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(root);
  await writeFile(join(parent, 'secret.txt'), 'host secret');
  await symlink(join(parent, 'secret.txt'), join(root, 'linked-secret.txt'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'linked-secret.txt',
    }),
    /invalid workspace path/i,
  );
});

test('searches workspace text with a hard global result bound', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'needle one\nignore\nneedle two\n');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  assert.deepEqual(
    await tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'needle',
      maxResults: 1,
    }),
    {
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      matches: [{ path: 'notes.txt', line: 1, column: 1, text: 'needle one' }],
      truncated: true,
    },
  );
});

test('search ignores ripgrep config that follows escaping symlinks', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-code-search-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'needle secret');
  await symlink(outside, join(root, 'linked-outside'));
  const config = join(parent, 'ripgrep.conf');
  await writeFile(config, '--follow\n');
  const previousConfig = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previousConfig;
  });
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.deepEqual(result.matches, []);
});

test('search does not read an explicitly targeted escaping symlink', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-code-search-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(root);
  await writeFile(join(parent, 'secret.txt'), 'needle secret');
  await symlink(join(parent, 'secret.txt'), join(root, 'linked-secret.txt'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'needle',
      path: 'linked-secret.txt',
    }),
    /invalid workspace path/i,
  );
});

test('search returns a bounded match for a very long line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'long.txt'), `${'a'.repeat(512 * 1024)} needle`);
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.text.length, 2000);
  assert.match(result.matches[0]?.text ?? '', /needle/);
});

test('search rejects multiline literal queries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'first\nsecond',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('search rejects queries larger than its bounded preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: 'a'.repeat(2001),
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('search rejects non-scalar Unicode queries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), '\ufffd');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: 'primary',
      query: '\ud800',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('search keeps valid UTF-8 intact in a centered preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'unicode.txt'),
    `${'é'.repeat(2500)} needle ${'é'.repeat(2500)}`,
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.equal(result.matches[0]?.text.includes('\ufffd'), false);
  assert.match(result.matches[0]?.text ?? '', /needle/);
});

test('search does not split surrogate pairs in a centered preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'emoji.txt'),
    `${'\ud83d\ude00'.repeat(1500)}needle${'\ud83d\ude00'.repeat(1500)}`,
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  const preview = result.matches[0]?.text ?? '';
  assert.equal(Buffer.from(preview).toString('utf8'), preview);
  assert.match(preview, /needle/);
});

test('search strips a UTF-8 BOM before reporting columns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'utf8-bom.txt'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('needle')]),
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.deepEqual(result.matches, [
    { path: 'utf8-bom.txt', line: 1, column: 1, text: 'needle' },
  ]);
});

test('search handles invalid UTF-8 without silently dropping an ASCII match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'legacy.txt'),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(' needle\n')]),
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.path, 'legacy.txt');
});

test('search decodes BOM-marked UTF-16 text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const utf16le = Buffer.from('before needle after', 'utf16le');
  const utf16be = Buffer.from(utf16le);
  utf16be.swap16();
  await writeFile(
    join(root, 'little-endian.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]),
  );
  await writeFile(
    join(root, 'big-endian.txt'),
    Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]),
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.deepEqual(
    result.matches.map(({ path, column, text }) => ({ path, column, text })),
    [
      { path: 'big-endian.txt', column: 8, text: 'before needle after' },
      { path: 'little-endian.txt', column: 8, text: 'before needle after' },
    ],
  );

  for (const path of ['big-endian.txt', 'little-endian.txt']) {
    const read = await tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path,
    });
    if (read.operation !== 'read_file') assert.fail('expected read result');
    assert.equal(read.content, 'before needle after');
  }
});

test('read rejects a FIFO without waiting for a writer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = join(root, 'pipe');
  await execFileAsync('mkfifo', [fifo]);
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'pipe',
    }),
    /invalid workspace path/i,
  );
});

test('advertises workspace IDs and names without exposing host roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', name: 'LibreChat', root }],
  });

  assert.deepEqual(tools.capabilities, {
    protocolVersion: 1,
    operations: ['read_file', 'search_text'],
    workspaces: [{ id: 'primary', name: 'LibreChat' }],
  });
  assert.equal(JSON.stringify(tools.capabilities).includes(root), false);
});

test('rejects unbounded file read parameters before reading the file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'safe');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      startLine: 0,
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      maxLines: 501,
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'INVALID_REQUEST',
  );
});

test('bounds bytes read from a workspace file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'large.txt',
    }),
    /workspace file exceeds read limit/i,
  );
});

test('rejects ambiguous workspace registrations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    LocalWorkspaceTools.create({
      workspaces: [
        { id: 'primary', root },
        { id: 'primary', root },
      ],
    }),
    /invalid workspace registration/i,
  );
  await assert.rejects(
    LocalWorkspaceTools.create({
      workspaces: [{ id: 'primary', name: '', root }],
    }),
    /invalid workspace registration/i,
  );
});

test('rejects unsupported workspace tool protocol versions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 2,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'notes.txt',
    } as never),
    /invalid workspace tool request/i,
  );
});

test('does not start workspace I/O after its execution is aborted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'needle');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    tools.execute(
      {
        protocolVersion: 1,
        operation: 'search_text',
        workspaceId: 'primary',
        query: 'needle',
      },
      controller.signal,
    ),
    /workspace tool execution aborted/i,
  );
});

test('validates workspace results against the originating request', () => {
  const request = {
    protocolVersion: 1 as const,
    operation: 'read_file' as const,
    workspaceId: 'primary',
    path: 'README.md',
  };
  const result = {
    protocolVersion: 1 as const,
    operation: 'read_file' as const,
    workspaceId: 'primary',
    path: 'README.md',
    content: '# LibreChat',
    startLine: 1,
    endLine: 1,
    truncated: false,
  };

  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(
    isWorkspaceToolResult(request, { ...result, path: '/Users/operator/key' }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      root: '/Users/operator/private',
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      truncated: true,
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      nextStartLine: 2,
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(
      { ...request, maxLines: 1 },
      { ...result, content: 'first\nsecond' },
    ),
    false,
  );
});
