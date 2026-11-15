import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';

import type { StorePairing, StorePairingLog, StorePairingMonitor, StoreProbeWriter } from './store-pairing';

import { createHealthHandler } from './health';
import { INTERNAL_SERVICE_TOKEN_ENV } from './internal-service-auth';
import { createStorePairingMonitor, createStoreProbeRouter, probeFileServerStore } from './store-pairing';
import { startTestRedis } from './test/redis';

type TestRedis = Awaited<ReturnType<typeof startTestRedis>>;
type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; meta?: object };

const TOKEN = 'store-pairing-test-internal-token';
const FAST = { confirmMs: 5, retryMs: 5, maxRetryMs: 20, recheckMs: 10 };
const originalToken = process.env[INTERNAL_SERVICE_TOKEN_ENV];

let apiRedis: TestRedis;
let otherRedis: TestRedis;
const servers: Server[] = [];
const monitors: StorePairingMonitor[] = [];

beforeAll(async () => {
  process.env[INTERNAL_SERVICE_TOKEN_ENV] = TOKEN;
  [apiRedis, otherRedis] = await Promise.all([startTestRedis(), startTestRedis()]);
});

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await Promise.all([apiRedis.flushall(), otherRedis.flushall()]);
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env[INTERNAL_SERVICE_TOKEN_ENV];
  else process.env[INTERNAL_SERVICE_TOKEN_ENV] = originalToken;
  await Promise.all([apiRedis.closeTestServer(), otherRedis.closeTestServer()]);
});

