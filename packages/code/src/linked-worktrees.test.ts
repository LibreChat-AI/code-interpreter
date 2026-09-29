import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  LinkedWorktreeWorkspaceTools,
  linkedWorktreeWorkspaceId,
  verifyLinkedWorktree,
} from './linked-worktrees.js';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';

import type { NativeWorkspaceCommandPool } from './native-pool.js';
import type { NativeProcessSandboxOptions } from './native-process.js';
import type { WorkspaceToolRequest } from './protocol.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  );
}

async function checkout(): Promise<{ parent: string; root: string }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'linked-worktree-')));
  const root = join(parent, 'repo');
  await mkdir(root);
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'root\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'init');
  await mkdir(join(root, '.worktrees'));
  await git(root, 'worktree', 'add', '-q', '-b', 'task-a', '.worktrees/task-a');
  return { parent, root };
}

async function rejects(promise: Promise<unknown>, code = 'INVALID_REQUEST'): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkspaceToolError && error.code === code);
}

test('verifies a linked worktree of the checkout and lists the only Git paths it may write', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  await git(root, 'worktree', 'add', '-q', '-b', 'task-b', '.worktrees/task-b');

  const lane = await verifyLinkedWorktree(root, 'task-a');

  assert.equal(lane.root, join(root, '.worktrees', 'task-a'));
  assert.equal(lane.checkoutRoot, root);
  assert.equal(lane.commonGitDir, join(root, '.git'));
  assert.deepEqual(lane.writableGitPaths, [
    join(root, '.git', 'objects'),
    join(root, '.git', 'refs'),
    join(root, '.git', 'logs', 'refs'),
    join(root, '.git', 'lfs'),
    join(root, '.git', 'worktrees', 'task-a'),
  ]);
  const gitPath = (...path: string[]) => join(root, '.git', ...path);
  for (const path of [gitPath('config'), gitPath('hooks'), gitPath('HEAD'), gitPath('index'), gitPath('logs', 'HEAD'), gitPath('worktrees', 'task-b')]) {
    assert.ok(lane.readableGitPaths.includes(path), path);
  }
  for (const path of [gitPath(), gitPath('logs'), gitPath('worktrees'), ...lane.writableGitPaths]) {
    assert.ok(!lane.readableGitPaths.includes(path), path);
  }
});


test('rejects directories that are not linked worktrees of this checkout', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));

  await mkdir(join(root, '.worktrees', 'plain'));
  await rejects(verifyLinkedWorktree(root, 'plain'));

  await mkdir(join(root, '.worktrees', 'borrowed'));
  await writeFile(
    join(root, '.worktrees', 'borrowed', '.git'),
    `gitdir: ${join(root, '.git', 'worktrees', 'task-a')}\n`,
  );
  await rejects(verifyLinkedWorktree(root, 'borrowed'));

  await symlink(join(root, '.worktrees', 'task-a'), join(root, '.worktrees', 'alias'));
  await rejects(verifyLinkedWorktree(root, 'alias'));

  const other = join(parent, 'other');
  await mkdir(other);
  await git(other, 'init', '-q', '-b', 'main');
  await writeFile(join(other, 'file'), 'x\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '-q', '-m', 'other');
  await git(other, 'worktree', 'add', '-q', '-b', 'foreign', join(root, '.worktrees', 'foreign'));
  await rejects(verifyLinkedWorktree(root, 'foreign'));

  for (const name of ['..', '.git', 'a/b', 'task.lock']) {
    await rejects(verifyLinkedWorktree(root, name));
  }
  await rejects(verifyLinkedWorktree(root, 'missing'));
});

test('rejects a checkout whose .worktrees directory is a symlink', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const elsewhere = join(parent, 'elsewhere');
  await git(root, 'worktree', 'move', '.worktrees/task-a', elsewhere);
  await rm(join(root, '.worktrees'), { recursive: true });
  await symlink(parent, join(root, '.worktrees'));
  await rejects(verifyLinkedWorktree(root, 'elsewhere'));
});

test('rejects shared Git storage symlinks into sibling worktree metadata', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  await git(root, 'worktree', 'add', '-q', '-b', 'task-b', '.worktrees/task-b');
  const commonGitDir = join(root, '.git');
  const siblingMetadata = join(commonGitDir, 'worktrees', 'task-b');
  await rm(join(commonGitDir, 'objects'), { recursive: true });
  await symlink(siblingMetadata, join(commonGitDir, 'objects'));

  await rejects(verifyLinkedWorktree(root, 'task-a'));
});

