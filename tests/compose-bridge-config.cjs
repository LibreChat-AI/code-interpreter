const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function render(overrides) {
  return JSON.parse(execFileSync('docker', [
    'compose', '--env-file', '/dev/null', '-f', 'docker-compose.yaml',
    'config', '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEAPI_HARDENED_SANDBOX_MODE: '',
      CODEAPI_BRIDGE_AUTH_MODE: '',
      CODEAPI_BRIDGE_DYNAMIC_WORKERS: '',
      CODEAPI_BRIDGE_WORKER_ID: '',
      CODEAPI_BRIDGE_TOKEN: '',
      CODEAPI_BRIDGE_MAX_WORKSPACE_LEASE_SLOTS: '',
      CODEAPI_BRIDGE_LANE_GIT: '',
      CODEAPI_BRIDGE_IMPORT_FILE_MAX_BYTES: '',
      CODEAPI_BRIDGE_RECOVERY_SERVER_ID: '',
      CODEAPI_BRIDGE_ENROLLMENT_TTL_SECONDS: '',
      CODEAPI_BRIDGE_RECOVERY_CHALLENGE_TTL_SECONDS: '',
      CODEAPI_BRIDGE_RECOVERY_MAX_CHALLENGES_PER_MINUTE: '',
      CODEAPI_BRIDGE_RECOVERY_MAX_ATTEMPTS_PER_MINUTE: '',
      CODEAPI_BRIDGE_RECOVERY_MAX_UNTRUSTED_PER_MINUTE: '',
      SANDBOX_RUN_TIMEOUT: '',
      SANDBOX_RUN_CPU_TIME: '',
      SANDBOX_OUTPUT_MAX_SIZE: '',
      JOB_TIMEOUT: '',
      MAX_FILE_SIZE: '',
      ...overrides,
    },
  }));
}

