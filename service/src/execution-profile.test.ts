import { describe, expect, test } from 'bun:test';
import {
  checkExecutionProfileExpectation,
  queueNamesForExecutionProfile,
  resolveExecutionProfile,
  resolveExecutionProfileSource,
  resolveQueuedSandboxBackend,
  validateQueuedSandboxBackend,
  validateQueuedExecutionProfile,
} from './execution-profile';

describe('execution profile resolution', () => {
  test('preserves the HTTP/stateless default when unset', () => {
    expect(resolveExecutionProfile(undefined, 'stateless')).toBe('default');
  });

  test('recognizes an existing stateful deployment when unset', () => {
    expect(resolveExecutionProfile(undefined, 'affinity')).toBe('stateful');
    expect(resolveExecutionProfile(undefined, 'strict')).toBe('stateful');
  });

  test('lets API-only pods infer stateful from session mode without worker config', () => {
    expect(resolveExecutionProfile(undefined, 'affinity')).toBe('stateful');
  });

  test('accepts only the two public execution profiles', () => {
    expect(resolveExecutionProfile('default', 'stateless')).toBe('default');
    expect(resolveExecutionProfile('stateful', 'affinity')).toBe('stateful');
    expect(() => resolveExecutionProfile('lambda', 'affinity')).toThrow(
      'CODEAPI_EXECUTION_PROFILE must be one of: default, stateful',
    );
    expect(resolveExecutionProfile('', 'stateless')).toBe('default');
    expect(resolveExecutionProfile('   ', 'affinity')).toBe('stateful');
    expect(resolveExecutionProfileSource('')).toBe('inferred');
    expect(resolveExecutionProfileSource('stateful')).toBe('explicit');
  });
});

describe('execution profile queue isolation', () => {
  test('keeps the legacy queue names for the default profile', () => {
    expect(queueNamesForExecutionProfile('default', 'explicit')).toEqual({
      python: 'python-queue',
      other: 'other-queue',
    });
  });

  test('keeps inferred stateful deployments on legacy queues during binary rollout', () => {
    expect(queueNamesForExecutionProfile('stateful', 'inferred')).toEqual({
      python: 'python-queue',
      other: 'other-queue',
    });
  });

  test('uses separate queues only for an explicit stateful deployment', () => {
    expect(queueNamesForExecutionProfile('stateful', 'explicit')).toEqual({
      python: 'stateful-python-queue',
      other: 'stateful-other-queue',
    });
  });

  test('isolates outbound bridge jobs from Lambda consumers', () => {
    expect(
      queueNamesForExecutionProfile('stateful', 'explicit', 'remote-bridge'),
    ).toEqual({
      python: 'remote-bridge-python-queue',
      other: 'remote-bridge-other-queue',
    });
    expect(
      queueNamesForExecutionProfile('stateful', 'explicit', 'lambda-microvm'),
    ).toEqual({
      python: 'stateful-python-queue',
      other: 'stateful-other-queue',
    });
  });

  test('labels API-only stateful jobs with their Lambda worker backend', () => {
    expect(resolveQueuedSandboxBackend('stateful', 'http')).toBe('lambda-microvm');
    expect(resolveQueuedSandboxBackend('default', 'http', 'explicit')).toBe('http');
    expect(resolveQueuedSandboxBackend('stateful', 'remote-bridge')).toBe('remote-bridge');
  });

  test('leaves the backend unfenced for inferred stateless legacy queues', () => {
    expect(resolveQueuedSandboxBackend('default', 'http', 'inferred')).toBeUndefined();
  });
});

describe('execution profile request assertion', () => {
  test('allows callers that omit the assertion for backwards compatibility', () => {
    expect(checkExecutionProfileExpectation(undefined, 'default')).toEqual({ ok: true });
  });

  test('allows a matching expected profile', () => {
    expect(checkExecutionProfileExpectation('stateful', 'stateful')).toEqual({ ok: true });
  });

  test('returns a typed conflict before a mismatched request can be routed', () => {
    expect(checkExecutionProfileExpectation('stateful', 'default')).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'execution_profile_mismatch',
        message: 'Expected the stateful execution profile, but reached default',
        expected_profile: 'stateful',
        actual_profile: 'default',
      },
    });
  });

  test('rejects invalid profile names instead of treating them as mismatches', () => {
    expect(checkExecutionProfileExpectation('aws', 'default')).toMatchObject({
      ok: false,
      status: 400,
      body: {
        error: 'invalid_execution_profile',
        expected_profile: 'aws',
        actual_profile: 'default',
      },
    });
  });
});

describe('queued execution profile validation', () => {
  test('accepts matching and legacy jobs', () => {
    expect(() => validateQueuedExecutionProfile('stateful', 'stateful')).not.toThrow();
    expect(() => validateQueuedExecutionProfile(undefined, 'default')).not.toThrow();
  });

  test('rejects invalid and cross-profile jobs', () => {
    expect(() => validateQueuedExecutionProfile('invalid', 'default')).toThrow(
      'Queued job has invalid execution profile',
    );
    expect(() => validateQueuedExecutionProfile('stateful', 'default')).toThrow(
      'Queued job targets the stateful execution profile, but worker serves default',
    );
  });
});

describe('queued sandbox backend validation', () => {
  test('accepts matching and legacy jobs', () => {
    expect(() =>
      validateQueuedSandboxBackend('remote-bridge', 'remote-bridge'),
    ).not.toThrow();
    expect(() => validateQueuedSandboxBackend(undefined, 'http')).not.toThrow();
    expect(() =>
      validateQueuedSandboxBackend(undefined, 'remote-bridge', 'legacy-bridge-worker'),
    ).not.toThrow();
  });

  test('rejects invalid and cross-backend jobs', () => {
    expect(() => validateQueuedSandboxBackend('invalid', 'http')).toThrow(
      'Queued job has invalid sandbox backend',
    );
    expect(() =>
      validateQueuedSandboxBackend('remote-bridge', 'lambda-microvm'),
    ).toThrow(
      'Queued job targets the remote-bridge sandbox backend, but worker serves lambda-microvm',
    );
    expect(() =>
      validateQueuedSandboxBackend(undefined, 'lambda-microvm', 'legacy-bridge-worker'),
    ).toThrow('Legacy queued bridge job cannot run on the lambda-microvm sandbox backend');
  });
});
