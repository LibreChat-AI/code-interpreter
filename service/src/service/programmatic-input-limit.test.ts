import { expect, test } from 'bun:test';
import { resolve } from 'path';

test('selected-workspace replay caps authorized, coalesced inputs', async () => {
  // Keep infrastructure mocks isolated from other suites. Cancellation stops
  // accepted requests after validation, before any execution state is written.
  const probe = Bun.spawn([process.execPath, '-e', `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_INPUT_FILES as limit,
      BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES as totalLimit } from '../packages/code/src/protocol';
    const passthrough = (_req, _res, next) => next();
    mock.module('./src/middleware/limits', () => ({
      executionLimiter: passthrough, cancellationLimiter: passthrough,
    }));
    mock.module('./src/lifecycle', () => ({
      checkServiceStartUp: () => false, checkServiceShutDown: () => false,
    }));
    mock.module('./src/request-disconnect', () => ({
      observeRequestDisconnect: () => ({
        signal: AbortSignal.abort(), isDisconnected: () => false, dispose() {},
      }),
    }));
    const stored = new Map();
    mock.module('./src/queue', () => ({
      pyQueue: {}, pyQueueEvents: {}, jobCancellationRegistry: {},
      getExecutionQueueBinding() { throw new Error('must not enqueue'); },
      getExistingExecutionJob() { throw new Error('must not look up jobs'); },
      connection: {
        defineCommand() {},
        get: async key => stored.get(key) ?? null,
        exists: async key => stored.has(key) ? 1 : 0,
      },
    }));
    const { env } = await import('./src/config');
    env.PTC_MODE = 'replay';
    env.SANDBOX_BACKEND = 'remote-bridge';
    env.BRIDGE_DYNAMIC_WORKERS = true;
    const { resolveSessionKey } = await import('./src/session-key');
    const { default: router } = await import('./src/service/programmatic-router');
    const handler = router.stack.find(layer => layer.route?.path === '/exec/programmatic').route.stack.at(-1).handle;
    const auth = { userId: 'user_123', tenantId: 'tenant_abc' };
    const sessionKey = resolveSessionKey({ codeApiAuthContext: auth }, { kind: 'user', id: auth.userId });
    function file(index, name = 'input-' + index + '.txt') {
      const result = {
        id: 'file_' + String(index).padStart(16, '0'), resource_id: 'rsrc_1234567890123456',
        storage_session_id: 'sess_1234567890123456', name, kind: 'user',
      };
      stored.set('session:' + result.storage_session_id, sessionKey);
      stored.set('upload:' + sessionKey + result.storage_session_id + result.id, 'true');
      return result;
    }
    async function request(files) {
      const req = {
        body: { code: 'ls', language: 'bash', tools: [], files },
        header: name => name === 'X-LibreChat-Code-Workspace-ID' ? 'workspace-1' : undefined,
        codeApiPrincipal: { ...auth, principalSource: 'none', codeWorkerId: 'worker-1' },
        codeApiAuthContext: auth,
      };
      const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler(req, res);
      return { req, res };
    }
    assert.equal(limit + 2, totalLimit, 'main and history reserve two slots');
    const boundary = Array.from({ length: limit }, (_, index) => file(index));
    const replacement = file(limit, boundary[0].name);
    for (const [inputs, expected] of [
      [boundary, boundary],
      [[...boundary, boundary[0]], boundary],
      [[...boundary, replacement, boundary[0]], [...boundary.slice(1), replacement]],
    ]) {
      const { req, res } = await request(inputs);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.error, 'Programmatic execution request cancelled');
      assert.deepEqual(req.body.files, expected);
    }
    const { res: oversized } = await request([...boundary, file(limit + 1)]);
    assert.equal(oversized.statusCode, 400);
    assert.equal(oversized.body.error, 'Selected-workspace execution allows at most ' + limit + ' input files; main and replay history occupy two reserved slots');
    for (const unauthorized of [
      { ...boundary[0], kind: 'agent' },
      { ...boundary[0], storage_session_id: 'sess_abcdefghijklmnop' },
    ]) {
      const { res } = await request([unauthorized, ...boundary]);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'Unauthorized file reference');
    }
    console.log('PROGRAMMATIC_INPUT_LIMIT_OK');
    process.exit(0);
  `], { cwd: resolve(__dirname, '../..'), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain('PROGRAMMATIC_INPUT_LIMIT_OK');
}, 15000);
