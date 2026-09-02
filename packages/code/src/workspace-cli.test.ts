import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('CLI validates a configured worker directory before registration', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--worker-dir',
      '/definitely/missing/librechat-code-workspace',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid workspace registration/i);
});

test('CLI falls back to the workspace ID when the directory basename is empty', async (t) => {
  let resolveRegistration: ((value: Record<string, unknown>) => void) | undefined;
  const registration = new Promise<Record<string, unknown>>((resolve) => {
    resolveRegistration = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
      if (request.url?.endsWith('/bridge/workers/register')) {
        resolveRegistration?.(body);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            workerId: body.workerId,
            incarnationId: body.incarnationId,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
          }),
        );
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ protocolVersion: 1, serverElapsedMs: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address == null || typeof address === 'string') {
    assert.fail('expected TCP listener');
  }

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--worker-dir',
      '/',
      '--workspace-id',
      'root-workspace',
    ],
    {
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: `http://127.0.0.1:${address.port}/v1`,
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_SANDBOX_ENDPOINT:
          'http://127.0.0.1:2000/api/v2',
      },
      stdio: 'ignore',
    },
  );
  t.after(() => child.kill());

  const body = await Promise.race([
    registration,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('registration timed out')), 2_000),
    ),
  ]);
  child.kill();
  await once(child, 'exit');

  assert.deepEqual(
    (body.capabilities as Record<string, unknown>).workspaceTools,
    {
      protocolVersion: 1,
      operations: ['read_file', 'search_text'],
      workspaces: [{ id: 'root-workspace', name: 'root-workspace' }],
    },
  );
});
