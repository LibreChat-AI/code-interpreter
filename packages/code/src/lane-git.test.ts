import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { LaneGitWorkspaceTools, readLaneGit } from './lane-git.js';
import { isValidBridgeWorkspaceToolCapabilities, isWorkspaceLaneGit, isWorkspaceToolResult } from './protocol.js';
import { BridgeWorker } from './worker.js';

import type { TestContext } from 'node:test';
import type { WorkspaceExecuteCommandRequest, WorkspaceToolRequest } from './protocol.js';

const exec = promisify(execFile);
const incarnationId = 'incarnation-00000001';
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

async function scratch(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lane-git-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function repo(root: string, name: string, commit = true): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await exec('git', ['init', '--initial-branch=main', directory]);
  if (commit) await exec('git', ['-C', directory, ...identity, 'commit', '--allow-empty', '-m', 'initial']);
  return directory;
}

async function sha(directory: string): Promise<string> {
  return (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
}

test('isolated worktree lane reports its own branch and head', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const lane = join(root, 'lane');
  await exec('git', ['-C', source, 'worktree', 'add', '-b', 'librechat/conversation-abcd1234-0123', lane]);
  assert.deepEqual(await readLaneGit(lane), { branch: 'librechat/conversation-abcd1234-0123', head: await sha(lane) });
  assert.equal((await readLaneGit(source))?.branch, 'main');
});

test('source checkout reports whatever is checked out', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', 'feature/pr-header']);
  assert.deepEqual(await readLaneGit(source), { branch: 'feature/pr-header', head: await sha(source) });
});

test('a branch renamed by the agent shows up on the next read', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  assert.equal((await readLaneGit(source))?.branch, 'main');
  await exec('git', ['-C', source, 'branch', '-m', 'renamed-by-agent']);
  assert.equal((await readLaneGit(source))?.branch, 'renamed-by-agent');
});

test('detached HEAD reports a null branch and the commit', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '--detach']);
  assert.deepEqual(await readLaneGit(source), { branch: null, head: await sha(source) });
});

test('a repository without commits reports the branch and a null head', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source', false);
  assert.deepEqual(await readLaneGit(source), { branch: 'main', head: null });
});

test('a branch name beyond the bound reports null and never forwards it', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const long = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)].join('/');
  await exec('git', ['-C', source, 'checkout', '-b', long]);
  assert.deepEqual(await readLaneGit(source), { branch: null, head: await sha(source) });
});

test('a directory that is not a repository reports nothing', async (t) => {
  const root = await scratch(t);
  assert.equal(await readLaneGit(root), undefined);
});

test('lane Git state never carries paths, remotes or credentials', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'remote', 'add', 'origin', 'https://user:secret@github.com/example/app.git']);
  const state = await readLaneGit(source);
  assert.deepEqual(Object.keys(state ?? {}).sort(), ['branch', 'head']);
  const wire = JSON.stringify(state);
  assert.equal(wire.includes(root), false);
  assert.equal(wire.includes('secret'), false);
  assert.equal(wire.includes('github.com'), false);
});

test('wire validator accepts only bounded branch and head', () => {
  const head = 'a'.repeat(40);
  assert.equal(isWorkspaceLaneGit({ branch: 'main', head }), true);
  assert.equal(isWorkspaceLaneGit({ branch: null, head: null }), true);
  assert.equal(isWorkspaceLaneGit({ branch: 'main', head: 'b'.repeat(64) }), true);
  for (const bad of [
    { branch: 'x'.repeat(257), head },
    { branch: 'bad\nname', head },
    { branch: '', head },
    { branch: 'main', head: 'A'.repeat(40) },
    { branch: 'main', head: 'a'.repeat(41) },
    { branch: 'main' },
    { branch: 'main', head, path: '/srv/repo' },
    { branch: undefined, head },
    null,
    [],
  ]) {
    assert.equal(isWorkspaceLaneGit(bad), false, JSON.stringify(bad));
  }
});

