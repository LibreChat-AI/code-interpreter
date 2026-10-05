import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { LaneGitWorkspaceTools, ownsGitMetadata, ownsLinkedWorktreeMetadata, readLaneGit, snapshotLaneGit } from './lane-git.js';
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

test('the probe budget follows the worker deadline, not a rebuilt timeout', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  // A full 31 s budget by timeout alone, but the worker has only 1.5 s left before it aborts.
  for (const [remainingMs, probed] of [
    [10_000, true],
    [1_500, true],
    [1_200, false],
    [500, false],
  ] as const) {
    let resolved = 0;
    const tools = new LaneGitWorkspaceTools({
      delegate: delegate(),
      now: () => 1_000,
      resolveRoot: async () => {
        resolved++;
        return source;
      },
    });
    await tools.execute(commandRequest, undefined, { deadlineAtMs: 1_000 + remainingMs });
    assert.equal(resolved, probed ? 1 : 0, `remaining ${remainingMs}`);
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

test('a HEAD that names a blob is reported as a null head, not as a commit', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const id = (await exec('bash', ['-c', `echo hello | git -C '${source}' hash-object -w --stdin`])).stdout.trim();
  await writeFile(join(source, '.git', 'HEAD'), `${id}\n`);
  assert.deepEqual(await readLaneGit(source), { branch: null, head: null });
});

test('branch names with Unicode control or format characters are not reported', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', 'feature/\u202eabc']);
  assert.deepEqual(await readLaneGit(source), { branch: null, head: await sha(source) });
  for (const name of ['a\u0085b', 'a\u202eb', 'a\u200bb', 'a\u2028b']) {
    assert.equal(isWorkspaceLaneGit({ branch: name, head: null }), false, JSON.stringify(name));
  }
  assert.equal(isWorkspaceLaneGit({ branch: 'feature/caf\u00e9-\u65e5\u672c', head: null }), true);
});

test('a resolver that ignores its signal cannot hold the command result past the probe limit', async () => {
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    probeTimeoutMs: 50,
    resolveRoot: () => new Promise<string | undefined>(() => {}),
  });
  const started = Date.now();
  const result = await Promise.race([
    tools.execute(commandRequest),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
  ]);
  assert.notEqual(result, 'hung');
  assert.deepEqual(result, commandResult);
  assert.ok(Date.now() - started < 1_000);
});

test('the worker reports lane_git active only when the registration that stuck advertised it', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  for (const secondFails of [false, true]) {
    let registrations = 0;
    const tools = new LaneGitWorkspaceTools({ delegate: delegate(), resolveRoot: async () => source });
    const worker = new BridgeWorker({
      codeApiUrl: 'https://code.example/v1',
      token: 'worker-secret',
      workerId: 'vm-1',
      incarnationId,
      sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
      capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: tools.capabilities },
      workspaceTools: tools,
      workspaceMutationQuarantine: quarantine(),
      fetchImpl: async () => {
        registrations++;
        if (secondFails && registrations === 2) return new Response('{}', { status: 500 });
        return Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          incarnationId,
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
          supportedWorkspaceToolOperations: ['read_file', 'execute_command'],
          supportedWorkspaceCommandResultFeatures: ['lane_git'],
        });
      },
    });
    await worker.register();
    assert.equal(worker.commandResultFeatureActive('lane_git'), !secondFails, `secondFails=${secondFails}`);
  }
});

test('a branch name with leading or trailing Unicode whitespace is reported as it is', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', '\u00a0main\u00a0']);
  assert.deepEqual(await readLaneGit(source), { branch: '\u00a0main\u00a0', head: await sha(source) });
});

test('a branch name that is not valid UTF-8 is reported as null, not as a lossy copy', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await writeFile(join(source, '.git', 'HEAD'), Buffer.concat([Buffer.from('ref: refs/heads/bad'), Buffer.from([0xff, 0x0a])]));
  const state = await readLaneGit(source);
  assert.equal(state?.branch, null);
  assert.equal(JSON.stringify(state).includes('\ufffd'), false);
});

test('a valid non-ASCII branch name survives the byte level read', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', 'feature/caf\u00e9-\u65e5\u672c']);
  assert.equal((await readLaneGit(source))?.branch, 'feature/caf\u00e9-\u65e5\u672c');
});

test('an own Git directory is accepted, and a commit made there keeps it accepted', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  assert.equal(await ownsGitMetadata(source), true);
  await exec('git', ['-C', source, ...identity, 'commit', '--allow-empty', '-m', 'second']);
  await exec('git', ['-C', source, 'pack-refs', '--all']);
  assert.equal(await ownsGitMetadata(source), true);
});

