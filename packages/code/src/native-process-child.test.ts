import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';
import { nativeExecutorEnvironment } from './native-process.js';

for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
  test(
    `executor routes ${signal} through shutdown rather than default signal exit`,
    { skip: process.platform === 'win32', timeout: 10_000 },
    async (t) => {
      const child = fork(
        new URL('./native-process-child.js', import.meta.url),
        [],
        {
          execArgv: [],
          env: nativeExecutorEnvironment(process.env),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      t.after(() => {
        child.kill('SIGKILL');
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, exitSignal) =>
          resolve({ code, signal: exitSignal }),
        );
      });
      // An invalid-state reply proves module initialization and signal-handler
      // installation finished without requiring platform SRT dependencies.
      child.once('message', () => child.kill(signal));
      child.send({ id: 'startup-probe', type: 'probe' });
      assert.deepEqual(await exited, { code: 0, signal: null });
    },
  );
}

test(
  'executor replies to a non-workspace failure with its sanitized cause and no message',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async (t) => {
    const child = fork(
      new URL('./native-process-child.js', import.meta.url),
      [],
      {
        execArgv: [],
        env: nativeExecutorEnvironment(process.env),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    t.after(() => {
      child.kill('SIGKILL');
    });
    const reply = new Promise<unknown>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', resolve);
    });
    // An execute before prepare fails with a plain Error, not a WorkspaceToolError.
    child.send({ id: 'unprepared-execute', type: 'execute' });
    assert.deepEqual(await reply, {
      id: 'unprepared-execute',
      ok: false,
      diagnostic: {
        stage: 'dispatch',
        reason: 'executor_rejected',
        errorName: 'Error',
      },
      code: 'COMMAND_UNAVAILABLE',
      mutation: false,
      requiresQuarantine: false,
      fatal: false,
    });
  },
);
