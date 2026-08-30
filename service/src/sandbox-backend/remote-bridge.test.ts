import { describe, expect, test } from 'bun:test';

import type { SandboxExecuteContext, SandboxTransportRequest } from './types';
import type { RedisBridgeStore } from '../bridge/store';

import { BridgeStoreError } from '../bridge/store';
import { RemoteBridgeSandboxBackend } from './remote-bridge';

function request(): SandboxTransportRequest {
  return {
    body: { language: 'bash' } as never,
    headers: {},
  };
}

function context(): SandboxExecuteContext {
  return {
    executionId: 'execution-1',
    language: 'bash',
    isSynthetic: false,
    signal: new AbortController().signal,
    tenantId: 'tenant-1',
    bridgeWorkerId: 'user-vm',
    runtimeSessionMode: 'strict',
  };
}

describe('RemoteBridgeSandboxBackend', () => {
  test('dispatches a dynamically selected worker with a required tenant binding', async () => {
    let dispatched: Parameters<RedisBridgeStore['dispatch']>[0] | undefined;
    const store = {
      dispatch: async (
        args: Parameters<RedisBridgeStore['dispatch']>[0],
      ): ReturnType<RedisBridgeStore['dispatch']> => {
        dispatched = args;
        return {
          protocolVersion: 1 as const,
          generation: 1,
          leaseToken: 'a'.repeat(32),
          status: 'fulfilled' as const,
          result: {
            session_id: 'session-1',
            language: 'bash',
            version: '5.2.0',
            files: [],
          },
        };
      },
    } satisfies Pick<RedisBridgeStore, 'dispatch'>;
    const backend = new RemoteBridgeSandboxBackend(store, 'default-vm');

    await expect(backend.execute(request(), context())).resolves.toMatchObject({
      session_id: 'session-1',
    });
    expect(dispatched).toMatchObject({
      workerId: 'user-vm',
      tenantId: 'tenant-1',
      requireTenantBinding: true,
    });
  });

  test('maps tenant authorization rejection to a bridge backend error', async () => {
    const store = {
      dispatch: async (): ReturnType<RedisBridgeStore['dispatch']> => {
        throw new BridgeStoreError('WORKER_UNAUTHORIZED', 'private tenant detail');
      },
    } satisfies Pick<RedisBridgeStore, 'dispatch'>;
    const backend = new RemoteBridgeSandboxBackend(store, 'default-vm');

    await expect(backend.execute(request(), context())).rejects.toMatchObject({
      code: 'BRIDGE_WORKER_UNAUTHORIZED',
    });
  });
});
