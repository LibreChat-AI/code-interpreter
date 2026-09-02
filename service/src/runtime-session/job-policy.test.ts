import { describe, expect, test } from 'bun:test';
import {
  PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
  resolveRuntimeSessionForJob,
} from './job-policy';

const LAMBDA_WORKER = {
  workerBackend: 'lambda-microvm',
} as const;

describe('resolveRuntimeSessionForJob', () => {
  test('keeps explicitly exempt programmatic jobs stateless in strict mode', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      runtimeSessionMode: 'stateless',
      runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
      isSynthetic: false,
    })).toEqual({ runtimeSessionMode: 'stateless' });
  });

  test('the programmatic exemption wins over an accidentally supplied session id', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'affinity',
      runtimeSessionId: 'rt_should_not_be_used',
      runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
      isSynthetic: false,
    })).toEqual({ runtimeSessionMode: 'stateless' });
  });

  test('synthetic jobs retain their existing strict-mode exemption', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      runtimeSessionMode: 'strict',
      runtimeSessionId: 'rt_ignored_probe',
      isSynthetic: true,
    })).toEqual({ runtimeSessionMode: 'stateless' });
  });

  test('preserves stateful producer semantics across affinity and strict workers', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      runtimeSessionMode: 'affinity',
      runtimeSessionId: 'rt_affinity',
      isSynthetic: false,
    })).toEqual({
      runtimeSessionId: 'rt_affinity',
      runtimeSessionMode: 'affinity',
    });
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'strict',
      runtimeSessionId: 'rt_strict',
      isSynthetic: false,
    })).toEqual({
      runtimeSessionId: 'rt_strict',
      runtimeSessionMode: 'strict',
    });
  });

  test('preserves an intentional stateless fallback on a strict worker', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      runtimeSessionMode: 'stateless',
      isSynthetic: false,
    })).toEqual({ runtimeSessionMode: 'stateless' });
  });

  test('fails closed when a stateless worker receives a stateful job', () => {
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'stateless',
      runtimeSessionMode: 'affinity',
      runtimeSessionId: 'rt_must_persist',
      isSynthetic: false,
    })).toThrow('lambda-microvm/stateless worker cannot honor queued affinity runtime session');
  });

  test('fails closed when an HTTP worker receives a stateful job', () => {
    expect(() => resolveRuntimeSessionForJob({
      workerBackend: 'http',
      workerMode: 'affinity',
      runtimeSessionMode: 'affinity',
      runtimeSessionId: 'rt_must_persist',
      isSynthetic: false,
    })).toThrow('http/affinity worker cannot honor queued affinity runtime session');
  });

  test('allows a remote bridge worker to honor a stateful job', () => {
    expect(resolveRuntimeSessionForJob({
      workerBackend: 'remote-bridge',
      workerMode: 'strict',
      runtimeSessionMode: 'strict',
      runtimeSessionId: 'rt_attached',
      isSynthetic: false,
    })).toEqual({
      runtimeSessionId: 'rt_attached',
      runtimeSessionMode: 'strict',
    });
  });

  test('rejects contradictory or invalid producer decisions', () => {
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'strict',
      isSynthetic: false,
    })).toThrow('strict queued job requires a runtimeSessionId');
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'stateless',
      runtimeSessionId: 'rt_contradiction',
      isSynthetic: false,
    })).toThrow('stateless queued job must not carry a runtimeSessionId');
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'stateful',
      isSynthetic: false,
    })).toThrow('queued runtimeSessionMode must be one of');
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'affinity',
      runtimeSessionMode: 'affinity',
      runtimeSessionId: '',
      isSynthetic: false,
    })).toThrow('queued runtimeSessionId must be a non-empty string');
  });

  test('infers legacy queued jobs from the presence of a session id', () => {
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      runtimeSessionId: 'rt_legacy',
      isSynthetic: false,
    })).toEqual({
      runtimeSessionId: 'rt_legacy',
      runtimeSessionMode: 'affinity',
    });
    expect(resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'strict',
      isSynthetic: false,
    })).toEqual({ runtimeSessionMode: 'stateless' });
    expect(() => resolveRuntimeSessionForJob({
      ...LAMBDA_WORKER,
      workerMode: 'stateless',
      runtimeSessionId: 'rt_legacy',
      isSynthetic: false,
    })).toThrow('lambda-microvm/stateless worker cannot honor queued affinity runtime session');
  });
});