const commandRequest: WorkspaceExecuteCommandRequest = {
  protocolVersion: 1,
  operation: 'execute_command',
  workspaceId: 'primary',
  command: 'git checkout -b agent-branch',
};
const commandResult = {
  protocolVersion: 1 as const,
  operation: 'execute_command' as const,
  workspaceId: 'primary',
  exitCode: 0,
  stdout: '',
  stderr: '',
  truncated: false,
  timedOut: false,
};

function delegate(onRun?: () => Promise<void>) {
  return {
    capabilities: {
      protocolVersion: 1 as const,
      operations: ['read_file' as const, 'execute_command' as const],
      workspaces: [{ id: 'primary' }],
    },
    async execute(request: WorkspaceToolRequest) {
      await onRun?.();
      return request.operation === 'execute_command'
        ? commandResult
        : { protocolVersion: 1 as const, operation: 'read_file' as const, workspaceId: 'primary', path: 'a', content: '', startLine: 1, endLine: 1, truncated: false };
    },
  };
}

test('a finished command refreshes the lane state, including a branch the command created', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(async () => {
      await exec('git', ['-C', source, 'checkout', '-b', 'agent-branch']);
    }),
    resolveRoot: async () => source,
  });
  const result = await tools.execute(commandRequest);
  assert.deepEqual('laneGit' in result && result.laneGit, { branch: 'agent-branch', head: await sha(source) });
  assert.equal(isWorkspaceToolResult(commandRequest, result), true);
});

test('file operations do not read Git', async () => {
  let resolved = 0;
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    resolveRoot: async () => {
      resolved++;
      return undefined;
    },
  });
  const result = await tools.execute({ protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'a' });
  assert.equal('laneGit' in result, false);
  assert.equal(resolved, 0);
});

test('an unreadable lane leaves the command result untouched', async (t) => {
  const root = await scratch(t);
  for (const resolveRoot of [async () => root, async () => undefined, async () => Promise.reject(new Error('gone'))]) {
    const result = await new LaneGitWorkspaceTools({ delegate: delegate(), resolveRoot }).execute(commandRequest);
    assert.deepEqual(result, commandResult);
  }
});

test('the feature is advertised only when commands are', () => {
  const withCommands = new LaneGitWorkspaceTools({ delegate: delegate(), resolveRoot: async () => undefined });
  assert.deepEqual(withCommands.capabilities.commandResultFeatures, ['lane_git']);
  assert.equal(isValidBridgeWorkspaceToolCapabilities(withCommands.capabilities), true);
  const readOnly = new LaneGitWorkspaceTools({
    delegate: { ...delegate(), capabilities: { protocolVersion: 1, operations: ['read_file'], workspaces: [{ id: 'primary' }] } },
    resolveRoot: async () => undefined,
  });
  assert.equal(readOnly.capabilities.commandResultFeatures, undefined);
  assert.equal(
    isValidBridgeWorkspaceToolCapabilities({ ...withCommands.capabilities, commandResultFeatures: ['other'] }),
    false,
  );
});

test('the probe is skipped until lane_git is negotiated, then runs', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  let negotiated = false;
  let resolved = 0;
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    isEnabled: () => negotiated,
    resolveRoot: async () => {
      resolved++;
      return source;
    },
  });
  const before = await tools.execute(commandRequest);
  assert.equal('laneGit' in before, false);
  assert.equal(resolved, 0);
  negotiated = true;
  const after = await tools.execute(commandRequest);
  assert.equal(resolved, 1);
  assert.deepEqual('laneGit' in after && after.laneGit, { branch: 'main', head: await sha(source) });
});

