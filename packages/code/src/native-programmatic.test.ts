import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NativeWorkspaceProgrammaticExecutor } from './native-programmatic.js';

import type { AddressInfo } from 'node:net';
import type { BridgeWorkspaceProgrammaticRequest } from './protocol.js';

test('stages skill files privately and returns generated artifacts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'native-ptc-test-'));
  const uploads = new Map<string, Buffer>();
  let downloadCount = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-codeapi-egress-grant'], 'grant');
    if (req.method === 'GET') {
      downloadCount += 1;
      assert.match(req.url ?? '', /\/sessions\/input-session\/objects\/skill-file$/);
      res.end('skill-value');
      return;
    }
    assert.equal(req.method, 'PUT');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    uploads.set(decodeURIComponent(req.headers['x-original-filename'] as string), Buffer.concat(chunks));
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  let observedDataDirectory = '';
  const executor = new NativeWorkspaceProgrammaticExecutor({
    upstreamUrl: `http://127.0.0.1:${address.port}`,
    sandbox: {
      async createExecutionDirectory() {
        return await mkdtemp(join(scratch, 'execution-'));
      },
      async executeProgrammatic(request, dataDirectory) {
        observedDataDirectory = dataDirectory;
        assert.equal(
          await readFile(join(dataDirectory, 'skills/example/reference.txt'), 'utf8'),
          'skill-value',
        );
        await writeFile(join(dataDirectory, 'result.txt'), 'artifact');
        return {
          protocolVersion: 1,
          operation: 'execute_command' as const,
          workspaceId: request.workspaceId,
          exitCode: 0,
          stdout: 'done\n',
          stderr: '',
          truncated: false,
          timedOut: false,
        };
      },
    },
  });
  const request: BridgeWorkspaceProgrammaticRequest = {
    headers: {},
    body: {
      language: 'bash',
      version: '5.2.0',
      session_id: 'execution-session',
      output_session_id: 'output-session',
      egress_grant: 'grant',
      files: [
        { name: 'main.sh', content: 'printf done' },
        { name: '_ptc_history.json', content: '{}' },
        {
          name: 'skills/example/reference.txt',
          id: 'skill-file',
          storage_session_id: 'input-session',
          input_cache_key: createHash('sha256')
            .update('stable-authorized-input-identity')
            .digest('hex'),
        },
      ],
    },
  };
  try {
    const result = await executor.execute(request, 'primary');
    const replay = await executor.execute(request, 'primary');
    assert.equal(result.run.stdout, 'done\n');
    assert.equal(replay.run.stdout, 'done\n');
    assert.equal(result.session_id, 'output-session');
    assert.equal(downloadCount, 1);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.name, 'result.txt');
    assert.equal(uploads.get('result.txt')?.toString(), 'artifact');
    assert.deepEqual(await readdir(observedDataDirectory).catch(() => []), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rejects traversal before creating execution state', async () => {
  let allocated = false;
  const executor = new NativeWorkspaceProgrammaticExecutor({
    upstreamUrl: 'http://127.0.0.1:1',
    sandbox: {
      async createExecutionDirectory() {
        allocated = true;
        return '/unused';
      },
      async executeProgrammatic() {
        throw new Error('unreachable');
      },
    },
  });
  await assert.rejects(
    executor.execute(
      {
        headers: {},
        body: {
          language: 'bash',
          version: '5.2.0',
          session_id: 'execution-session',
          files: [{ name: '../main.sh', content: 'echo unsafe' }],
        },
      },
      'primary',
    ),
    /Invalid selected-workspace programmatic request/,
  );
  assert.equal(allocated, false);
});

test('stops admitting downloads and drains in-flight transfers before cleanup', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'native-ptc-transfer-test-'));
  let executionDirectory = '';
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      res.statusCode = 503;
      res.end();
      return;
    }
    setTimeout(() => res.end('in-flight'), 25);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const executor = new NativeWorkspaceProgrammaticExecutor({
    upstreamUrl: `http://127.0.0.1:${address.port}`,
    sandbox: {
      async createExecutionDirectory() {
        executionDirectory = await mkdtemp(join(scratch, 'execution-'));
        return executionDirectory;
      },
      async executeProgrammatic() {
        throw new Error('unreachable');
      },
    },
  });
  const request: BridgeWorkspaceProgrammaticRequest = {
    headers: {},
    body: {
      language: 'bash',
      version: '5.2.0',
      session_id: 'execution-session',
      output_session_id: 'output-session',
      egress_grant: 'grant',
      files: [
        ...Array.from({ length: 8 }, (_, index) => ({
          name: `inputs/${index}.txt`,
          id: `input-${index}`,
          storage_session_id: 'input-session',
        })),
        { name: 'main.sh', content: 'printf done' },
      ],
    },
  };
  try {
    const startedAt = performance.now();
    await assert.rejects(
      executor.execute(request, 'primary'),
      /Programmatic input download failed with HTTP 503/,
    );
    assert.ok(performance.now() - startedAt >= 20);
    assert.ok(requestCount <= 4);
    assert.deepEqual(await readdir(executionDirectory).catch(() => []), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
