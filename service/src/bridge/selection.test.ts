import { describe, expect, test } from 'bun:test';

import {
  BridgeWorkerSelectionError,
  resolveBridgeWorkerSelection,
} from './selection';

describe('bridge worker request selection', () => {
  test('uses the configured compatibility worker when no dynamic worker is requested', () => {
    expect(
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
      }),
    ).toEqual({ workerId: 'deployment-worker', explicit: false });
  });

  test('selects only the worker authenticated by the LibreChat JWT', () => {
    expect(
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
        requestedWorkerId: 'code-user_1',
        trustedWorkerId: 'code-user_1',
      }),
    ).toEqual({ workerId: 'code-user_1', explicit: true });

    expect(
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
        trustedWorkerId: 'code-user_1',
      }),
    ).toEqual({ workerId: 'code-user_1', explicit: true });
  });

  test('rejects a caller-controlled worker header without a matching trusted claim', () => {
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
        requestedWorkerId: 'victim-worker',
      }),
    ).toThrow('Code bridge worker selection is not authenticated');
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
        requestedWorkerId: 'victim-worker',
        trustedWorkerId: 'caller-worker',
      }),
    ).toThrow('Code bridge worker selection does not match the authenticated claim');
  });

  test('rejects dynamic routing on the wrong backend or when it is disabled', () => {
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'http',
        configuredWorkerId: '',
        dynamicWorkers: true,
        requestedWorkerId: 'code-user-1',
        trustedWorkerId: 'code-user-1',
      }),
    ).toThrow(BridgeWorkerSelectionError);
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: false,
        requestedWorkerId: 'code-user-1',
        trustedWorkerId: 'code-user-1',
      }),
    ).toThrow('Dynamic code bridge workers are disabled');
  });

  test('rejects malformed worker IDs before they cross the queue boundary', () => {
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: '',
        dynamicWorkers: true,
        requestedWorkerId: '../worker',
        trustedWorkerId: '../worker',
      }),
    ).toThrow('Invalid code bridge worker ID');
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: '',
        dynamicWorkers: true,
        requestedWorkerId: 'victim:assignments',
        trustedWorkerId: 'victim:assignments',
      }),
    ).toThrow('Invalid code bridge worker ID');
  });
});