test('the probe is skipped when the command left too little of its settlement budget', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const timed = { ...commandRequest, timeoutMs: 1_000 };
  // Budget is timeoutMs plus a 5 s grace (6 s here), minus a 1 s settlement reserve; the clock jumps while the command runs.
  for (const [elapsedMs, probed] of [
    [100, true],
    [4_000, true],
    [4_800, false],
    [7_000, false],
  ] as const) {
    let clock = 0;
    let resolved = 0;
    const tools = new LaneGitWorkspaceTools({
      delegate: delegate(async () => {
        clock += elapsedMs;
      }),
      now: () => clock,
      resolveRoot: async () => {
        resolved++;
        return source;
      },
    });
    const result = await tools.execute(timed);
    assert.equal(resolved, probed ? 1 : 0, `elapsed ${elapsedMs}`);
    assert.equal('laneGit' in result, probed, `elapsed ${elapsedMs}`);
  }
});

test('a slow probe is cut short and never fails the command', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    probeTimeoutMs: 1,
    resolveRoot: async (_request, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal?.throwIfAborted();
      return source;
    },
  });
  assert.deepEqual(await tools.execute(commandRequest), commandResult);
});

// Compatibility: negotiation with old and new Code API servers.

function quarantine() {
  return { async assertAvailable() {}, async arm() {}, async clear() {}, async quarantine() {} };
}

async function run(t: TestContext, supported: boolean) {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const tools = new LaneGitWorkspaceTools({ delegate: delegate(), resolveRoot: async () => source });
  const registrations: Array<{ commandResultFeatures?: string[] }> = [];
  const settlements: Array<{ result?: Record<string, unknown> }> = [];
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: tools.capabilities },
    workspaceTools: tools,
    workspaceMutationQuarantine: quarantine(),
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/bridge/workers/register')) {
        registrations.push(body.capabilities.workspaceTools ?? {});
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId,
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
          supportedWorkspaceToolOperations: ['read_file', 'execute_command'],
          ...(supported ? { supportedWorkspaceCommandResultFeatures: ['lane_git'] } : {}),
        });
      }
      if (url.endsWith('/settle')) settlements.push(body);
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  await worker.register();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    executionKind: 'workspace_tool',
    workspaceId: 'primary',
    request: commandRequest,
  });
  return { registrations, settlements };
}

test('a Code API without the feature still pairs, registers without it, and never receives laneGit', async (t) => {
  const { registrations, settlements } = await run(t, false);
  assert.ok(registrations.length > 0);
  for (const registration of registrations) assert.equal('commandResultFeatures' in registration, false);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.result?.exitCode, 0);
  assert.equal('laneGit' in (settlements[0]?.result ?? {}), false);
});

test('a Code API that acknowledges the feature registers it and receives laneGit', async (t) => {
  const { registrations, settlements } = await run(t, true);
  assert.deepEqual(registrations.at(-1)?.commandResultFeatures, ['lane_git']);
  assert.deepEqual(Object.keys((settlements[0]?.result?.laneGit as object) ?? {}).sort(), ['branch', 'head']);
  assert.equal((settlements[0]?.result?.laneGit as { branch: string }).branch, 'main');
});

test('a worker without the field still pairs and reports status', async () => {
  const executor = {
    capabilities: { protocolVersion: 1 as const, operations: ['read_file' as const], workspaces: [{ id: 'primary' }] },
    async execute(): Promise<never> {
      throw new Error('not executed');
    },
  };
  const registrations: unknown[] = [];
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: executor.capabilities },
    workspaceTools: executor,
    fetchImpl: async (_input, init) => {
      registrations.push(JSON.parse(String(init?.body)).capabilities.workspaceTools);
      return Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: ['read_file'],
      });
    },
  });
  const registration = await worker.register();
  assert.equal(registration.workerId, 'vm-1');
  assert.ok(registrations.length > 0);
  for (const advertised of registrations) {
    assert.equal(JSON.stringify(advertised).includes('commandResultFeatures'), false);
    assert.equal(JSON.stringify(advertised).includes('laneGit'), false);
  }
});
