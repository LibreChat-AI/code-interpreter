import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWorkspaceCommandPool } from './native-pool.js';
import type { WorkspaceExecuteCommandRequest } from './protocol.js';

const roots = new Map(
  ['a', 'b', 'c'].map((id) => [id, { workspaceRoot: `/fixture/${id}` }]),
);
const request = (workspaceId: string): WorkspaceExecuteCommandRequest => ({
  protocolVersion: 1,
  operation: 'execute_command',
  workspaceId,
  command: 'fixture',
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
