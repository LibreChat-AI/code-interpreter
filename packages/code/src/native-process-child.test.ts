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
      assert.deepEqual(await exited, { code: 1, signal: null });
    },
  );
}
