import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

test('lists workspace files deterministically with a hard result bound', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'src', 'app.ts'), 'export {}');
  await writeFile(join(root, 'src', 'worker.ts'), 'export {}');
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  assert.deepEqual(
    await tools.execute({
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
      maxResults: 2,
    }),
    {
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
      paths: ['docs/guide.md', 'src/app.ts'],
      truncated: true,
    },
  );
  assert.deepEqual(
    await tools.execute({
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
      path: 'src',
      maxResults: 10,
    }),
    {
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
      paths: ['src/app.ts', 'src/worker.ts'],
      truncated: false,
    },
  );
});

test('rejects listing through a directory symlink that leaves the workspace', async (t) => {
  const parent = await mkdtemp(
    join(tmpdir(), 'librechat-code-workspace-parent-'),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'host secret');
  await symlink(outside, join(root, 'linked-outside'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: 'primary',
      path: 'linked-outside',
    }),
    /invalid workspace path/i,
  );
});

test('listing preserves an in-workspace symlink namespace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.ts'), 'export const app = true;');
  await symlink(join(root, 'src'), join(root, 'alias'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
    path: 'alias',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, ['alias/app.ts']);
});

test('listing ignores ripgrep config that follows escaping symlinks', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-code-list-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'safe.txt'), 'safe');
  await writeFile(join(outside, 'secret.txt'), 'secret');
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
    operation: 'list_files',
    workspaceId: 'primary',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, ['safe.txt']);
});

test('listing preserves ignore rules for an explicitly requested subtree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'vendor', 'dependency.js'), 'ignored');
  await writeFile(join(root, '.ignore'), 'vendor/\n');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
    path: 'vendor',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, []);
});

test('listing excludes an explicitly requested symlink file alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'target.txt'), 'target');
  await symlink(join(root, 'target.txt'), join(root, 'alias.txt'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
    path: 'alias.txt',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, []);
});

test('listing skips filenames the portable protocol cannot represent', async (t) => {
  if (sep === '\\') return;
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'invalid\\name.txt'), 'invalid');
  await writeFile(join(root, 'safe.txt'), 'safe');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, ['safe.txt']);
});

test('listing rejects invalid UTF-8 bytes instead of aliasing a valid filename', async (t) => {
  if (sep === '\\') return;
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidPath = Buffer.concat([
    Buffer.from(`${root}${sep}`),
    Buffer.from([0xff]),
    Buffer.from('.txt'),
  ]);
  try {
    await writeFile(invalidPath, 'invalid');
  } catch {
    t.skip('filesystem does not support non-UTF-8 filenames');
    return;
  }
  await writeFile(join(root, '\ufffd.txt'), 'valid but ignored');
  await writeFile(join(root, '.ignore'), '\ufffd.txt\n');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.equal(result.paths.includes('\ufffd.txt'), false);
});

test('listing preserves a leading UTF-8 BOM in a filename', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '\ufefffoo.txt'), 'bom filename');
  await writeFile(join(root, 'foo.txt'), 'ignored sibling');
  await writeFile(join(root, '.ignore'), 'foo.txt\n');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.equal(result.paths.includes('\ufefffoo.txt'), true);
  assert.equal(result.paths.includes('foo.txt'), false);
});

test('listing excludes a non-regular explicit target', async (t) => {
  if (sep === '\\') return;
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('mkfifo', [join(root, 'events.pipe')]);
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'list_files',
    workspaceId: 'primary',
    path: 'events.pipe',
  });

  if (result.operation !== 'list_files') assert.fail('expected list result');
  assert.deepEqual(result.paths, []);
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

test('search preserves an in-workspace symlink namespace in returned paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.ts'), 'const needle = true;');
  await symlink(join(root, 'src'), join(root, 'alias'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'search_text',
    workspaceId: 'primary',
    query: 'needle',
    path: 'alias',
  });

  if (result.operation !== 'search_text') assert.fail('expected search result');
  assert.deepEqual(result.matches, [
    {
      path: 'alias/app.ts',
      line: 1,
      column: 7,
      text: 'const needle = true;',
    },
  ]);
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
    operations: ['read_file', 'search_text', 'list_files'],
    workspaces: [{ id: 'primary', name: 'LibreChat' }],
  });
  assert.equal(JSON.stringify(tools.capabilities).includes(root), false);
});

