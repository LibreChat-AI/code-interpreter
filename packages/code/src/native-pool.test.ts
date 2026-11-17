import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWorkspaceCommandPool, detachedCommandsEnabled } from './native-pool.js';
import { SandboxWorkspaceTools, WorkspaceToolError } from './workspace.js';
import type { WorkspaceExecuteCommandRequest } from './protocol.js';

const roots = new Map(
  ['a', 'b', 'c'].map((id) => [id, { workspaceRoot: `/fixture/${id}` }])
);
const request = (workspaceId: string): WorkspaceExecuteCommandRequest => ({
  protocolVersion: 1,
  operation: 'execute_command',
  workspaceId,
  command: 'fixture',
});

test('pool distinguishes same-root contention from exhausted machine capacity', async () => {
  let release!: () => void;
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const pool = new NativeWorkspaceCommandPool(roots, 1, () => ({
    async prepare() {}, async close() {},
    async execute(req) {
      entered();
      await finish;
      return { ...req, stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    },
  }));
  const first = pool.execute(request('a'));
  await running;
  try {
    for (const [root, reason] of [['a', 'workspace_busy'], ['b', 'capacity_exhausted']]) {
      await assert.rejects(pool.execute(request(root!)), error => {
        assert.ok(error instanceof WorkspaceToolError);
        assert.deepEqual(error.commandDiagnostic, { stage: 'allocation', reason });
        assert.equal(error.mutationMayHaveCommitted, false);
        return true;
      });
    }
  } finally {
    release();
    await first;
    await pool.close();
  }
});

test('failed provisioning roots are removed only after confirmed executor cleanup', async () => {
  let failClose = true;
  const pool = new NativeWorkspaceCommandPool(roots, 2, () => ({
    async prepare() {},
    async execute() {
      throw new Error('not used');
    },
    async close() {
      if (failClose) throw new Error('cleanup unconfirmed');
    },
  }));
  await pool.registerRoot('instance', { workspaceRoot: '/fixture/instance' });
  // Allocate this executor without dispatching a command.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pool.execute(request('instance'), controller.signal),
    /cancelled/
  );
  await assert.rejects(pool.unregisterRoot('instance'), /cleanup unconfirmed/);
  failClose = false;
  await pool.unregisterRoot('instance');
  await assert.rejects(pool.execute(request('instance')), /unavailable/);
  await pool.close();
  await assert.rejects(
    pool.registerRoot('new', { workspaceRoot: '/fixture/new' }),
    /unavailable/
  );
});

test('native pool preflights every registered root with bounded concurrency', async () => {
  const prepared: string[] = [];
  let active = 0;
  let peak = 0;
  const pool = new NativeWorkspaceCommandPool(roots, 2, (options) => ({
    async prepare() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      prepared.push(options.workspaceRoot);
      active -= 1;
    },
    async close() {},
    async execute() {
      throw new Error('unreachable');
    },
  }));

  await pool.prepare();
  assert.deepEqual(prepared.sort(), ['/fixture/a', '/fixture/b', '/fixture/c']);
  assert.equal(peak, 2);
  await pool.close();
});

test('native pool admits worker-owned roots after startup', async () => {
  const created: string[] = [];
  const pool = new NativeWorkspaceCommandPool(
    new Map([['primary', { workspaceRoot: '/fixture/primary' }]]),
    2,
    (options) => ({
      async prepare() {},
      async close() {},
      async execute(req) {
        created.push(options.workspaceRoot);
        return {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: req.workspaceId,
          stdout: '',
          stderr: '',
          exitCode: 0,
          truncated: false,
          timedOut: false,
        };
      },
    })
  );
  await pool.registerRoot('conversation', {
    workspaceRoot: '/fixture/conversation',
  });
  await pool.execute(request('conversation'));
  assert.deepEqual(created, ['/fixture/conversation']);
  await assert.rejects(
    async () =>
      pool.registerRoot('conversation', {
        workspaceRoot: '/fixture/replaced',
      }),
    { code: 'REGISTRATION_INVALID' }
  );
  await pool.close();
});

test('native pool retires a cached executor when a root inode changes', async () => {
  let created = 0;
  let closed = 0;
  const pool = new NativeWorkspaceCommandPool(
    new Map([['primary', { workspaceRoot: '/fixture/primary' }]]),
    2,
    () => {
      created++;
      return {
        async prepare() {},
        async close() {
          closed++;
        },
        async execute(req) {
          return {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: req.workspaceId,
            stdout: '',
            stderr: '',
            exitCode: 0,
            truncated: false,
            timedOut: false,
          };
        },
      };
    }
  );
  const options = (ino: string) => ({
    workspaceRoot: '/fixture/conversation',
    workspaceIdentity: {
      path: '/fixture/conversation',
      dev: '1',
      ino,
    },
  });
  await pool.registerRoot('conversation', options('1'));
  await pool.execute(request('conversation'));
  await pool.registerRoot('conversation', options('2'));
  await pool.execute(request('conversation'));

  assert.equal(created, 2);
  assert.equal(closed, 1);
  await pool.close();
});