test('a .git rewritten to point at another repository is not probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const victim = await repo(root, 'victim');
  await exec('git', ['-C', victim, 'checkout', '-b', 'victim-secret-branch']);
  await rm(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git'), `gitdir: ${join(victim, '.git')}\n`);
  assert.equal(await ownsGitMetadata(source), false);
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    resolveRoot: async () => ((await ownsGitMetadata(source)) ? source : undefined),
  });
  const result = await tools.execute(commandRequest);
  assert.equal('laneGit' in result, false);
  assert.equal(JSON.stringify(result).includes('victim-secret-branch'), false);
});

test('Git storage redirected by a symlink, commondir or a swapped directory is not probed', async (t) => {
  const root = await scratch(t);
  const victim = await repo(root, 'victim');
  const cases: Array<[string, (source: string) => Promise<void>]> = [
    ['.git symlink', async (s) => { await rm(join(s, '.git'), { recursive: true }); await symlink(join(victim, '.git'), join(s, '.git')); }],
    ['commondir', async (s) => { await writeFile(join(s, '.git', 'commondir'), `${join(victim, '.git')}\n`); }],
    ['HEAD symlink', async (s) => { await rm(join(s, '.git', 'HEAD')); await symlink(join(victim, '.git', 'HEAD'), join(s, '.git', 'HEAD')); }],
    ['refs symlink', async (s) => { await rm(join(s, '.git', 'refs'), { recursive: true }); await symlink(join(victim, '.git', 'refs'), join(s, '.git', 'refs')); }],
    ['packed-refs symlink', async (s) => { await symlink(join(victim, '.git', 'HEAD'), join(s, '.git', 'packed-refs')); }],
    ['no .git', async (s) => { await rename(join(s, '.git'), join(root, `moved-${Math.random()}`)); }],
  ];
  for (const [name, tamper] of cases) {
    const source = await repo(root, `source-${name.replace(/\W/g, '')}`);
    await tamper(source);
    assert.equal(await ownsGitMetadata(source), false, name);
  }
});

test('a nested ref symlinked to another checkout is not probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const firstCommit = await sha(source);
  await exec('git', ['-C', source, ...identity, 'commit', '--allow-empty', '-m', 'second']);
  // A clone shares history, so the commit its branch sits on also exists in the source's objects.
  const other = join(root, 'other');
  await exec('git', ['clone', '-q', source, other]);
  await exec('git', ['-C', other, 'checkout', '-q', '-b', 'other-wip', firstCommit]);
  await symlink(join(other, '.git', 'refs', 'heads', 'other-wip'), join(source, '.git', 'refs', 'heads', 'leak'));
  await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/leak\n');
  assert.equal(await ownsGitMetadata(source), false);
  const tools = new LaneGitWorkspaceTools({
    delegate: delegate(),
    resolveRoot: async () => ((await ownsGitMetadata(source)) ? source : undefined),
  });
  const result = await tools.execute(commandRequest);
  assert.equal('laneGit' in result, false);
});

test('a nested branch ref that is a plain file inside .git is still probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', 'feature/deep/name']);
  assert.equal(await ownsGitMetadata(source), true);
  assert.equal((await readLaneGit(source))?.branch, 'feature/deep/name');
});

test('a branch that shares its short name with a tag is reported by its real name', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'checkout', '-b', 'foo']);
  await exec('git', ['-C', source, 'tag', 'foo']);
  assert.equal((await readLaneGit(source))?.branch, 'foo');
});

test('a HEAD that points outside refs/heads reports a null branch', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await exec('git', ['-C', source, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/main']);
  assert.equal((await readLaneGit(source))?.branch, null);
});

test('a linked lane whose HEAD names a ref symlinked at another checkout is not probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const firstCommit = await sha(source);
  await exec('git', ['-C', source, ...identity, 'commit', '--allow-empty', '-m', 'second']);
  const other = join(root, 'other');
  await exec('git', ['clone', '-q', source, other]);
  await exec('git', ['-C', other, 'checkout', '-q', '-b', 'other-wip', firstCommit]);
  const lane = join(root, 'lane');
  await exec('git', ['-C', source, 'worktree', 'add', '-b', 'lane-branch', lane]);
  const common = join(source, '.git');
  assert.equal(await ownsLinkedWorktreeMetadata(common, 'lane'), true);
  await symlink(join(other, '.git', 'refs', 'heads', 'other-wip'), join(common, 'refs', 'heads', 'leak'));
  await writeFile(join(common, 'worktrees', 'lane', 'HEAD'), 'ref: refs/heads/leak\n');
  assert.equal(await ownsLinkedWorktreeMetadata(common, 'lane'), false);
});

