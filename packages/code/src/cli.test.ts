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
    /LIBRECHAT_CODE_RUNTIME_SUPERVISOR must be endpoint, docker, or docker-macos-nsjail/,
  );
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
        LIBRECHAT_CODE_RUNTIME_SUPERVISOR: 'docker-macos-nsjail',
        LIBRECHAT_CODE_RUNTIME_IMAGE: 'example/runtime:latest',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE is required/);
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
  assert.match(result.stderr, /LIBRECHAT_CODE_DOCKER_PACKAGES_PATH is required/);
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
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stderr,
    /LIBRECHAT_CODE_(?:RUNTIME_IMAGE|DOCKER_SECCOMP_PROFILE|DOCKER_PACKAGES_PATH) is required/,
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
