import { expect, test } from 'bun:test';
import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net';
import IORedis from 'ioredis';
import { env } from './config';
import { startTestRedis } from './test/redis';
import {
  EGRESS_LEDGER_REDIS_RETRY_OPTIONS, createEgressLedger, recordEgressRead,
  assertEgressGrantActive, setEgressLedgerRedisForTest,
} from './egress-ledger';
import type { EgressGrantClaims } from './egress-grant';

test('a lost Redis mutation reply rejects without replaying its applied counter after reconnect', async () => {
  const redis = await startTestRedis();
  const sockets = new Set<Socket>();
  let dropReply = false;
  const proxy = createServer(downstream => {
    const upstream = createConnection(redis.options.path!);
    sockets.add(downstream); sockets.add(upstream);
    downstream.pipe(upstream);
    upstream.on('data', data => {
      if (dropReply) {
        dropReply = false;
        downstream.destroy(); upstream.destroy();
      } else downstream.write(data);
    });
    downstream.on('error', () => {});
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const client = new IORedis({ host: '127.0.0.1', port: (proxy.address() as AddressInfo).port,
    ...EGRESS_LEDGER_REDIS_RETRY_OPTIONS, retryStrategy: () => 10, lazyConnect: true });
  client.on('error', () => {});
  const required = env.EGRESS_LEDGER_REQUIRED;
  const compact = env.EGRESS_LEDGER_COMPACT;
  env.EGRESS_LEDGER_REQUIRED = true;
  env.EGRESS_LEDGER_COMPACT = true;
  setEgressLedgerRedisForTest(client);
  try {
    await client.connect();
    const now = Math.floor(Date.now() / 1000);
    const grant: EgressGrantClaims = { v: 1, typ: 'grant', grant_id: 'reconnect', exec_id: 'exec',
      tenant_id: 'tenant', user_id: 'user', session_key: 'session', input_files: [], read_sessions: [],
      output_session_id: 'output', max_upload_bytes: 100, max_output_files: 10, max_requests: 10, iat: now, exp: now + 300 };
    await createEgressLedger(grant);
    const reconnected = new Promise<void>(resolve => client.once('ready', resolve));
    dropReply = true;
    await expect(recordEgressRead(grant)).rejects.toThrow();
    await reconnected;
    expect((await assertEgressGrantActive(grant)).request_count).toBe(1);
    await recordEgressRead(grant);
    expect((await assertEgressGrantActive(grant)).request_count).toBe(2);
  } finally {
    env.EGRESS_LEDGER_REQUIRED = required;
    env.EGRESS_LEDGER_COMPACT = compact;
    setEgressLedgerRedisForTest(null);
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await redis.closeTestServer();
  }
}, 10000);
