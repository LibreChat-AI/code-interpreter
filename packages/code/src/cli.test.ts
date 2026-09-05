import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('CLI rejects an invalid worker ID before entering the run loop', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering/vm',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_WORKER_ID must match the bridge worker ID format/,
  );
});

test('CLI rejects invalid advertised capabilities before registration', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_SANDBOX_PROFILE: '',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_SANDBOX_PROFILE or LIBRECHAT_CODE_RUNTIMES is invalid/,
  );
});

test('CLI rejects an unknown runtime supervisor before entering the run loop', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'podman',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_RUNTIME_SUPERVISOR must be endpoint, docker, docker-nsjail, or docker-macos-nsjail/,
  );
});

test('CLI rejects an unknown command sandbox before entering the run loop', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_COMMAND_SANDBOX: 'host-shell',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_COMMAND_SANDBOX must be native-srt or runtime/,
  );
});

test('CLI rejects incomplete GitHub App authentication before worker registration', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_GITHUB_APP_ID: '123',
        LIBRECHAT_CODE_GITHUB_INSTALLATION_ID: undefined,
        LIBRECHAT_CODE_GITHUB_PRIVATE_KEY_FILE: undefined,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub App authentication requires/);
});

test('CLI refuses GitHub credentials without native sandboxed commands', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_GITHUB_TOKEN: 'github_pat_abcdefghijklmnopqrstuvwxyz',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /GitHub authentication requires workspace commands/,
  );
});

test('CLI rejects a GitHub App API URL that does not match its Git host', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_GITHUB_APP_ID: '123',
        LIBRECHAT_CODE_GITHUB_INSTALLATION_ID: '456',
        LIBRECHAT_CODE_GITHUB_PRIVATE_KEY_FILE: '/does/not/matter',
        LIBRECHAT_CODE_GITHUB_HOST: 'github.example.test',
        LIBRECHAT_CODE_GITHUB_API_URL: 'https://other.example.test/api/v3',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_GITHUB_HOST must match the GitHub App API hostname/,
  );
});

test('CLI validates GitHub App credentials before worker registration', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_WORKER_DIR: process.cwd(),
        LIBRECHAT_CODE_ALLOW_WORKSPACE_COMMANDS: 'true',
        LIBRECHAT_CODE_GITHUB_APP_ID: '123',
        LIBRECHAT_CODE_GITHUB_INSTALLATION_ID: '456',
        LIBRECHAT_CODE_GITHUB_PRIVATE_KEY_FILE: '/does/not/exist/app.pem',
        LIBRECHAT_CODE_GITHUB_HOST: undefined,
        LIBRECHAT_CODE_GITHUB_API_URL: undefined,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|no such file/i);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test('CLI requires a runtime image for Docker supervision', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIBRECHAT_CODE_RUNTIME_IMAGE is required/);
});

test('CLI requires the macOS NsJail seccomp profile', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: 'example/runtime:latest',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE is required/,
  );
});

test('CLI requires a package mount for the macOS NsJail profile', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-macos-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: 'example/runtime:latest',
        LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE: './seccomp/nsjail.json',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_DOCKER_PACKAGES_PATH is required/,
  );
});

test('CLI reset does not require Docker runtime launch inputs', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'reset-workspace',
      'runtime-session-1',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-macos-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: undefined,
        LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE: undefined,
        LIBRECHAT_CODE_DOCKER_PACKAGES_PATH: undefined,
        LIBRECHAT_CODE_GITHUB_TOKEN: 'github_pat_abcdefghijklmnopqrstuvwxyz',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stderr,
    /LIBRECHAT_CODE_(?:RUNTIME_IMAGE|DOCKER_SECCOMP_PROFILE|DOCKER_PACKAGES_PATH) is required/,
  );
  assert.doesNotMatch(
    result.stderr,
    /GitHub authentication requires workspace commands/,
  );
});

test('CLI relay requires a fixed upstream URL', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url)), 'relay'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_FILE_RELAY_UPSTREAM: undefined,
        LIBRECHAT_CODE_FILE_RELAY_TOKEN: 'relay-secret',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIBRECHAT_CODE_FILE_RELAY_UPSTREAM is required/);
});

test('CLI requires manifest verification before enabling the file relay', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'https://code.example/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-macos-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: 'example/runtime:latest',
        LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE: '../../seccomp/nsjail.json',
        LIBRECHAT_CODE_DOCKER_PACKAGES_PATH: '.',
        LIBRECHAT_CODE_FILE_RELAY_UPSTREAM: 'https://code.example/egress',
        LIBRECHAT_CODE_EXECUTION_MANIFEST_PUBLIC_KEY: undefined,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LIBRECHAT_CODE_EXECUTION_MANIFEST_PUBLIC_KEY is required/,
  );
});

test('CLI treats a whitespace-only file relay upstream as disabled', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 500,
      env: {
        ...process.env,
        LIBRECHAT_CODE_URL: 'http://127.0.0.1:1/v1',
        LIBRECHAT_CODE_WORKER_TOKEN: 'worker-secret',
        LIBRECHAT_CODE_WORKER_ID: 'engineering-vm',
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-macos-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: 'example/runtime:latest',
        LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE: '../../seccomp/nsjail.json',
        LIBRECHAT_CODE_DOCKER_PACKAGES_PATH: '.',
        LIBRECHAT_CODE_FILE_RELAY_UPSTREAM: '   ',
        LIBRECHAT_CODE_EXECUTION_MANIFEST_PUBLIC_KEY: undefined,
        LIBRECHAT_CODE_FILE_RELAY_IMAGE: undefined,
      },
    },
  );

  assert.doesNotMatch(
    result.stderr,
    /LIBRECHAT_CODE_(?:EXECUTION_MANIFEST_PUBLIC_KEY|FILE_RELAY_IMAGE) is required/,
  );
});
