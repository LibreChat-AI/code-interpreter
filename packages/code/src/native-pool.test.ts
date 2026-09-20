import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWorkspaceCommandPool } from './native-pool.js';
import { WorkspaceToolError } from './workspace.js';
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
