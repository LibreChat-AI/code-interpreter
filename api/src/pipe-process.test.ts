import { describe, test, expect } from 'bun:test';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import { spawnPipeProcess } from './pipe-process';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('anonymous process pipes', () => {
  test('large concurrent streams preserve backpressure and output before close', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 'p');
    await Promise.all(Array.from({ length: 8 }, async () => {
      const child = spawnPipeProcess('/bin/sh', ['-c', 'cat; printf stderr >&2']);
      const closed = once(child, 'close');
      const output = collect(child.stdout);
      const errors = collect(child.stderr);
      await pipeline(Readable.from([bytes]), child.stdin);
      const [code] = await closed;
      expect(code).toBe(0);
      expect(await output).toEqual(bytes);
      expect((await errors).toString()).toBe('stderr');
    }));
  }, 15000);

  test.skipIf(process.platform !== 'linux')('Linux children receive FIFO stdin, stdout and stderr', async () => {
    const child = spawnPipeProcess('/bin/sh', ['-c', 'test -p /proc/self/fd/0 && test -p /proc/self/fd/1 && test -p /proc/self/fd/2']);
    child.stdin.end();
    const [code] = await once(child, 'close');
    if (process.platform === 'linux') expect(code).toBe(0);
  });

  test('cancellation releases a blocked stdin writer', async () => {
    const child = spawnPipeProcess('/bin/sleep', ['30']);
    const closed = once(child, 'close');
    const writing = pipeline(Readable.from([Buffer.alloc(2 * 1024 * 1024)]), child.stdin);
    // Observe immediately: cancellation may reject before the exit listener.
    const rejected = writing.then(() => false, () => true);
    await new Promise(resolve => setTimeout(resolve, 20));
    child.kill('SIGKILL');
    await closed;
    expect(await rejected).toBe(true);
    expect(child.stdin.destroyed).toBe(true);
  }, 5000);

  test('spawn failures and killed children release every pipe', async () => {
    const before = process.platform === 'linux' ? fs.readdirSync('/proc/self/fd').length : 0;
    for (let n = 0; n < 12; n++) {
      const missing = spawnPipeProcess('/missing-codeapi-executable');
      const missingClosed = new Promise<void>(resolve => missing.once('close', () => resolve()));
      const error = await new Promise<NodeJS.ErrnoException>(resolve => missing.once('error', resolve));
      expect(error.code).toBe('ENOENT');
      await missingClosed;
      const child = spawnPipeProcess('/bin/sleep', ['30']);
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    }
    if (process.platform === 'linux') expect(fs.readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before + 2);
  }, 10000);
});
