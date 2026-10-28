import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withProcessLock } from './process-lock.js';

test(
  'kernel lock survives contention and is released when the owning process crashes',
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'librechat-lock-'));
    const path = join(directory, '.provision.lock');
    const moduleUrl = new URL('./process-lock.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '-e',
        `
    import { setTimeout as delay } from 'node:timers/promises';
    import { withProcessLock } from ${JSON.stringify(moduleUrl)};
    await withProcessLock(${JSON.stringify(path)}, async () => {
      setImmediate(() => {
        global.gc();
        setImmediate(() => process.send('locked'));
      });
      // The timer retains its resolver and the lock-owning async frame.
      await delay(60_000);
    });
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-4096);
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill('SIGKILL');
      try {
        await closed;
      } finally {
        t.diagnostic(
          JSON.stringify({
            stdout,
            stderr,
            exitCode: child.exitCode,
            signal: child.signalCode,
          })
        );
        await rm(directory, { recursive: true, force: true });
      }
    });
    await Promise.race([
      once(child, 'message', { signal: t.signal }).then(([marker]) => {
        assert.equal(marker, 'locked');
        t.diagnostic('Lock owner ready: locked (after GC)');
      }),
      closed.then(([code, signal]) => {
        throw new Error(
          `Lock owner exited before readiness: ${code}/${signal}`
        );
      }),
    ]);
    let entered = false;
    await assert.rejects(
      withProcessLock(
        path,
        async () => {
          entered = true;
        },
        AbortSignal.timeout(100)
      )
    );
    assert.equal(entered, false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    child.kill('SIGKILL');
    assert.deepEqual(await closed, [null, 'SIGKILL']);
    await withProcessLock(
      path,
      async () => {
        entered = true;
      },
      AbortSignal.timeout(1000)
    );
    assert.equal(entered, true);
  }
);
