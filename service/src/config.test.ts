import { describe, expect, test } from 'bun:test';
import {
  parsePlanLimits,
  resolvePositiveIntEnv,
  resolveRuntimeSessionMode,
  resolveSandboxBackend,
} from './config';

describe('sandbox execution configuration', () => {
  test('defaults only unset backend and session mode values', () => {
    expect(resolveSandboxBackend(undefined)).toBe('http');
    expect(resolveRuntimeSessionMode(undefined)).toBe('stateless');
  });

  test('accepts every supported backend and session mode', () => {
    expect(resolveSandboxBackend('http')).toBe('http');
    expect(resolveSandboxBackend('lambda-microvm')).toBe('lambda-microvm');
    expect(resolveRuntimeSessionMode('stateless')).toBe('stateless');
    expect(resolveRuntimeSessionMode('affinity')).toBe('affinity');
    expect(resolveRuntimeSessionMode('strict')).toBe('strict');
  });

  test('rejects unknown values instead of silently changing execution semantics', () => {
    expect(() => resolveSandboxBackend('lambda_microvm')).toThrow(
      'CODEAPI_SANDBOX_BACKEND must be one of: http, lambda-microvm',
    );
    expect(() => resolveSandboxBackend('')).toThrow('CODEAPI_SANDBOX_BACKEND');
    expect(() => resolveSandboxBackend(' ')).toThrow('CODEAPI_SANDBOX_BACKEND');
    expect(() => resolveRuntimeSessionMode('stateful')).toThrow(
      'CODEAPI_RUNTIME_SESSION_MODE must be one of: stateless, affinity, strict',
    );
    expect(() => resolveRuntimeSessionMode('')).toThrow('CODEAPI_RUNTIME_SESSION_MODE');
    expect(() => resolveRuntimeSessionMode(' ')).toThrow('CODEAPI_RUNTIME_SESSION_MODE');
  });
});

describe('resolvePositiveIntEnv', () => {
  test('falls back to the default when unset or blank', () => {
    expect(resolvePositiveIntEnv(undefined, 42)).toBe(42);
    expect(resolvePositiveIntEnv('', 42)).toBe(42);
    expect(resolvePositiveIntEnv('   ', 42)).toBe(42);
  });

  test('accepts positive finite values and floors them', () => {
    expect(resolvePositiveIntEnv('100', 42)).toBe(100);
    expect(resolvePositiveIntEnv('100.9', 42)).toBe(100);
  });

  test('falls back to the default for zero, negative, non-finite, or non-numeric values', () => {
    expect(resolvePositiveIntEnv('0', 42)).toBe(42);
    expect(resolvePositiveIntEnv('-5', 42)).toBe(42);
    expect(resolvePositiveIntEnv('Infinity', 42)).toBe(42);
    expect(resolvePositiveIntEnv('-Infinity', 42)).toBe(42);
    expect(resolvePositiveIntEnv('NaN', 42)).toBe(42);
    expect(resolvePositiveIntEnv('not-a-number', 42)).toBe(42);
  });

  test('falls back to the default when flooring would collapse a fraction to zero', () => {
    expect(resolvePositiveIntEnv('0.5', 42)).toBe(42);
    expect(resolvePositiveIntEnv('0.9', 42)).toBe(42);
  });
});

describe('parsePlanLimits', () => {
  test('returns an empty catalog when unset or blank', () => {
    expect(parsePlanLimits(undefined)).toEqual({});
    expect(parsePlanLimits('')).toEqual({});
    expect(parsePlanLimits('   ')).toEqual({});
  });

  test('parses a plan catalog keyed by plan id', () => {
    expect(
      parsePlanLimits('{"plan_a":{"run_memory_limit":1048576,"max_file_size":2048}}'),
    ).toEqual({
      plan_a: { run_memory_limit: 1048576, max_file_size: 2048 },
    });
  });

  test('rejects malformed catalogs', () => {
    expect(() => parsePlanLimits('{nope')).toThrow('not valid JSON');
    expect(() => parsePlanLimits('[1]')).toThrow('JSON object');
    expect(() => parsePlanLimits('"plan_a"')).toThrow('JSON object');
    expect(() => parsePlanLimits('null')).toThrow('JSON object');
  });
});