test('workspace mutations are disabled by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      content: 'blocked',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.code === 'WRITE_DISABLED',
  );
});

test('writable workspaces create, replace, and exactly edit files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', name: 'Writable', root, writable: true }],
  });

  assert.deepEqual(tools.capabilities, {
    protocolVersion: 1,
    operations: [
      'read_file',
      'search_text',
      'list_files',
      'write_file',
      'edit_file',
    ],
    workspaces: [
      {
        id: 'primary',
        name: 'Writable',
        operations: [
          'read_file',
          'search_text',
          'list_files',
          'write_file',
          'edit_file',
        ],
      },
    ],
  });
  await tools.execute({
    protocolVersion: 1,
    operation: 'write_file',
    workspaceId: 'primary',
    path: 'notes.txt',
    content: 'hello world',
  });
  const edit = await tools.execute({
    protocolVersion: 1,
    operation: 'edit_file',
    workspaceId: 'primary',
    path: 'notes.txt',
    oldText: 'world',
    newText: 'BYOM',
  });
  assert.deepEqual(edit, {
    protocolVersion: 1,
    operation: 'edit_file',
    workspaceId: 'primary',
    path: 'notes.txt',
    replacements: 1,
    bytesWritten: 10,
  });
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'hello BYOM');
});

test('exact edits reject missing or repeated text without changing the file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'same same');
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root, writable: true }],
  });

  for (const oldText of ['missing', 'same']) {
    await assert.rejects(
      tools.execute({
        protocolVersion: 1,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'notes.txt',
        oldText,
        newText: 'changed',
      }),
      (error: unknown) =>
        error instanceof WorkspaceToolError && error.code === 'EDIT_CONFLICT',
    );
  }
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'same same');
});

test('writes reject symlink targets and missing parent directories', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'root');
  await mkdir(root);
  await writeFile(join(parent, 'outside.txt'), 'outside');
  await symlink(join(parent, 'outside.txt'), join(root, 'link.txt'));
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root, writable: true }],
  });

  for (const path of ['link.txt', 'missing/notes.txt']) {
    await assert.rejects(
      tools.execute({
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path,
        content: 'blocked',
      }),
      (error: unknown) =>
        error instanceof WorkspaceToolError && error.code === 'INVALID_PATH',
    );
  }
  assert.equal(await readFile(join(parent, 'outside.txt'), 'utf8'), 'outside');
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

test('bounds workspace reads after UTF-16 decoding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const utf16 = Buffer.from('\u4e00'.repeat(400_000), 'utf16le');
  await writeFile(
    join(root, 'large-utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]),
  );
  const tools = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root }],
  });

  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'large-utf16.txt',
    }),
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'READ_LIMIT_EXCEEDED',
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
      content: '',
      endLine: 0,
      truncated: true,
      nextStartLine: 1,
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
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      matches: [
        { path: 'src/index.ts', line: 1, column: 1, text: 'unrelated' },
      ],
    }),
    false,
  );
});

test('validates search result paths against the requested scope', () => {
  const request = {
    protocolVersion: 1 as const,
    operation: 'search_text' as const,
    workspaceId: 'primary',
    query: 'needle',
    path: './src',
  };
  const result = {
    protocolVersion: 1 as const,
    operation: 'search_text' as const,
    workspaceId: 'primary',
    matches: [
      { path: 'src/index.ts', line: 1, column: 1, text: 'needle' },
    ],
    truncated: false,
  };

  assert.equal(isWorkspaceToolResult(request, result), true);
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      matches: [
        { path: 'src-old/index.ts', line: 1, column: 1, text: 'needle' },
      ],
    }),
    false,
  );
  assert.equal(
    isWorkspaceToolResult(request, {
      ...result,
      matches: [
        { path: 'secrets.env', line: 1, column: 1, text: 'needle' },
      ],
    }),
    false,
  );
});
