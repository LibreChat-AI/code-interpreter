import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
