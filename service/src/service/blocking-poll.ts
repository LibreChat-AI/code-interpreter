import type * as t from '../types';

export interface BlockingPendingState {
  status: string;
  pending_calls?: Array<{
    call_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
  }>;
}

export interface BlockingPollDependencies {
  getExecutionState(id: string): Promise<{
    jobCompleted?: boolean;
    jobResult?: t.ExecuteResult;
    jobError?: string;
  } | null>;
  getBlockingResult(id: string): Promise<t.ExecuteResult | null>;
  getPending(id: string): Promise<BlockingPendingState>;
  isNotFound(error: unknown): boolean;
  sleep(): Promise<void>;
  now(): number;
}

/** Tool-call completion precedes upload reconciliation. Only a worker result is final. */
export async function pollBlockingExecution(
  id: string,
  timeout: number,
  deps: BlockingPollDependencies,
): Promise<{
  status: 'waiting' | 'completed' | 'error';
  pending_calls?: t.ProgrammaticToolCall[];
  stdout?: string;
  stderr?: string;
  files?: t.FileRefs;
  artifact_delivery?: t.ArtifactDeliveryFailure;
}> {
  const start = deps.now();
  while (deps.now() - start < timeout) {
    const execution = await deps.getExecutionState(id);
    if (execution?.jobCompleted === true) {
      // Preserve the inline result fallback for in-flight jobs from older binaries.
      const result = (await deps.getBlockingResult(id)) ?? execution.jobResult;
      if (result) {
        return {
          status: 'completed',
          stdout: result.stdout,
          stderr: result.stderr,
          files: result.files,
          artifact_delivery: result.artifact_delivery,
        };
      }
    }
    if (execution?.jobError != null) return { status: 'error' };

    try {
      const pending = await deps.getPending(id);
      if (pending.status === 'waiting' && pending.pending_calls != null && pending.pending_calls.length > 0) {
        return {
          status: 'waiting',
          pending_calls: pending.pending_calls.map(call => ({
            id: call.call_id,
            name: call.tool_name,
            input: call.tool_input,
          })),
        };
      }
      if (pending.status === 'error') return { status: 'error' };
      // Both completed and missing callback sessions must await the worker result.
    } catch (error) {
      if (!deps.isNotFound(error)) throw error;
    }
    await deps.sleep();
  }
  return { status: 'error' };
}
