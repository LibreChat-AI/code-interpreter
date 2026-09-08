import { describe, expect, test } from 'bun:test';

import type { SandboxBackendErrorCode, SandboxExecuteContext, SandboxTransportRequest } from './types';
import { SandboxBackendError } from './types';
import { publicExecutionFailure } from '../utils';
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
          incarnationId: 'incarnation-00000001',
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

  const failures = {
    WORKER_OFFLINE: ['BRIDGE_WORKER_OFFLINE', true, 503, 'Code environment is offline'],
    WORKER_UNAUTHORIZED: ['BRIDGE_WORKER_UNAUTHORIZED', false, 403, 'Code environment is not authorized for this tenant'],
    WORKER_BUSY: ['BRIDGE_WORKER_BUSY', false, 409, 'Code environment is busy'],
    WORKER_QUEUE_FULL: ['BRIDGE_WORKER_BUSY', false, 409, 'Code environment is busy'],
    ASSIGNMENT_EXPIRED: ['BRIDGE_DEADLINE_EXCEEDED', false, 504, 'Code environment execution timed out'],
    ASSIGNMENT_FENCED: ['BRIDGE_ASSIGNMENT_FENCED', false, 409, 'Code environment assignment is fenced; inspect the execution before retrying'],
    ASSIGNMENT_NOT_FOUND: ['BRIDGE_ASSIGNMENT_NOT_FOUND', false, 409, 'Code environment assignment is no longer available; inspect the execution before retrying'],
    WORKER_FENCED: ['BRIDGE_WORKER_FENCED', false, 409, 'Code environment worker changed during execution; inspect the execution before retrying'],
    WORKER_QUARANTINED: ['BRIDGE_WORKER_QUARANTINED', false, 409, 'Code environment is quarantined; recover the worker before retrying'],
    WORKSPACE_QUARANTINED: ['BRIDGE_WORKSPACE_QUARANTINED', false, 409, 'Code environment workspace is quarantined; reset the workspace before retrying'],
    WORKER_MISMATCH: ['BRIDGE_WORKER_MISMATCH', false, 409, 'Code environment does not support this execution; select a compatible worker'],
    ASSIGNMENT_INVALID: ['BRIDGE_ASSIGNMENT_INVALID', false, 400, 'Code environment assignment is invalid'],
    RESULT_INVALID: ['BRIDGE_RESULT_INVALID', false, 502, 'Code environment returned an invalid result'],
  } satisfies Record<BridgeStoreError['code'], [SandboxBackendErrorCode, boolean, number, string]>;

  for (const [storeCode, [code, transient, status, message]] of Object.entries(failures)) {
    test(`preserves ${storeCode} recovery through the backend and public response`, async () => {
      const cause = new BridgeStoreError(storeCode as BridgeStoreError['code'],
        'worker vm-private at redis.internal\nprivate tenant-secret');
      const store = {
        dispatch: async (): ReturnType<RedisBridgeStore['dispatch']> => { throw cause; },
      } satisfies Pick<RedisBridgeStore, 'dispatch'>;
      const backend = new RemoteBridgeSandboxBackend(store, 'default-vm');
      const error: unknown = await backend.execute(request(), context()).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(SandboxBackendError);
      if (!(error instanceof SandboxBackendError)) throw new Error('Expected backend failure');
      expect(error).toMatchObject({ code, transient, message: cause.message });
      expect(error.cause).toMatchObject({ message: cause.message });
      // The worker carries only the code/message through BullMQ, not transient.
      const failure = publicExecutionFailure(new Error(`${error.code}: ${error.message}`));
      expect(failure).toEqual({ status, body: { error: code.toLowerCase(), message } });
      expect(JSON.stringify(failure)).not.toContain('vm-private');
      expect(JSON.stringify(failure)).not.toContain('redis.internal');
      expect(JSON.stringify(failure)).not.toContain('tenant-secret');
    });
  }

  test('preserves failures that are not bridge store errors', async () => {
    const cause = new Error('result finalization failed');
    const backend = new RemoteBridgeSandboxBackend({
      dispatch: async (): ReturnType<RedisBridgeStore['dispatch']> => { throw cause; },
    }, 'default-vm');
    await expect(backend.execute(request(), context())).rejects.toBe(cause);
  });

  test('keeps a rejected settlement non-transient', async () => {
    const backend = new RemoteBridgeSandboxBackend({
      dispatch: async (): ReturnType<RedisBridgeStore['dispatch']> => ({
        protocolVersion: 1, generation: 1, leaseToken: 'a'.repeat(32),
        incarnationId: 'incarnation-00000001', status: 'rejected', error: 'sandbox rejected execution',
      }),
    }, 'default-vm');
    await expect(backend.execute(request(), context())).rejects.toMatchObject({
      code: 'BRIDGE_EXECUTION_FAILED', transient: false,
    });
  });

  test('keeps an explicitly selected singleton on its unbound compatibility route', async () => {
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
          incarnationId: 'incarnation-00000001',
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
    const backend = new RemoteBridgeSandboxBackend(
      store,
      'deployment-worker',
      false,
    );

    await backend.execute(request(), {
      ...context(),
      bridgeWorkerId: 'deployment-worker',
    });

    expect(dispatched).toMatchObject({
      workerId: 'deployment-worker',
      requireTenantBinding: false,
    });
  });

  test('requires a binding for the selected default worker in dynamic mode', async () => {
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
          incarnationId: 'incarnation-00000001',
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
    const backend = new RemoteBridgeSandboxBackend(
      store,
      'deployment-worker',
      true,
    );

    await backend.execute(request(), {
      ...context(),
      bridgeWorkerId: 'deployment-worker',
    });

    expect(dispatched).toMatchObject({
      workerId: 'deployment-worker',
      requireTenantBinding: true,
    });
  });
});
