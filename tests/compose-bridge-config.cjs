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
  },
]) {
  const config = render(overrides);
  for (const name of ['api', 'service-worker']) {
    const env = config.services[name].environment;
    assert.equal(env.CODEAPI_HARDENED_SANDBOX_MODE, 'true');
    assert.equal(env.CODEAPI_BRIDGE_AUTH_MODE, 'paired');
    assert.equal(env.CODEAPI_BRIDGE_TOKEN, token);
    assert.equal(env.CODEAPI_BRIDGE_DYNAMIC_WORKERS, overrides.CODEAPI_BRIDGE_DYNAMIC_WORKERS ?? 'true');
    assert.equal(env.CODEAPI_BRIDGE_WORKER_ID, overrides.CODEAPI_BRIDGE_WORKER_ID ?? '');
  }
  for (const name of ['egress_gateway', 'sandbox-runner']) {
    assert.equal(config.services[name].environment.CODEAPI_BRIDGE_TOKEN, undefined);
  }
}
assert.equal(render({}).services.api.environment.CODEAPI_BRIDGE_TOKEN, '');
console.log('Compose bridge configuration passed (dynamic/fixed pairing, no default secret).');
