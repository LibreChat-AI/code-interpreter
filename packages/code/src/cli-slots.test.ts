import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
