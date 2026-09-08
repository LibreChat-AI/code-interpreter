import { expect, test } from 'bun:test';
import { resolve } from 'path';

test('/exec validates timeout before enqueue and forwards its cap to both language queues', async () => {
  // Isolate infrastructure mocks; exercise the real router, timeout policy,
  // payload builder, and security preparation without Redis or a sandbox.
  const probe = Bun.spawn([process.execPath, '-e', `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    const passthrough = (_req, _res, next) => next();
    mock.module('./src/middleware/auth', () => ({ sessionAuth: passthrough }));
    mock.module('./src/middleware/limits', () => ({
      executionLimiter: passthrough, uploadLimiter: passthrough,
      downloadLimiter: passthrough, fetchLimiter: passthrough,
    }));
    mock.module('./src/lifecycle', () => ({
      checkServiceStartUp: () => false, checkServiceShutDown: () => false,
    }));
    let writes = 0;
    let submitted = [];
    const queue = (name) => ({ add: async (_type, data) => {
      submitted.push({ name, data });
      return { waitUntilFinished: async () => ({ ok: true }), remove: async () => {} };
    }});
    mock.module('./src/queue', () => ({
      pyQueue: queue('python'), otherQueue: queue('other'),
      pyQueueEvents: {}, otherQueueEvents: {}, queueNames: { python: 'python', other: 'other' },
      connection: { set: async () => { writes++; return 'OK'; } },
    }));
    const { env } = await import('./src/config');
    env.JOB_TIMEOUT = 15000;
    env.RUNTIME_SESSION_MODE = 'stateless';
    env.SANDBOX_BACKEND = 'http';
    env.HARDENED_SANDBOX_MODE = false;
    env.EGRESS_GRANT_SECRET = '';
    env.EXECUTION_MANIFEST_SECRET = '';
    const { default: router } = await import('./src/service/router');
    const handler = router.stack.find(layer => layer.route?.path === '/exec').route.stack.at(-1).handle;
    async function request(lang, timeout) {
      submitted = [];
      writes = 0;
      const req = {
        body: { code: 'print(1)', lang, timeout }, headers: {}, header: () => undefined, on: () => {},
        codeApiPrincipal: { userId: 'user', tenantId: 'tenant', principalSource: 'none' },
        codeApiAuthContext: { userId: 'user', tenantId: 'tenant' },
      };
      const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler(req, res);
      return res;
    }
    for (const lang of ['py', 'bash']) {
      for (const [input, expected] of [[1000, 1000], [1000.1, 1001], [0.1, 1], [999999, 15000], [null, undefined], [undefined, undefined]]) {
        const res = await request(lang, input);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].name, lang === 'py' ? 'python' : 'other');
        assert.equal(submitted[0].data.payload.run_timeout, expected);
        if (expected === undefined) assert.equal('run_timeout' in submitted[0].data.payload, false);
      }
    }
    for (const input of [0, -1, '1000', true, {}, [], NaN, Infinity]) {
      const res = await request('py', input);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /timeout must be a positive number of milliseconds/);
      assert.equal(submitted.length, 0);
      assert.equal(writes, 0, 'invalid timeout must not register a session');
    }
    console.log('EXEC_TIMEOUT_OK');
  `], { cwd: resolve(__dirname, '../..'), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain('EXEC_TIMEOUT_OK');
}, 15000);