const token = 'compose-test-token-never-use-in-production';
for (const overrides of [
  { CODEAPI_BRIDGE_TOKEN: token },
  {
    CODEAPI_BRIDGE_TOKEN: token,
    CODEAPI_BRIDGE_DYNAMIC_WORKERS: 'false',
    CODEAPI_BRIDGE_WORKER_ID: 'test-worker',
    CODEAPI_BRIDGE_MAX_WORKSPACE_LEASE_SLOTS: '4',
    CODEAPI_BRIDGE_LANE_GIT: 'true',
    CODEAPI_BRIDGE_IMPORT_FILE_MAX_BYTES: '1048576',
    CODEAPI_BRIDGE_RECOVERY_SERVER_ID: 'https://code.example.test',
    CODEAPI_BRIDGE_ENROLLMENT_TTL_SECONDS: '86400',
    CODEAPI_BRIDGE_RECOVERY_CHALLENGE_TTL_SECONDS: '90',
    CODEAPI_BRIDGE_RECOVERY_MAX_CHALLENGES_PER_MINUTE: '8',
    CODEAPI_BRIDGE_RECOVERY_MAX_ATTEMPTS_PER_MINUTE: '16',
    CODEAPI_BRIDGE_RECOVERY_MAX_UNTRUSTED_PER_MINUTE: '400',
  },
]) {
  const config = render(overrides);
  for (const name of ['api', 'service-worker']) {
    const env = config.services[name].environment;
    assert.equal(env.CODEAPI_HARDENED_SANDBOX_MODE, 'true');
    assert.equal(env.CODEAPI_BRIDGE_AUTH_MODE, 'paired');
    assert.equal(env.CODEAPI_BRIDGE_TOKEN, token);
    assert.equal(env.CODEAPI_BRIDGE_MAX_WORKSPACE_LEASE_SLOTS, overrides.CODEAPI_BRIDGE_MAX_WORKSPACE_LEASE_SLOTS ?? '1');
    assert.equal(env.CODEAPI_BRIDGE_LANE_GIT, overrides.CODEAPI_BRIDGE_LANE_GIT ?? 'false');
    assert.equal(env.CODEAPI_BRIDGE_DYNAMIC_WORKERS, overrides.CODEAPI_BRIDGE_DYNAMIC_WORKERS ?? 'true');
    assert.equal(env.CODEAPI_BRIDGE_WORKER_ID, overrides.CODEAPI_BRIDGE_WORKER_ID ?? '');
    assert.equal(env.CODEAPI_BRIDGE_RECOVERY_SERVER_ID, overrides.CODEAPI_BRIDGE_RECOVERY_SERVER_ID ?? '');
    assert.equal(env.CODEAPI_BRIDGE_ENROLLMENT_TTL_SECONDS, overrides.CODEAPI_BRIDGE_ENROLLMENT_TTL_SECONDS ?? '0');
    assert.equal(env.CODEAPI_BRIDGE_RECOVERY_CHALLENGE_TTL_SECONDS, overrides.CODEAPI_BRIDGE_RECOVERY_CHALLENGE_TTL_SECONDS ?? '60');
    assert.equal(env.CODEAPI_BRIDGE_RECOVERY_MAX_CHALLENGES_PER_MINUTE, overrides.CODEAPI_BRIDGE_RECOVERY_MAX_CHALLENGES_PER_MINUTE ?? '12');
    assert.equal(env.CODEAPI_BRIDGE_RECOVERY_MAX_ATTEMPTS_PER_MINUTE, overrides.CODEAPI_BRIDGE_RECOVERY_MAX_ATTEMPTS_PER_MINUTE ?? '30');
    assert.equal(env.CODEAPI_BRIDGE_RECOVERY_MAX_UNTRUSTED_PER_MINUTE, overrides.CODEAPI_BRIDGE_RECOVERY_MAX_UNTRUSTED_PER_MINUTE ?? '240');
  }
  assert.equal(
    config.services.api.environment.CODEAPI_BRIDGE_IMPORT_FILE_MAX_BYTES,
    overrides.CODEAPI_BRIDGE_IMPORT_FILE_MAX_BYTES ?? '104857600',
  );
  for (const name of ['egress_gateway', 'sandbox-runner']) {
    assert.equal(config.services[name].environment.CODEAPI_BRIDGE_TOKEN, undefined);
    assert.equal(config.services[name].environment.CODEAPI_BRIDGE_RECOVERY_SERVER_ID, undefined);
    assert.equal(config.services[name].environment.CODEAPI_BRIDGE_RECOVERY_MAX_UNTRUSTED_PER_MINUTE, undefined);
  }
  assert.match(JSON.stringify(config.services.redis.command), /--appendonly.*yes/);
  assert.ok(config.services.redis.volumes.some(volume => volume.target === '/data' && volume.type === 'volume'));
}
assert.equal(render({}).services.api.environment.CODEAPI_BRIDGE_TOKEN, '');

const limitServices = {
  SANDBOX_RUN_TIMEOUT: ['sandbox-runner'],
  SANDBOX_RUN_CPU_TIME: ['sandbox-runner'],
  SANDBOX_OUTPUT_MAX_SIZE: ['sandbox-runner'],
  JOB_TIMEOUT: ['api', 'service-worker', 'egress_gateway'],
  MAX_FILE_SIZE: ['api'],
};
const limitDefaults = {
  SANDBOX_RUN_TIMEOUT: '300000',
  SANDBOX_RUN_CPU_TIME: '300000',
  SANDBOX_OUTPUT_MAX_SIZE: '65536',
  JOB_TIMEOUT: '300000',
  MAX_FILE_SIZE: '26214400',
};
const limitOverrides = {
  SANDBOX_RUN_TIMEOUT: '600000',
  SANDBOX_RUN_CPU_TIME: '600000',
  SANDBOX_OUTPUT_MAX_SIZE: '16384',
  JOB_TIMEOUT: '615000',
  MAX_FILE_SIZE: '104857600',
};
for (const [overrides, expected] of [[{}, limitDefaults], [limitOverrides, limitOverrides]]) {
  const config = render(overrides);
  for (const [name, services] of Object.entries(limitServices)) {
    for (const service of services) {
      assert.equal(config.services[service].environment[name], expected[name], `${service} ${name}`);
    }
  }
}
console.log('Compose bridge configuration passed (pairing, opt-in recovery, durable Redis, execution limits).');
