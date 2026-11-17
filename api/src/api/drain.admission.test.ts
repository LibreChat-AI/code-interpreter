import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { request, type Server } from 'node:http';
import { drainSandbox, resetSandboxDrainForTests, sandboxDrainSnapshot } from '../drain';
import { withSandboxDrain } from './drain';

afterEach(resetSandboxDrainForTests);

async function serve(handler: Parameters<typeof withSandboxDrain>[1]) {
  const app = express();
  app.post('/execute', withSandboxDrain(express.json(), handler));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error.message });
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return { server, url: `http://127.0.0.1:${address.port}/execute` };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error('Condition did not become true');
}

describe('drain admission across request lifecycle', () => {
  test('waits for response completion after the async handler returns', async () => {
    let returned = false;
    let finishResponse: (() => void) | undefined;
    const { server, url } = await serve(async (_req, res) => {
      res.write('partial result');
      finishResponse = () => res.end(' complete');
      returned = true;
    });
    const pendingResponse = fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    try {
      await until(() => returned);
      let drained = false;
      const pendingDrain = drainSandbox(1000, 0).then(result => { drained = true; return result; });
      await Bun.sleep(10);
      expect(sandboxDrainSnapshot().activeExecutions).toBe(1);
      expect(drained).toBe(false);
      finishResponse?.();
      expect(await (await pendingResponse).text()).toBe('partial result complete');
      expect((await pendingDrain).drained).toBe(true);
    } finally {
      finishResponse?.();
      await close(server);
    }
  });

  test('counts an unfinished upload before JSON parsing and waits for its handler', async () => {
    let entered = false;
    let finish!: () => void;
    const pendingHandler = new Promise<void>((resolve) => { finish = resolve; });
    const { server, url } = await serve(async (_req, res) => {
      entered = true;
      await pendingHandler;
      res.json({ ok: true });
    });
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    try {
      req.write('{');
      await until(() => sandboxDrainSnapshot().activeExecutions === 1);
      let drained = false;
      const pending = drainSandbox(1000, 0).then(() => { drained = true; });
      await Bun.sleep(5);
      expect(entered).toBe(false);
      expect(drained).toBe(false);
      req.end('}');
      await until(() => entered);
      // Losing the response does not stop an already admitted execution or its cleanup.
      req.destroy();
      await Bun.sleep(5);
      expect(sandboxDrainSnapshot().activeExecutions).toBe(1);
      expect(drained).toBe(false);
      finish();
      await pending;
      expect(sandboxDrainSnapshot().activeExecutions).toBe(0);
    } finally {
      finish();
      req.destroy();
      await close(server);
    }
  });

  test('releases an aborted upload without invoking the handler', async () => {
    let calls = 0;
    const { server, url } = await serve(async (_req, res) => { calls++; res.end(); });
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    try {
      req.write('{');
      await until(() => sandboxDrainSnapshot().activeExecutions === 1);
      const pending = drainSandbox(1000, 0);
      req.destroy();
      expect((await pending).drained).toBe(true);
      expect(calls).toBe(0);
    } finally {
      req.destroy();
      await close(server);
    }
  });

  test('parser failures release admission and drain rejection happens before parsing', async () => {
    let calls = 0;
    const { server, url } = await serve(async (_req, res) => { calls++; res.end(); });
    try {
      const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      expect(bad.status).toBe(400);
      expect(sandboxDrainSnapshot().activeExecutions).toBe(0);
      await drainSandbox(1000, 0);
      const rejected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      expect(rejected.status).toBe(503);
      expect((await rejected.json()).error).toBe('runner_draining');
      expect(calls).toBe(0);
    } finally {
      await close(server);
    }
  });
});
