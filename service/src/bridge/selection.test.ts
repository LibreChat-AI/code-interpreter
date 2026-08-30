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
    ).toEqual({ workerId: 'deployment-worker', dynamic: false });
  });

  test('selects a valid dynamic worker only when dynamic routing is enabled', () => {
    expect(
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: true,
        requestedWorkerId: 'code-user_1',
      }),
    ).toEqual({ workerId: 'code-user_1', dynamic: true });
  });

  test('rejects dynamic routing on the wrong backend or when it is disabled', () => {
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'http',
        configuredWorkerId: '',
        dynamicWorkers: true,
        requestedWorkerId: 'code-user-1',
      }),
    ).toThrow(BridgeWorkerSelectionError);
    expect(() =>
      resolveBridgeWorkerSelection({
        backend: 'remote-bridge',
        configuredWorkerId: 'deployment-worker',
        dynamicWorkers: false,
        requestedWorkerId: 'code-user-1',
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
      }),
    ).toThrow('Invalid code bridge worker ID');
  });
});