function listen(app: express.Express, port = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    servers.push(server);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** A file server's probe route over the Redis it is configured with. */
function fileServerOn(store: { exists(key: string): Promise<number> }, port?: number): Promise<string> {
  const app = express();
  app.use(createStoreProbeRouter(store, () => undefined));
  return listen(app, port);
}

/** A file server released before the probe route existed: object routes only. */
function olderFileServer(): Promise<string> {
  const app = express();
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  return listen(app);
}

function captureLog(): { log: StorePairingLog; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: LogEntry['level']) => (message: string, meta?: object): void => {
    entries.push({ level, message, meta });
  };
  return { entries, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

function monitorFor(probe: () => Promise<StorePairing>, log: StorePairingLog): StorePairingMonitor {
  const monitor = createStorePairingMonitor({ probe, log, fileServer: 'file-server.test:3000', delays: FAST });
  monitors.push(monitor);
  return monitor;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not met in time');
}

/** The API's `/v1/health`, gated on the monitor the way `lifecycle.ts` wires it. */
function apiHealth(monitor: StorePairingMonitor): Promise<string> {
  const app = express();
  app.get('/v1/health', createHealthHandler({
    ping: () => apiRedis.ping(),
    fileServerStoreMismatch: () => monitor.status() === 'split',
    onPingError: () => undefined,
  }));
  return listen(app);
}

describe('probeFileServerStore', () => {
  test('reports shared when the file server reads the API\'s Redis', async () => {
    const fileServerUrl = await fileServerOn(apiRedis);

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl })).toEqual({ status: 'shared' });
  });

  test('reports split when the file server reads another Redis', async () => {
    const fileServerUrl = await fileServerOn(otherRedis);

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl })).toEqual({ status: 'split' });
    expect(await otherRedis.keys('*')).toEqual([]);
  });

  test('leaves a probe key that expires on its own when cleanup never runs', async () => {
    const fileServerUrl = await fileServerOn(apiRedis);
    const withoutCleanup: StoreProbeWriter = {
      set: (key: string, value: string, mode: 'EX', ttl: number) => apiRedis.set(key, value, mode, ttl),
      del: async () => 0,
    };

    await probeFileServerStore({ store: withoutCleanup, fileServerUrl });

    const [key, ...rest] = await apiRedis.keys('*');
    expect(rest).toEqual([]);
    expect(key).toMatch(/^store-probe:[0-9a-f]{32}$/);
    const ttl = await apiRedis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('removes its probe key once the check is done', async () => {
    const fileServerUrl = await fileServerOn(apiRedis);

    await probeFileServerStore({ store: apiRedis, fileServerUrl });

    expect(await apiRedis.keys('*')).toEqual([]);
  });

  test('treats a file server without the probe route as unknown, not as a mismatch', async () => {
    const fileServerUrl = await olderFileServer();

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl }))
      .toEqual({ status: 'unknown', reason: 'endpoint_missing' });
  });

  test('treats a file server that cannot read its Redis as unknown', async () => {
    const fileServerUrl = await fileServerOn({ exists: () => Promise.reject(new Error('Connection is closed.')) });

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl }))
      .toEqual({ status: 'unknown', reason: 'file_server_unavailable' });
  });

  test('treats an answer that is not the probe protocol as unknown', async () => {
    const app = express();
    app.post('/internal/store-probe', (_req, res) => res.status(200).send('<html>proxy</html>'));
    const fileServerUrl = await listen(app);

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl }))
      .toEqual({ status: 'unknown', reason: 'unexpected_response' });
  });

  test('gives up on a file server that never answers within the timeout', async () => {
    const app = express();
    app.post('/internal/store-probe', () => undefined);
    const fileServerUrl = await listen(app);
    const started = Date.now();

    expect(await probeFileServerStore({ store: apiRedis, fileServerUrl, timeoutMs: 100 }))
      .toEqual({ status: 'unknown', reason: 'file_server_unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('gives up on a Redis write that never completes within the timeout', async () => {
    const fileServerUrl = await fileServerOn(apiRedis);
    const stalled: StoreProbeWriter = { set: () => new Promise<never>(() => undefined), del: async () => 0 };
    const started = Date.now();

    expect(await probeFileServerStore({ store: stalled, fileServerUrl, timeoutMs: 100 }))
      .toEqual({ status: 'unknown', reason: 'store_unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('store pairing monitor', () => {
  test('passes once for a file server on the same Redis and keeps the API healthy', async () => {
    const fileServerUrl = await fileServerOn(apiRedis);
    const { log, entries } = captureLog();
    let probes = 0;
    const monitor = monitorFor(() => {
      probes += 1;
      return probeFileServerStore({ store: apiRedis, fileServerUrl });
    }, log);

    await monitor.start();
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(monitor.status()).toBe('shared');
    expect(probes).toBe(1);
    expect(entries.map(entry => entry.level)).toEqual(['info']);
    expect((await fetch(`${await apiHealth(monitor)}/v1/health`)).status).toBe(200);
  });

  test('fails the health check for a file server on another Redis and recovers once it is corrected', async () => {
    let fileServerRedis: TestRedis = otherRedis;
    const fileServerUrl = await fileServerOn({ exists: key => fileServerRedis.exists(key) });
    const { log, entries } = captureLog();
    const monitor = monitorFor(() => probeFileServerStore({ store: apiRedis, fileServerUrl }), log);
    const healthUrl = `${await apiHealth(monitor)}/v1/health`;

    await monitor.start();

    expect(monitor.status()).toBe('split');
    const unhealthy = await fetch(healthUrl);
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toEqual({ status: 'not ready', checks: { fileServerStore: 'mismatch' } });
    const [first] = entries;
    expect(first.level).toBe('error');
    expect(first.message).toContain('does not share this API\'s Redis');
    expect(first.meta).toEqual({ fileServer: 'file-server.test:3000' });

    fileServerRedis = apiRedis;
    await waitFor(() => monitor.status() === 'shared');

    expect((await fetch(healthUrl)).status).toBe(200);
    expect(entries.at(-1)?.level).toBe('info');
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('store-probe:');
  });

  test('starts against an older file server with a single warning', async () => {
    const fileServerUrl = await olderFileServer();
    const { log, entries } = captureLog();
    let probes = 0;
    const monitor = monitorFor(() => {
      probes += 1;
      return probeFileServerStore({ store: apiRedis, fileServerUrl });
    }, log);

    await monitor.start();
    await waitFor(() => probes >= 3);

    expect(monitor.status()).toBe('unknown');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].message).toContain('older version');
    expect(entries[0].meta).toEqual({ fileServer: 'file-server.test:3000', reason: 'endpoint_missing' });
    expect((await fetch(`${await apiHealth(monitor)}/v1/health`)).status).toBe(200);
  });

  test('does not wait for a file server that is still coming up, and checks it once it is', async () => {
    const reserved = await fileServerOn(apiRedis);
    const port = Number(new URL(reserved).port);
    const [placeholder] = servers.splice(0);
    await new Promise(resolve => placeholder.close(resolve));
    const { log, entries } = captureLog();
    const monitor = monitorFor(() => probeFileServerStore({ store: apiRedis, fileServerUrl: reserved }), log);

    await monitor.start();

    expect(monitor.status()).toBe('unknown');
    expect(entries.map(entry => entry.level)).toEqual(['warn']);

    await fileServerOn(apiRedis, port);
    await waitFor(() => monitor.status() === 'shared');

    expect(entries.map(entry => entry.level)).toEqual(['warn', 'info']);
  });

  test('does not report a mismatch the next check contradicts', async () => {
    const results: StorePairing[] = [{ status: 'split' }, { status: 'shared' }];
    const { log, entries } = captureLog();
    const seen: string[] = [];
    const monitor = monitorFor(async () => {
      seen.push(monitor.status());
      return results.shift() ?? { status: 'shared' };
    }, log);

    await monitor.start();

    expect(monitor.status()).toBe('shared');
    expect(seen).toEqual(['unknown', 'unknown']);
    expect(entries.map(entry => entry.level)).toEqual(['info']);
  });

  test('keeps a confirmed mismatch through a file server outage but not through a rollback', async () => {
    const results: StorePairing[] = [
      { status: 'split' },
      { status: 'split' },
      { status: 'unknown', reason: 'file_server_unavailable' },
    ];
    const seen: string[] = [];
    const { log } = captureLog();
    const monitor = monitorFor(async () => {
      seen.push(monitor.status());
      return results.shift() ?? { status: 'unknown', reason: 'endpoint_missing' };
    }, log);

    await monitor.start();
    await waitFor(() => monitor.status() === 'unknown');

    /* Status before each check: unconfirmed, confirmed, and still split after the outage. */
    expect(seen.slice(0, 4)).toEqual(['unknown', 'unknown', 'split', 'split']);
  });

  test('stops checking once stopped', async () => {
    let probes = 0;
    const { log } = captureLog();
    const monitor = monitorFor(async () => {
      probes += 1;
      return { status: 'unknown', reason: 'file_server_unavailable' };
    }, log);

    await monitor.start();
    monitor.stop();
    const settled = probes;
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(probes).toBe(settled);
  });
});
