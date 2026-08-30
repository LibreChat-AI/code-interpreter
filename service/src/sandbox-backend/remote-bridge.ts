import type {
  SandboxBackend,
  SandboxExecuteContext,
  SandboxRawResponse,
  SandboxTransportRequest,
} from './types';
import type { RedisBridgeStore } from '../bridge/store';

import { env } from '../config';
import { bridgeStore } from '../bridge/router';
import { BridgeStoreError } from '../bridge/store';
import { SandboxBackendError } from './types';

export class RemoteBridgeSandboxBackend implements SandboxBackend {
  readonly name = 'remote-bridge' as const;

  constructor(
    private readonly store: RedisBridgeStore = bridgeStore,
    private readonly workerId: string = env.BRIDGE_WORKER_ID,
  ) {}

  async execute(
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    if (!this.workerId) {
      throw new SandboxBackendError(
        'BRIDGE_WORKER_OFFLINE',
        'No bridge worker is configured',
      );
    }
    try {
      const settlement = await this.store.dispatch({
        workerId: this.workerId,
        body: req.body,
        headers: req.headers,
        runtimeSessionId: ctx.runtimeSessionId,
        deadlineAtMs: ctx.deadlineAtMs ?? Date.now() + env.JOB_TIMEOUT,
        signal: ctx.signal,
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