test('a linked lane with a symlinked metadata HEAD is not probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const lane = join(root, 'lane');
  await exec('git', ['-C', source, 'worktree', 'add', '-b', 'lane-branch', lane]);
  const head = join(source, '.git', 'worktrees', 'lane', 'HEAD');
  await rm(head);
  await symlink(join(source, '.git', 'HEAD'), head);
  assert.equal(await ownsLinkedWorktreeMetadata(join(source, '.git'), 'lane'), false);
});

test('the refs walk stops as soon as the probe signal aborts', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  for (let i = 0; i < 30; i++) await mkdir(join(source, '.git', 'refs', 'heads', `dir${i}`), { recursive: true });
  let checks = 0;
  const aborting = {
    aborted: false,
    throwIfAborted() {
      if (++checks >= 3) throw new Error('aborted');
    },
  } as unknown as AbortSignal;
  assert.equal(await ownsGitMetadata(source, aborting), false);
  assert.equal(checks, 3);
  const linked = join(root, 'lane');
  await exec('git', ['-C', source, 'worktree', 'add', '-b', 'lane-branch', linked]);
  checks = 0;
  assert.equal(await ownsLinkedWorktreeMetadata(join(source, '.git'), 'lane', aborting), false);
  assert.equal(checks, 3);
});

test('the head is read from the branch ref the first read named, and only a stable branch is reported', async () => {
  const head = 'a'.repeat(40);
  const sequence = (values: Array<string | null | undefined>) => {
    let index = 0;
    return async () => values[index++];
  };
  const refsRead: string[] = [];
  const commit = (answer: string | null | undefined) => async (ref: string) => {
    refsRead.push(ref);
    return answer;
  };
  // Stable branch: head comes from that branch's own ref, never from HEAD.
  assert.deepEqual(await snapshotLaneGit(sequence(['refs/heads/a', 'refs/heads/a']), commit(head)), { branch: 'a', head });
  assert.deepEqual(refsRead, ['refs/heads/a']);
  // A checkout away during the read is rejected.
  assert.equal(await snapshotLaneGit(sequence(['refs/heads/a', 'refs/heads/b']), commit(head)), undefined);
  assert.equal(await snapshotLaneGit(sequence(['refs/heads/a', null]), commit(head)), undefined);
  assert.equal(await snapshotLaneGit(sequence([null, 'refs/heads/a']), commit(head)), undefined);
  // Detached: HEAD is read twice and must agree, so a move between the reads is rejected.
  refsRead.length = 0;
  let calls = 0;
  const moving = async (ref: string) => {
    refsRead.push(ref);
    return calls++ === 0 ? head : 'b'.repeat(40);
  };
  assert.equal(await snapshotLaneGit(sequence([null, null]), moving), undefined);
  assert.deepEqual(refsRead, ['HEAD', 'HEAD']);
  assert.deepEqual(await snapshotLaneGit(sequence([null, null]), commit(head)), { branch: null, head });
  // HEAD on a non-branch ref reports no branch but still a head.
  assert.deepEqual(await snapshotLaneGit(sequence(['refs/remotes/o/m', 'refs/remotes/o/m']), commit(head)), { branch: null, head });
  // Unreadable values omit the field.
  assert.equal(await snapshotLaneGit(sequence(['refs/heads/a', 'refs/heads/a']), commit(undefined)), undefined);
});

test('a replace ref cannot turn a blob into a reported commit', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const commit = await sha(source);
  const blob = (await exec('bash', ['-c', `echo hello | git -C '${source}' hash-object -w --stdin`])).stdout.trim();
  await mkdir(join(source, '.git', 'refs', 'replace'), { recursive: true });
  await writeFile(join(source, '.git', 'refs', 'replace', blob), `${commit}\n`);
  await writeFile(join(source, '.git', 'refs', 'heads', 'main'), `${blob}\n`);
  assert.deepEqual(await readLaneGit(source), { branch: 'main', head: null });
});