test('a known-clean executor failure is retired without replaying the command', async () => {
  let created = 0;
  let executed = 0;
  let closed = 0;
  const pool = new NativeWorkspaceCommandPool(roots, 2, () => {
    const first = ++created === 1;
    return {
      async prepare() {},
      async close() {
        closed++;
      },
      async execute(req) {
        executed++;
        if (first)
          throw new WorkspaceToolError(
            'prepare failed',
            'COMMAND_UNAVAILABLE',
            false
          );
        return {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: req.workspaceId,
          stdout: '',
          stderr: '',
          exitCode: 0,
          truncated: false,
          timedOut: false,
        };
      },
    };
  });
  await assert.rejects(pool.execute(request('b')), {
    code: 'COMMAND_UNAVAILABLE',
  });
  assert.equal(executed, 1);
  assert.equal(closed, 1);
  await pool.execute(request('b'));
  assert.equal(created, 2);
  await pool.close();
});
test('native pool reuses roots and evicts only idle processes within its bound', async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const pool = new NativeWorkspaceCommandPool(roots, 2, (options) => {
    created.push(options.workspaceRoot);
    return {
      async prepare() {},
      async close() {
        closed.push(options.workspaceRoot);
      },
      async execute(req) {
        return {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: req.workspaceId,
          stdout: '',
          stderr: '',
          exitCode: 0,
          truncated: false,
          timedOut: false,
        };
      },
    };
  });
  await pool.execute(request('a'));
  await pool.execute(request('b'));
  await pool.execute(request('a'));
  assert.equal(created.length, 2);
  await pool.execute(request('c'));
  assert.deepEqual(closed, ['/fixture/b']);
  await pool.close();
  assert.equal(closed.length, 3);
});

test('native pool never evicts an executing root or misclassifies pre-dispatch exhaustion', async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pool = new NativeWorkspaceCommandPool(roots, 1, () => ({
    async prepare() {},
    async close() {},
    async execute(req) {
      entered();
      await pending;
      return {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: req.workspaceId,
        stdout: '',
        stderr: '',
        exitCode: 0,
        truncated: false,
        timedOut: false,
      };
    },
  }));
  const executing = pool.execute(request('a'));
  await started;
  await assert.rejects(pool.execute(request('b')), {
    code: 'COMMAND_UNAVAILABLE',
    mutationMayHaveCommitted: false,
  });
  finish();
  await executing;
  await pool.close();
});

test('idle eviction failure stays mutation-atomic for the new root', async () => {
  const pool = new NativeWorkspaceCommandPool(roots, 1, () => ({
    async prepare() {},
    async close() {
      throw new Error('fixture cleanup failure');
    },
    async execute(req) {
      return {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: req.workspaceId,
        stdout: '',
        stderr: '',
        exitCode: 0,
        truncated: false,
        timedOut: false,
      };
    },
  }));
  await pool.execute(request('a'));
  await assert.rejects(pool.execute(request('b')), {
    code: 'COMMAND_UNAVAILABLE',
    mutationMayHaveCommitted: false,
  });
  await assert.rejects(pool.close(), AggregateError);
});

interface RecordedExecutor {
  root: string;
  requests: WorkspaceExecuteCommandRequest[];
  closed: number;
}

/** Executors that hold each command until the test releases it by command text. */
function gatedExecutors(options: { failClose?: (executor: RecordedExecutor) => boolean } = {}) {
  const executors: RecordedExecutor[] = [];
  const gates = new Map<string, { entered: Promise<void>; enter(): void; finish: Promise<void>; release(): void }>();
  const gate = (command: string) => {
    let existing = gates.get(command);
    if (!existing) {
      let enter!: () => void;
      let release!: () => void;
      existing = {
        entered: new Promise<void>((resolve) => { enter = resolve; }),
        enter: () => enter(),
        finish: new Promise<void>((resolve) => { release = resolve; }),
        release: () => release(),
      };
      gates.set(command, existing);
    }
    return existing;
  };
  const failures = new Map<string, WorkspaceToolError>();
  return {
    executors,
    failures,
    entered: (command: string) => gate(command).entered,
    release: (command: string) => gate(command).release(),
    create: (sandbox: { workspaceRoot: string }) => {
      const executor: RecordedExecutor = { root: sandbox.workspaceRoot, requests: [], closed: 0 };
      executors.push(executor);
      return {
        async prepare() {},
        async close() {
          executor.closed += 1;
          if (options.failClose?.(executor)) throw new Error('fixture cleanup failure');
        },
        async execute(req: WorkspaceExecuteCommandRequest) {
          executor.requests.push(req);
          const running = gate(req.command);
          running.enter();
          await running.finish;
          const failure = failures.get(req.command);
          if (failure) throw failure;
          return {
            protocolVersion: 1 as const,
            operation: 'execute_command' as const,
            workspaceId: req.workspaceId,
            stdout: req.command,
            stderr: '',
            exitCode: 0,
            timedOut: false,
            truncated: false,
          };
        },
      };
    },
  };
}

