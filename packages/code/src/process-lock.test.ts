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
        '--input-type=module',
        '-e',
        `
    import { withProcessLock } from ${JSON.stringify(moduleUrl)};
    await withProcessLock(${JSON.stringify(path)}, async () => {
      process.stdout.write('locked');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill('SIGKILL');
      await closed;
      await rm(directory, { recursive: true, force: true });
    });
    await once(child.stdout!, 'data');
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
    child.kill('SIGKILL');
    await closed;
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