test('redirected object storage is not probed, for source and linked checks alike', async (t) => {
  const root = await scratch(t);
  const victim = await repo(root, 'victim');
  const cases: Array<[string, (source: string) => Promise<void>]> = [
    ['alternates', async (s) => {
      await mkdir(join(s, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(join(s, '.git', 'objects', 'info', 'alternates'), `${join(victim, '.git', 'objects')}\n`);
    }],
    ['http-alternates', async (s) => {
      await mkdir(join(s, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(join(s, '.git', 'objects', 'info', 'http-alternates'), 'https://example.invalid/\n');
    }],
    ['objects symlink', async (s) => {
      await rename(join(s, '.git', 'objects'), join(root, `moved-${Math.random()}`));
      await symlink(join(victim, '.git', 'objects'), join(s, '.git', 'objects'));
    }],
    ['fanout symlink', async (s) => {
      await symlink(join(victim, '.git', 'objects', 'info'), join(s, '.git', 'objects', 'ab'));
    }],
    ['pack entry symlink', async (s) => {
      await mkdir(join(s, '.git', 'objects', 'pack'), { recursive: true });
      await symlink(join(victim, '.git', 'HEAD'), join(s, '.git', 'objects', 'pack', 'pack-x.pack'));
    }],
    ['reftable redirect', async (s) => {
      await mkdir(join(s, '.git', 'reftable'), { recursive: true });
    }],
  ];
  for (const [name, tamper] of cases) {
    const source = await repo(root, `src-${name.replace(/\W/g, '')}`);
    await tamper(source);
    assert.equal(await ownsGitMetadata(source), false, `source ${name}`);
  }
  const common = join(root, 'common');
  await exec('git', ['init', '-q', '--initial-branch=main', common]);
  await exec('git', ['-C', common, ...identity, 'commit', '--allow-empty', '-m', 'i']);
  await exec('git', ['-C', common, 'worktree', 'add', '-b', 'lane', join(root, 'lane')]);
  assert.equal(await ownsLinkedWorktreeMetadata(join(common, '.git'), 'lane'), true);
  await mkdir(join(common, '.git', 'objects', 'info'), { recursive: true });
  await writeFile(join(common, '.git', 'objects', 'info', 'alternates'), `${join(victim, '.git', 'objects')}\n`);
  assert.equal(await ownsLinkedWorktreeMetadata(join(common, '.git'), 'lane'), false);
});

test('a repository with packed objects and refs is still probed', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  await exec('git', ['-C', source, ...identity, 'commit', '--allow-empty', '-m', 'second']);
  await exec('git', ['-C', source, 'gc', '-q']);
  assert.equal(await ownsGitMetadata(source), true);
  assert.equal((await readLaneGit(source))?.head, await sha(source));
});

test('a linked worktree .git file is not claimed by the source checkout check', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const lane = join(root, 'lane');
  await exec('git', ['-C', source, 'worktree', 'add', '-b', 'lane-branch', lane]);
  assert.equal(await ownsGitMetadata(lane), false);
  assert.equal((await readLaneGit(lane))?.branch, 'lane-branch');
});

test('a laneGit supplied by the delegate is never forwarded, only the probe value is', async (t) => {
  const root = await scratch(t);
  const source = await repo(root, 'source');
  const forged = { branch: 'forged', head: 'f'.repeat(40) };
  const forging = {
    ...delegate(),
    async execute() {
      return { ...commandResult, laneGit: forged };
    },
  };
  const unreadable = await new LaneGitWorkspaceTools({ delegate: forging, resolveRoot: async () => undefined }).execute(commandRequest);
  assert.equal('laneGit' in unreadable, false);
  const probed = await new LaneGitWorkspaceTools({ delegate: forging, resolveRoot: async () => source }).execute(commandRequest);
  assert.deepEqual('laneGit' in probed && probed.laneGit, { branch: 'main', head: await sha(source) });
});

test('the worker passes its real assignment deadline to the executor', async () => {
  const seen: Array<number | undefined> = [];
  const base = delegate();
  const spying = {
    ...base,
    async execute(request: WorkspaceToolRequest, signal?: AbortSignal, context?: { deadlineAtMs?: number }) {
      seen.push(context?.deadlineAtMs);
      return base.execute(request);
    },
  };
  const worker = new BridgeWorker({
    codeApiUrl: 'https://code.example/v1',
    token: 'worker-secret',
    workerId: 'vm-1',
    incarnationId,
    sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: false, sandboxProfile: 'anthropic-srt', runtimes: [], workspaceTools: spying.capabilities },
    workspaceTools: spying,
    workspaceMutationQuarantine: quarantine(),
    fetchImpl: async () =>
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        incarnationId,
        registeredAt: new Date().toISOString(),
        leaseTtlMs: 60_000,
        supportedWorkspaceToolOperations: ['read_file', 'execute_command'],
      }),
  });
  await worker.register();
  const before = Date.now();
  await worker.executeAndSettle({
    protocolVersion: 1,
    assignmentId: 'assignment-1',
    workerId: 'vm-1',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    remainingMs: 2_000,
    executionKind: 'workspace_tool',
    workspaceId: 'primary',
    request: commandRequest,
  });
  assert.equal(seen.length, 1);
  const deadline = seen[0] as number;
  assert.ok(deadline >= before + 1_500 && deadline <= Date.now() + 2_000, `deadline ${deadline - before}`);
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
