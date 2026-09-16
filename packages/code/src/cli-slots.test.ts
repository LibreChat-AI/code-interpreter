import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI rejects aliased and overlapping workspace roots before connecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'byom-cli-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '..nested'));
  for (const extra of [root, join(root, '..nested')]) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'run',
        '--worker-dir',
        root,
        '--workspace',
        `second=${extra}`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          ...process.env,
          LIBRECHAT_CODE_URL: 'http://127.0.0.1:1',
          LIBRECHAT_CODE_WORKER_TOKEN: 'fixture',
          LIBRECHAT_CODE_WORKER_ID: 'fixture-worker',
          LIBRECHAT_CODE_COMMAND_SANDBOX: 'native-srt',
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not overlap or alias/);
  }
});

test('CLI bounds requested workspace slots before connecting', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--workspace-lease-slots',
      '9',
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'fixture',
        LIBRECHAT_CODE_WORKER_ID: 'fixture-worker',
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot exceed 8/);
});

test('CLI rejects one quarantine-file override for multiple roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'byom-cli-markers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'run',
      '--worker-dir',
      join(root, 'a'),
      '--workspace',
      `second=${join(root, 'b')}`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'fixture',
        LIBRECHAT_CODE_WORKER_ID: 'fixture-worker',
        LIBRECHAT_CODE_COMMAND_SANDBOX: 'native-srt',
        LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE: join(root, 'shared.json'),
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /single-root override/);
});

test('CLI preserves distinct case-sensitive roots on a non-Linux platform', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'byom-cli-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Foo'));
  await mkdir(join(root, 'foo'), { recursive: true });
  if (
    (await stat(join(root, 'Foo'))).ino === (await stat(join(root, 'foo'))).ino
  ) {
    t.skip('requires a case-sensitive test filesystem');
    return;
  }
  const argv = [
    'fixture',
    'run',
    '--worker-dir',
    join(root, 'Foo'),
    '--workspace',
    `second=${join(root, 'foo')}`,
    '--workspace-lease-slots',
    '2',
  ];
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `Object.defineProperty(process, 'platform', {value:'darwin'}); process.argv=[process.execPath,...${JSON.stringify(argv)}]; await import(${JSON.stringify(new URL('./cli.js', import.meta.url).href)});`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'fixture',
        LIBRECHAT_CODE_WORKER_ID: 'fixture-worker',
        LIBRECHAT_CODE_COMMAND_SANDBOX: 'native-srt',
        LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE: '',
      },
    },
  );
  assert.match(
    result.stderr,
    /Concurrent workspace leases require native-srt commands/,
  );
  assert.doesNotMatch(result.stderr, /overlap or alias/);
});
