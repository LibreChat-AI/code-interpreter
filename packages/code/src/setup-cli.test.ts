import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const code = 'secret-one-time-code-123456789';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'setup-cli-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('LIBRECHAT_CODE_'),
      ),
    ),
    HOME: home,
  };
  const profilePath = join(
    home,
    '.config',
    'librechat',
    'code',
    'profiles',
    'default.json',
  );
  return { home, env, profilePath };
}

async function execute(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: 'pipe' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
  });
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  child.stdin.end(stdin);
  const [status] = await once(child, 'exit', {
    signal: AbortSignal.timeout(10_000),
  });
  return { status, stdout, stderr };
}

test('CLI help explains the pairing prerequisite and setup does not silently read piped prompts', async t => {
  const { env } = await fixture(t);
  const help = spawnSync(process.execPath, [cli, 'setup', '--help'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Settings > Code Environments/);
  assert.match(help.stdout, /does not\nsign in to LibreChat/);
  const guided = await execute(['setup'], env, code);
  assert.notEqual(guided.status, 0);
  assert.match(guided.stderr, /requires a terminal/);
  assert.ok(!guided.stdout.includes(code));
  assert.ok(!guided.stderr.includes(code));
});

test(
  'CLI setup followed by plain run registers the saved identity with read-only access',
  { timeout: 15_000 },
  async t => {
    const { env, profilePath } = await fixture(t);
    let paired = false;
    let registered!: (body: Record<string, any>) => void;
    const registration = new Promise<Record<string, any>>(resolve => {
      registered = resolve;
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/bridge/pairings/redeem') {
        assert.equal(body.workerId, 'guided-vm');
        assert.equal(body.code, code);
        assert.match(body.publicKey, /BEGIN PUBLIC KEY/);
        assert.equal(body.privateKey, undefined);
        paired = true;
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            workerId: body.workerId,
            credential: 'short-lived-worker-credential-value',
            expiresAt: '2099-01-01T00:00:00Z',
          }),
        );
        return;
      }
      if (request.url === '/v1/bridge/workers/register') {
        assert.equal(paired, true);
        assert.match(request.headers.authorization ?? '', /^Bridge /);
        assert.ok(request.headers['x-librechat-code-signature']);
        registered(body);
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
      response.end(JSON.stringify({ protocolVersion: 1, serverElapsedMs: 0 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await execute(
      [
        'setup',
        '--non-interactive',
        '--code-stdin',
        '--url',
        `http://127.0.0.1:${address.port}/v1`,
        '--worker-id',
        'guided-vm',
        '--default-workspace',
      ],
      env,
      `${code}\n`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /librechat-code run\n/);
    assert.match(result.stdout, /still needs to start/);
    assert.ok(!result.stdout.includes(code));
    assert.ok(!result.stderr.includes(code));
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    assert.equal(profile.allowWorkspaceWrites, false);
    assert.equal(profile.allowWorkspaceCommands, false);
    const worker = spawn(process.execPath, [cli, 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    worker.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    const exited = once(worker, 'exit');
    t.after(() => worker.kill('SIGKILL'));
    const body = await Promise.race([
      registration,
      exited.then(() => {
        throw new Error(`Worker exited before registration: ${stderr}`);
      }),
    ]);
    worker.kill('SIGTERM');
    await exited;
    assert.equal(body.workerId, 'guided-vm');
    const operations = body.capabilities.workspaceTools.operations as string[];
    assert.ok(operations.includes('read_file'));
    assert.ok(!operations.includes('write_file'));
    assert.ok(!operations.includes('execute_command'));
    assert.ok(!JSON.stringify(body).includes(profile.identityPath));
    assert.ok(!JSON.stringify(body).includes(profilePath));
  },
);

test('CLI rejects missing automation inputs without consuming stdin or pairing', async t => {
  const { env } = await fixture(t);
  const result = await execute(['setup', '--non-interactive'], env, code);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --url, --worker-id, --code-stdin/);
  assert.ok(!result.stderr.includes(code));
});

test('CLI refuses unsafe URLs before disclosing the code', async t => {
  const { env } = await fixture(t);
  const result = await execute(
    [
      'setup',
      '--non-interactive',
      '--code-stdin',
      '--url',
      'http://external.example/v1',
      '--worker-id',
      'vm',
      '--default-workspace',
    ],
    env,
    code,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires HTTPS/);
  assert.ok(!result.stdout.includes(code));
  assert.ok(!result.stderr.includes(code));
});

for (const [name, secretEditing] of [
  ['history', ''],
  ['kill beginning', '\x15\x19'],
  ['kill end', '\x01\x0b\x19'],
  ['kill word', '\x17\x19'],
])
  test(
    `terminal ${name} never recalls a hidden pairing code at confirmation`,
    { timeout: 10_000 },
    async t => {
      const { env } = await fixture(t);
      const secret = 'SyntheticPairingSecret0123456789';
      // Real readline terminal editing over pipes avoids an OS-specific PTY dependency.
      const bootstrap = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.argv = [process.execPath, ${JSON.stringify(cli)}, 'setup', '--url',
      'https://code.example/v1', '--worker-id', 'history-vm', '--default-workspace'];
    await import(${JSON.stringify(new URL('./cli.js', import.meta.url).href)});
  `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '--eval', bootstrap],
        { env, stdio: 'pipe' },
      );
      t.after(() => child.kill('SIGKILL'));
      let transcript = '';
      let stderr = '';
      let step = 0;
      const inputs = [
        { prompt: 'Allow file writes', input: '\n' },
        { prompt: 'Allow sandboxed commands', input: '\n' },
        {
          prompt: 'One-time pairing code (hidden): ',
          input: `${secret}${secretEditing}\n`,
        },
        // History and yank must not reveal secret editing state before redemption.
        {
          prompt: 'Pair this machine and save these choices?',
          input: '\x1b[A\x10\x19\x15n\n',
        },
      ];
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.stdout.on('data', chunk => {
        transcript += String(chunk);
        if (step < inputs.length && transcript.includes(inputs[step].prompt)) {
          child.stdin.write(inputs[step++].input);
        }
      });
      const [status] = await once(child, 'exit');
      assert.equal(step, inputs.length, stderr);
      assert.equal(status, 0, stderr);
      assert.ok(
        !transcript.includes(secret),
        'hidden pairing code was recalled visibly from history',
      );
      assert.match(transcript, /No pairing was redeemed/);
    },
  );
