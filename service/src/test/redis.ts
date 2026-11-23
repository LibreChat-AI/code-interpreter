import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import IORedis from 'ioredis';

/**
 * Real Lua semantics, isolated Unix socket, no durable data. No TCP listener
 * unless `tcpPort` asks for a loopback one, for a process that takes only
 * `REDIS_HOST`/`REDIS_PORT`.
 */
export async function startTestRedis(
  opts: { tcpPort?: number } = {},
): Promise<IORedis & { closeTestServer(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codeapi-redis-'));
  const socket = path.join(dir, 'redis.sock');
  const process = spawn('redis-server', [
    '--port', String(opts.tcpPort ?? 0), '--bind', '127.0.0.1', '--unixsocket', socket, '--unixsocketperm', '700',
    '--save', '', '--appendonly', 'no', '--dir', dir,
  ], { stdio: 'ignore' });
  let failure: Error | undefined;
  process.on('error', error => { failure = error; });
  const exited = new Promise<void>(resolve => {
    process.once('exit', () => resolve());
    process.once('error', () => resolve());
  });
  const client = new IORedis(socket, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 });
  client.on('error', () => {});
  const closeTestServer = async (): Promise<void> => {
    client.disconnect();
    process.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      try {
        await client.connect();
        await client.ping();
        return Object.assign(client, { closeTestServer });
      } catch {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    throw new Error('Test Redis did not start; install redis-server');
  } catch (error) {
    await closeTestServer();
    throw error;
  }
}