const command = (workspaceId: string, text: string, detached = false): WorkspaceExecuteCommandRequest => ({
  ...request(workspaceId),
  command: text,
  ...(detached ? { detached: true as const } : {}),
});

for (const detachedFirst of [true, false]) {
  test(`a detached command runs in its own executor beside its root's (detached ${detachedFirst ? 'first' : 'second'})`, async () => {
    const fixture = gatedExecutors();
    const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
    const order = detachedFirst ? ['background', 'ordinary'] : ['ordinary', 'background'];
    const pending = new Map<string, Promise<unknown>>();
    for (const text of order) {
      pending.set(text, pool.execute(command('a', text, text === 'background')));
      await fixture.entered(text);
    }
    assert.deepEqual(fixture.executors.map((executor) => executor.root), ['/fixture/a', '/fixture/a']);
    const dedicated = fixture.executors[detachedFirst ? 0 : 1]!;
    const own = fixture.executors[detachedFirst ? 1 : 0]!;
    assert.deepEqual(dedicated.requests, [command('a', 'background')]);
    assert.equal('detached' in dedicated.requests[0]!, false);
    assert.deepEqual(own.requests, [command('a', 'ordinary')]);

    fixture.release('background');
    assert.deepEqual(await pending.get('background'), {
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'a',
      stdout: 'background',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    fixture.release('ordinary');
    await pending.get('ordinary');

    fixture.release('again');
    await pool.execute(command('a', 'again'));
    assert.equal(dedicated.closed, 1);
    assert.equal(own.closed, 0);
    assert.deepEqual(own.requests.map((req) => req.command), ['ordinary', 'again']);
    assert.equal(fixture.executors.length, 2);
    await pool.close();
    assert.equal(dedicated.closed, 1);
    assert.equal(own.closed, 1);
  });
}

test('a dedicated executor counts toward capacity and evicts only idle executors', async () => {
  const single = gatedExecutors();
  const serial = new NativeWorkspaceCommandPool(roots, 1, single.create);
  const ordinary = serial.execute(command('a', 'ordinary'));
  await single.entered('ordinary');
  await assert.rejects(serial.execute(command('a', 'background', true)), (error) => {
    assert.ok(error instanceof WorkspaceToolError);
    assert.deepEqual(error.commandDiagnostic, { stage: 'allocation', reason: 'capacity_exhausted' });
    assert.equal(error.mutationMayHaveCommitted, false);
    return true;
  });
  single.release('ordinary');
  await ordinary;
  await serial.close();

  const fixture = gatedExecutors();
  const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
  for (const root of ['a', 'b']) {
    fixture.release(`warm-${root}`);
    await pool.execute(command(root, `warm-${root}`));
  }
  const background = pool.execute(command('b', 'background', true));
  await fixture.entered('background');
  assert.deepEqual(fixture.executors.map((executor) => [executor.root, executor.closed]), [
    ['/fixture/a', 1],
    ['/fixture/b', 0],
    ['/fixture/b', 0],
  ]);
  const busy = pool.execute(command('b', 'busy'));
  await fixture.entered('busy');
  await assert.rejects(pool.execute(command('c', 'excess')), {
    code: 'COMMAND_UNAVAILABLE',
    mutationMayHaveCommitted: false,
  });
  for (const text of ['background', 'busy']) fixture.release(text);
  await Promise.all([background, busy]);
  fixture.release('next');
  await pool.execute(command('c', 'next'));
  assert.deepEqual(fixture.executors.map((executor) => [executor.root, executor.closed]), [
    ['/fixture/a', 1],
    ['/fixture/b', 0],
    ['/fixture/b', 1],
    ['/fixture/c', 0],
  ]);
  await pool.close();
});

test('a root is neither removed nor replaced while its detached command runs', async () => {
  const fixture = gatedExecutors();
  const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
  const identity = (ino: string) => ({
    workspaceRoot: '/fixture/lane',
    workspaceIdentity: { path: '/fixture/lane', dev: '1', ino },
  });
  await pool.registerRoot('lane', identity('1'));
  const background = pool.execute(command('lane', 'background', true));
  await fixture.entered('background');
  await assert.rejects(pool.unregisterRoot('lane'), /still executing/);
  await assert.rejects(pool.registerRoot('lane', identity('2')), /changed during execution/);
  await pool.registerRoot('lane', identity('1'));
  fixture.release('ordinary');
  await pool.execute(command('lane', 'ordinary'));
  fixture.release('background');
  await background;
  await pool.unregisterRoot('lane');
  assert.deepEqual(fixture.executors.map((executor) => executor.closed), [1, 1]);
  await assert.rejects(pool.execute(command('lane', 'gone', true)), /unavailable/);
  await pool.close();
});

test('a failed or cancelled detached command still closes its executor and spares the root', async () => {
  const fixture = gatedExecutors();
  const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
  fixture.failures.set('ambiguous', new WorkspaceToolError('executor lost', 'COMMAND_UNAVAILABLE', true, true));
  fixture.release('ambiguous');
  await assert.rejects(pool.execute(command('a', 'ambiguous', true)), {
    code: 'COMMAND_UNAVAILABLE',
    mutationMayHaveCommitted: true,
    requiresQuarantine: true,
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(pool.execute(command('a', 'never', true), cancelled.signal), {
    code: 'EXECUTION_ABORTED',
    mutationMayHaveCommitted: false,
  });
  fixture.release('ordinary');
  await pool.execute(command('a', 'ordinary'));
  assert.deepEqual(fixture.executors.map((executor) => [executor.requests.length, executor.closed]), [
    [1, 1],
    [0, 1],
    [1, 0],
  ]);
  await pool.close();
});

test('a dedicated executor that cannot confirm cleanup is kept for eviction or shutdown', async () => {
  const fixture = gatedExecutors({ failClose: (executor) => executor.requests[0]?.command === 'background' });
  const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
  fixture.release('background');
  await pool.execute(command('a', 'background', true));
  fixture.release('ordinary');
  await pool.execute(command('a', 'ordinary'));
  await assert.rejects(pool.execute(command('b', 'excess')), {
    code: 'COMMAND_UNAVAILABLE',
    mutationMayHaveCommitted: false,
  });
  await assert.rejects(pool.close(), AggregateError);
});

test('detached commands are offered only by a pool with more than one lease slot', () => {
  const base = { optOut: false, pooled: true, workspaceLeaseSlots: 2 };
  assert.equal(detachedCommandsEnabled(base), true);
  assert.equal(detachedCommandsEnabled({ ...base, enabled: ' TRUE ' }), true);
  assert.equal(detachedCommandsEnabled({ ...base, workspaceLeaseSlots: 8 }), true);
  assert.equal(detachedCommandsEnabled({ ...base, workspaceLeaseSlots: 1 }), false);
  assert.equal(detachedCommandsEnabled({ ...base, pooled: false }), false);
  assert.equal(detachedCommandsEnabled({ ...base, optOut: true }), false);
  assert.equal(detachedCommandsEnabled({ ...base, enabled: 'false' }), false);
  assert.throws(
    () => detachedCommandsEnabled({ ...base, enabled: 'sometimes' }),
    /LIBRECHAT_CODE_DETACHED_COMMANDS must be true or false/,
  );
});

test('checkout commands reach the pool with detached intact only when the sandbox offers it', async () => {
  const fixture = gatedExecutors();
  const pool = new NativeWorkspaceCommandPool(roots, 2, fixture.create);
  const files = {
    capabilities: { protocolVersion: 1 as const, operations: ['read_file' as const], workspaces: [{ id: 'a' }] },
    async execute(): Promise<never> {
      throw new Error('not a file request');
    },
  };
  const offering = new SandboxWorkspaceTools({
    workspaceTools: files,
    commandSandbox: pool,
    commandWorkspaces: ['a'],
    commandFeatures: ['detached'],
  });
  assert.deepEqual(offering.capabilities.commandFeatures, ['detached']);
  const ordinary = offering.execute(command('a', 'ordinary'));
  await fixture.entered('ordinary');
  fixture.release('background');
  const result = await offering.execute(command('a', 'background', true));
  assert.equal(result.operation === 'execute_command' && result.stdout, 'background');
  assert.deepEqual(fixture.executors.map((executor) => executor.requests), [
    [command('a', 'ordinary')],
    [command('a', 'background')],
  ]);
  fixture.release('ordinary');
  await ordinary;

  const withholding = new SandboxWorkspaceTools({
    workspaceTools: files,
    commandSandbox: pool,
    commandWorkspaces: ['a'],
  });
  assert.equal('commandFeatures' in withholding.capabilities, false);
  await assert.rejects(withholding.execute(command('a', 'refused', true)), { code: 'INVALID_REQUEST' });
  assert.equal(fixture.executors.length, 2);
  await pool.close();
});
