import { afterEach, beforeEach, expect, test } from 'bun:test';
import { env, gracefulShutdownTimeoutMs } from './config';

const original = {
  JOB_TIMEOUT: env.JOB_TIMEOUT,
  LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
  EGRESS_GATEWAY_REVOKE_TIMEOUT_MS: env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
  HOSTED_APPS_ENABLED: env.HOSTED_APPS_ENABLED,
  CHECKPOINT_TIMEOUT_MS: env.CHECKPOINT_TIMEOUT_MS,
};
const originalOverride = process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS;

beforeEach(() => {
  Object.assign(env, {
    JOB_TIMEOUT: 300_000,
    LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: 60_000,
    EGRESS_GATEWAY_REVOKE_TIMEOUT_MS: 5_000,
    HOSTED_APPS_ENABLED: false,
    CHECKPOINT_TIMEOUT_MS: 60_000,
  });
  delete process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS;
});

afterEach(() => {
  Object.assign(env, original);
  if (originalOverride === undefined) delete process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS;
  else process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS = originalOverride;
});

test('workers can finish a five-minute job and cleanup while API-only shutdown stays bounded', () => {
  expect(gracefulShutdownTimeoutMs(true)).toBe(370_000);
  expect(gracefulShutdownTimeoutMs(false)).toBe(30_000);
});

test('worker shutdown follows configured execution and cleanup deadlines', () => {
  env.JOB_TIMEOUT = 1_200_000;
  env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS = 90_000;
  env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS = 20_000;
  expect(gracefulShutdownTimeoutMs(true)).toBe(1_315_000);
});

test('hosted-app workers retain their longer operation budget', () => {
  env.HOSTED_APPS_ENABLED = true;
  expect(gracefulShutdownTimeoutMs(true)).toBe(1_110_000);
  env.JOB_TIMEOUT = 1_200_000;
  expect(gracefulShutdownTimeoutMs(true)).toBe(1_270_000);
  expect(gracefulShutdownTimeoutMs(false)).toBe(30_000);
});

test('explicit shutdown overrides remain finite and invalid values use the default', () => {
  process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS = '420000';
  expect(gracefulShutdownTimeoutMs(true)).toBe(420_000);
  expect(gracefulShutdownTimeoutMs(false)).toBe(420_000);
  for (const invalid of ['', ' ', '0', '-1', 'NaN', 'Infinity']) {
    process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS = invalid;
    expect(gracefulShutdownTimeoutMs(true)).toBe(370_000);
  }
  process.env.CODEAPI_SHUTDOWN_TIMEOUT_MS = '2147483648';
  expect(gracefulShutdownTimeoutMs(true)).toBe(2_147_483_647);
});
