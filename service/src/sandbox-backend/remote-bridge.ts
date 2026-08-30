import type {
  SandboxBackend,
  SandboxExecuteContext,
  SandboxRawResponse,
  SandboxTransportRequest,
} from './types';
import type { RedisBridgeStore } from '../bridge/store';

import { env } from '../config';
import { bridgeStore } from '../bridge';
import { BridgeStoreError } from '../bridge/store';
import { SandboxBackendError } from './types';

export class RemoteBridgeSandboxBackend implements SandboxBackend {
  readonly name = 'remote-bridge' as const;

  constructor(
    private readonly store: Pick<RedisBridgeStore, 'dispatch'> = bridgeStore,
    private readonly workerId: string = env.BRIDGE_WORKER_ID,
  ) {}

  async execute(
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    const workerId = ctx.bridgeWorkerId ?? this.workerId;
    if (workerId.length === 0) {
      throw new SandboxBackendError(
        'BRIDGE_WORKER_OFFLINE',
        'No bridge worker is configured',
      );
    }
    const sessionResultFinalizer = ctx.sessionResultFinalizer;
    try {
      const settlement = await this.store.dispatch({
        workerId,
        tenantId: ctx.tenantId,
        requireTenantBinding:
          ctx.bridgeWorkerId != null && ctx.bridgeWorkerId !== this.workerId,
        body: req.body,
        headers: req.headers,
        runtimeSessionId: ctx.runtimeSessionId,
        deadlineAtMs: ctx.deadlineAtMs ?? Date.now() + env.JOB_TIMEOUT,
        signal: ctx.signal,
        finalize: sessionResultFinalizer
          ? async (settlement) => {
              if (settlement.status === 'rejected') return settlement;
              return {
                ...settlement,
                result: await sessionResultFinalizer(settlement.result),
              };
            }
          : undefined,
      });
      if (settlement.status === 'rejected') {
        throw new SandboxBackendError(
          'BRIDGE_EXECUTION_FAILED',
          settlement.error,
        );
      }
      return settlement.result as SandboxRawResponse;
    } catch (error) {
      if (!(error instanceof BridgeStoreError)) throw error;
      if (error.code === 'WORKER_UNAUTHORIZED') {
        throw new SandboxBackendError(
          'BRIDGE_WORKER_UNAUTHORIZED',
          error.message,
          error,
        );
      }
      if (error.code === 'WORKER_BUSY') {
        throw new SandboxBackendError(
          'BRIDGE_WORKER_BUSY',
          error.message,
          error,
        );
      }
      if (error.code === 'ASSIGNMENT_EXPIRED') {
        throw new SandboxBackendError(
          'BRIDGE_DEADLINE_EXCEEDED',
          error.message,
          error,
        );
      }
      throw new SandboxBackendError(
        'BRIDGE_WORKER_OFFLINE',
        error.message,
        error,
        true,
      );
    }
  }
}