function recordingPool(): {
  pool: NativeWorkspaceCommandPool;
  calls: Array<{ action: string; id: string; options?: NativeProcessSandboxOptions }>;
} {
  const calls: Array<{ action: string; id: string; options?: NativeProcessSandboxOptions }> = [];
  const pool = {
    async registerRoot(id: string, options: NativeProcessSandboxOptions) {
      calls.push({ action: 'register', id, options });
    },
    async unregisterRoot(id: string) {
      calls.push({ action: 'unregister', id });
    },
    async execute(request: WorkspaceToolRequest) {
      calls.push({ action: 'execute', id: request.workspaceId });
      return {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: request.workspaceId,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
      };
    },
    async executeProgrammatic(id: string) {
      calls.push({ action: 'programmatic', id });
      return {};
    },
  } as unknown as NativeWorkspaceCommandPool;
  return { pool, calls };
}

async function laneTools(
  root: string,
  pool?: NativeWorkspaceCommandPool,
  onRelease?: (root: string) => void,
) {
  const delegate = await LocalWorkspaceTools.create({
    repositoryInstructions: false,
    workspaces: [{ id: 'repo', root, writable: true }],
  });
  return new LinkedWorktreeWorkspaceTools({
    commandPool: pool,
    delegate,
    onRelease,
    sources: new Map([
      [
        'repo',
        {
          root,
          command: { workspaceRoot: root } as NativeProcessSandboxOptions,
          repositoryInstructions: false,
          writable: true,
        },
      ],
    ]),
  });
}

test('lane file tools are confined to the worktree and report the public workspace', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const tools = await laneTools(root);

  assert.deepEqual(tools.capabilities.workspaces[0]?.workspaceScopes, ['git_linked_worktree']);
  const written = await tools.execute({
    protocolVersion: 1,
    operation: 'write_file',
    workspaceId: 'repo',
    worktree: 'task-a',
    path: 'lane.txt',
    content: 'from the lane\n',
  });
  assert.equal(written.workspaceId, 'repo');
  assert.equal(await readFile(join(root, '.worktrees', 'task-a', 'lane.txt'), 'utf8'), 'from the lane\n');
  await assert.rejects(stat(join(root, 'lane.txt')));

  const read = await tools.execute({
    protocolVersion: 1,
    operation: 'read_file',
    workspaceId: 'repo',
    path: 'README.md',
  });
  assert.equal(read.operation === 'read_file' && read.content.trimEnd(), 'root');

  await rejects(
    tools.execute({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'repo',
      worktree: 'task-a',
      workspaceInstanceId: 'a'.repeat(64),
      path: 'README.md',
    }),
  );
});

test('lane commands register a confined root and refresh it when the shared Git entries change', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { pool, calls } = recordingPool();
  const tools = await laneTools(root, pool);
  const command = {
    protocolVersion: 1 as const,
    operation: 'execute_command' as const,
    workspaceId: 'repo',
    worktree: 'task-a',
    command: 'git status',
  };
  const id = linkedWorktreeWorkspaceId('repo', 'task-a');

  const result = await tools.execute(command);
  await tools.execute(command);
  assert.equal(result.workspaceId, 'repo');
  assert.deepEqual(
    calls.map((call) => call.action),
    ['register', 'execute', 'execute'],
  );
  const registered = calls[0]!.options!;
  assert.equal(calls[0]!.id, id);
  assert.equal(registered.workspaceRoot, join(root, '.worktrees', 'task-a'));
  assert.equal(registered.linkedWorktree?.commonGitDir, join(root, '.git'));
  assert.equal(registered.linkedWorktree?.checkoutRoot, root);

  assert.ok(!registered.linkedWorktree?.writableGitPaths.includes(join(root, '.git')));
  assert.ok(!registered.linkedWorktree?.readableGitPaths.includes(join(root, '.git')));

  await rejects(tools.execute({
    ...command,
    environmentAction: { name: 'unresolved', fingerprint: 'a'.repeat(64) },
  }));
  assert.equal(calls.length, 3, 'an unresolved action must never reach the command pool');

  await git(root, 'worktree', 'add', '-q', '-b', 'task-b', '.worktrees/task-b');
  await tools.execute(command);
  await tools.execute(command);
  assert.deepEqual(
    calls.slice(3).map((call) => call.action),
    ['unregister', 'register', 'execute', 'execute'],
  );
  assert.ok(
    calls[4]!.options!.linkedWorktree!.readableGitPaths.includes(join(root, '.git', 'worktrees', 'task-b')),
  );
});

test('a removed lane releases its command root and credential route', async (t) => {
  const { parent, root } = await checkout();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { pool, calls } = recordingPool();
  const released: string[] = [];
  const tools = await laneTools(root, pool, (lane) => released.push(lane));
  const command = {
    protocolVersion: 1 as const,
    operation: 'execute_command' as const,
    workspaceId: 'repo',
    worktree: 'task-a',
    command: 'git status',
  };
  await tools.execute(command);

  await git(root, 'worktree', 'remove', '.worktrees/task-a');
  await rejects(tools.execute(command));

  assert.deepEqual(
    calls.map((call) => call.action),
    ['register', 'execute', 'unregister'],
  );
  assert.deepEqual(released, [join(root, '.worktrees', 'task-a')]);
});
