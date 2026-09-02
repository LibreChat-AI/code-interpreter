import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalWorkspaceTools } from './workspace.js';

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
      assert.match(error.message, /invalid workspace path/i);
      assert.equal(error.message.includes(parent), false);
      return true;
    },
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
    /invalid workspace read/i,
  );
  await assert.rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'notes.txt',
      maxLines: 501,
    }),
    /invalid workspace read/i,
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
