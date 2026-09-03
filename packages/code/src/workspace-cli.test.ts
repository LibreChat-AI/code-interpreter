import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  defaultWorkspaceQuarantinePath,
  defaultWorkspacePath,
  saveWorkspaceMutationQuarantine,
} from './storage.js';

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

test('CLI trims an environment-configured worker directory', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'librechat-code-env-workspace-'),
  );
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url)), 'run'],
    {
      encoding: 'utf8',
      timeout: 500,
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_WORKER_DIR: ` ${workspaceRoot} `,
      },
    },
  );

  assert.doesNotMatch(result.stderr, /invalid workspace registration/i);
});

test('CLI refuses workspace commands without its Docker sandbox profile', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'librechat-code-command-workspace-'),
  );
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const endpoint = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--worker-dir',
      workspaceRoot,
      '--allow-workspace-commands',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
      },
    },
  );
  assert.notEqual(endpoint.status, 0);
  assert.match(endpoint.stderr, /require.*docker-nsjail runtime supervisor/i);

  const noWorkspace = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--allow-workspace-commands',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker',
      },
    },
  );
  assert.notEqual(noWorkspace.status, 0);
  assert.match(noWorkspace.stderr, /require.*registered directory/i);
});

test('CLI advertises explicitly enabled writes without exposing the workspace root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-cli-'));
  const workspaceRoot = join(root, '   ');
  await mkdir(workspaceRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
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
        const operations = (
          (body.capabilities as Record<string, unknown>)
            .workspaceTools as { operations: string[] }
        ).operations;
        if (operations.includes('write_file')) resolveRegistration?.(body);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            workerId: body.workerId,
            incarnationId: body.incarnationId,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60_000,
            supportedWorkspaceToolOperations: [
              'read_file',
              'search_text',
              'list_files',
              'write_file',
              'edit_file',
            ],
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
      workspaceRoot,
      '--workspace-id',
      'root-workspace',
      '--allow-workspace-writes',
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
      operations: [
        'read_file',
        'search_text',
        'list_files',
        'write_file',
        'edit_file',
      ],
      workspaces: [
        {
          id: 'root-workspace',
          name: 'root-workspace',
          operations: [
            'read_file',
            'search_text',
            'list_files',
            'write_file',
            'edit_file',
          ],
        },
      ],
    },
  );
  assert.equal(JSON.stringify(body).includes(workspaceRoot), false);
});

test('CLI explicitly creates and registers an application-owned default workspace', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'librechat-code-home-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'run',
        '--default-workspace',
      ],
      {
        encoding: 'utf8',
        timeout: 500,
        env: {
          ...process.env,
          HOME: testHome,
          LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
          LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
          LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
          LIBRECHAT_CODE_WORKER_DIR: '   ',
        },
      },
    );

    assert.doesNotMatch(result.stderr, /invalid workspace registration/i);
    const workspace = defaultWorkspacePath({
      codeApiUrl: 'http://127.0.0.1:1/v1',
      securityIdentity: 'worker-secret',
      workerId: 'engineering-vm',
      workspaceId: 'primary',
      homeDirectory: testHome,
    });
    const metadata = await stat(workspace);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o777, 0o700);
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
});

test('CLI refuses quarantined mutation registration until an operator clears it', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'librechat-code-cli-quarantine-'),
  );
  const workspace = join(directory, 'workspace');
  const quarantine = join(directory, 'quarantine.json');
  await mkdir(workspace);
  try {
    await saveWorkspaceMutationQuarantine(quarantine, {
      version: 1,
      workerId: 'engineering-vm',
      workspaceId: 'primary',
      quarantinedAt: new Date().toISOString(),
      reason: 'ambiguous settlement delivery',
    });
    const env = {
      ...process.env,
      LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
      LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
      LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
      LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE: quarantine,
    };
    const blocked = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'run',
        '--worker-dir',
        workspace,
        '--allow-workspace-writes',
      ],
      { encoding: 'utf8', env, timeout: 2_000 },
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /workspace mutations are quarantined/i);

    const cleared = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'clear-workspace-quarantine',
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(cleared.status, 0, cleared.stderr);
    await assert.rejects(access(quarantine));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI cannot bypass quarantine by renaming the same physical workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-cli-root-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const quarantine = defaultWorkspaceQuarantinePath({
    codeApiUrl: 'http://127.0.0.1:1/v1',
    workerId: 'engineering-vm',
    workspaceRoot: await realpath(workspace),
    homeDirectory: directory,
  });
  try {
    await saveWorkspaceMutationQuarantine(quarantine, {
      version: 1,
      workerId: 'engineering-vm',
      workspaceId: 'original-name',
      quarantinedAt: new Date().toISOString(),
      reason: 'ambiguous settlement delivery',
    });
    const env = {
      ...process.env,
      HOME: directory,
      LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
      LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
      LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
    };
    const blocked = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'run',
        '--worker-dir',
        workspace,
        '--workspace-id',
        'renamed-workspace',
        '--allow-workspace-writes',
      ],
      { encoding: 'utf8', env, timeout: 2_000 },
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /workspace mutations are quarantined/i);

    const cleared = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'clear-workspace-quarantine',
        '--worker-dir',
        workspace,
        '--workspace-id',
        'renamed-workspace',
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(cleared.status, 0, cleared.stderr);
    await assert.rejects(access(quarantine));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
