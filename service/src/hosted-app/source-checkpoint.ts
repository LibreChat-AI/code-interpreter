import type { RuntimeSessionRecord } from '../runtime-session/registry';
import { HostedAppControlPlaneError, type HostedAppOwner } from './control-plane';

export interface HostedAppSourceCheckpointDeps {
  waitForLock(
    runtimeSessionId: string,
    args: { waitMs: number; signal: AbortSignal },
  ): Promise<string | null>;
  releaseLock(runtimeSessionId: string, lockToken: string): Promise<void>;
  read(
    runtimeSessionId: string,
    args: { signal: AbortSignal },
  ): Promise<RuntimeSessionRecord | null>;
  checkpoint(args: {
    runtimeSessionId: string;
    lockToken: string;
    signal: AbortSignal;
  }): Promise<'stored' | 'skipped_busy' | 'skipped_state' | 'failed'>;
}

/** Freeze one exact source workspace revision for an app. A live VM gets a
 * fresh checkpoint; a stopped VM can reuse its last committed immutable
 * checkpoint. The source lock spans commit and pointer read. */
export async function captureHostedAppSourceCheckpoint(args: {
  runtimeSessionId: string;
  owner: HostedAppOwner;
  signal: AbortSignal;
  lockWaitMs: number;
  deps: HostedAppSourceCheckpointDeps;
}): Promise<string> {
  const lockToken = await args.deps.waitForLock(args.runtimeSessionId, {
    waitMs: args.lockWaitMs,
    signal: args.signal,
  });
  if (!lockToken) {
    throw new HostedAppControlPlaneError(
      'hosted_app_source_busy',
      'The stateful workspace is busy; retry after its execution completes',
      409,
      true,
    );
  }
  try {
    let source = await args.deps.read(args.runtimeSessionId, { signal: args.signal });
    if (
      !source
      || source.tenant_id !== args.owner.tenantId
      || source.canonical_user_id !== args.owner.canonicalUserId
    ) {
      throw new HostedAppControlPlaneError(
        'hosted_app_source_not_found',
        'Stateful source workspace not found',
        404,
      );
    }
    if (source.state === 'RUNNING' && source.microvm_id && source.endpoint) {
      const result = await args.deps.checkpoint({
        runtimeSessionId: args.runtimeSessionId,
        lockToken,
        signal: args.signal,
      });
      if (result !== 'stored') {
        throw new HostedAppControlPlaneError(
          'hosted_app_checkpoint_failed',
          'Could not capture the current stateful workspace revision',
          503,
          true,
        );
      }
      source = await args.deps.read(args.runtimeSessionId, { signal: args.signal });
    }
    if (!source?.workspace_checkpoint) {
      throw new HostedAppControlPlaneError(
        'hosted_app_checkpoint_missing',
        'The stateful workspace has no durable checkpoint to host',
        503,
        true,
      );
    }
    return source.workspace_checkpoint;
  } finally {
    await args.deps.releaseLock(args.runtimeSessionId, lockToken);
  }
}
