import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { GitWorktreeWorkspaceTools } from './workspace-instances.js';
import { LocalWorkspaceTools } from './workspace.js';
import { GitWorktreeManager } from './worktrees.js';

const execFileAsync = promisify(execFile);

async function repository(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'librechat-instance-tools-'));
  const root = join(parent, 'source');
  await execFileAsync('git', ['init', root]);
  await writeFile(join(root, 'README.md'), 'source\n');
  await execFileAsync('git', ['-C', root, 'add', 'README.md']);
  await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  return { parent, root: await realpath(root) };
}

test('routes each conversation to its own writable Git worktree', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const delegate = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root: fixture.root, writable: true }],
  });
  const manager = new GitWorktreeManager({
    maxCount: 4,
    root: join(fixture.parent, 'instances'),
    sources: new Map([['primary', { root: fixture.root }]]),
  });
  const tools = new GitWorktreeWorkspaceTools({
    delegate,
    manager,
    sources: new Map([['primary', { writable: true }]]),
  });
  const firstId = 'a'.repeat(64);
  const secondId = 'b'.repeat(64);

  assert.deepEqual(tools.capabilities.workspaces[0]?.workspaceInstances, [
    'git_worktree',
  ]);
  await tools.execute({
    protocolVersion: 1,
    operation: 'write_file',
    workspaceId: 'primary',
    workspaceInstanceId: firstId,
    path: 'conversation.txt',
    content: 'first',
  });
  await tools.execute({
    protocolVersion: 1,
    operation: 'write_file',
    workspaceId: 'primary',
    workspaceInstanceId: secondId,
    path: 'conversation.txt',
    content: 'second',
  });

  const first = await manager.resolve('primary', firstId);
  const second = await manager.resolve('primary', secondId);
  assert.equal(
    await readFile(join(first.root, 'conversation.txt'), 'utf8'),
    'first',
  );
  assert.equal(
    await readFile(join(second.root, 'conversation.txt'), 'utf8'),
    'second',
  );
  await assert.rejects(readFile(join(fixture.root, 'conversation.txt')), {
    code: 'ENOENT',
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'read_file',
    workspaceId: 'primary',
    workspaceInstanceId: firstId,
    path: 'conversation.txt',
  });
  assert.equal(result.workspaceId, 'primary');
  assert.equal(result.operation, 'read_file');
  assert.equal(result.content, 'first');
});

test('leaves legacy requests on the selected source workspace', async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const delegate = await LocalWorkspaceTools.create({
    workspaces: [{ id: 'primary', root: fixture.root, writable: false }],
  });
  const tools = new GitWorktreeWorkspaceTools({
    delegate,
    manager: new GitWorktreeManager({
      maxCount: 1,
      root: join(fixture.parent, 'instances'),
      sources: new Map([['primary', { root: fixture.root }]]),
    }),
    sources: new Map([['primary', { writable: false }]]),
  });

  const result = await tools.execute({
    protocolVersion: 1,
    operation: 'read_file',
    workspaceId: 'primary',
    path: 'README.md',
  });
  assert.equal(result.operation, 'read_file');
  assert.equal(result.content, 'source');
});
