import { describe, expect, test } from 'bun:test';
import { pollBlockingExecution, type BlockingPollDependencies } from './blocking-poll';
import type * as t from '../types';

const result: t.ExecuteResult = {
  session_id: 'session', stdout: 'successful code', stderr: '', files: [],
  artifact_delivery: {
    code: 'artifact_delivery_failed', status: 'failed', attempted: 1, delivered: 0, failed: 1,
  },
};

function fixture(): BlockingPollDependencies {
  let tick = 0;
  return {
    getExecutionState: async () => ({ jobCompleted: tick >= 2 }),
    getBlockingResult: async () => result,
    getPending: async () => ({ status: 'completed' }),
    isNotFound: (error: unknown) => error === 'missing',
    sleep: async (): Promise<void> => { tick++; },
    now: () => tick,
  };
}

describe('blocking worker settlement', () => {
  test('completed callback waits for delayed upload reconciliation', async () => {
    const deps = fixture();
    expect(await pollBlockingExecution('exec', 5, deps)).toEqual({
      status: 'completed', stdout: result.stdout, stderr: '', files: [],
      artifact_delivery: result.artifact_delivery,
    });
    expect(deps.now()).toBe(2);
  });

  test('missing callback session still receives the worker result', async () => {
    const deps = fixture();
    deps.getPending = async (): Promise<never> => { throw 'missing'; };
    expect((await pollBlockingExecution('exec', 5, deps)).artifact_delivery).toEqual(result.artifact_delivery);
  });

  test('never reports success if uploads remain unsettled at timeout', async () => {
    expect(await pollBlockingExecution('exec', 1, fixture())).toEqual({ status: 'error' });
  });

  test('accepts the legacy inline worker result during rolling deployments', async () => {
    const deps = fixture();
    expect(await pollBlockingExecution('exec', 5, {
      ...deps,
      getExecutionState: async () => ({ jobCompleted: true, jobResult: result }),
      getBlockingResult: async () => null,
    })).toMatchObject({ status: 'completed', artifact_delivery: result.artifact_delivery });
  });

  test('preserves waiting calls and worker failures', async () => {
    expect(await pollBlockingExecution('exec', 5, {
      ...fixture(),
      getPending: async () => ({ status: 'waiting', pending_calls: [
        { call_id: 'call', tool_name: 'search', tool_input: { query: 'hello' } },
      ] }),
    })).toEqual({ status: 'waiting', pending_calls: [
      { id: 'call', name: 'search', input: { query: 'hello' } },
    ] });
    expect(await pollBlockingExecution('exec', 5, {
      ...fixture(), getExecutionState: async () => ({ jobError: 'worker failed' }),
    })).toEqual({ status: 'error' });
  });
});
