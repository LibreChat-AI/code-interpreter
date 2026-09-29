import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import Redis from 'ioredis';
import { RedisBridgeStore } from './store';
import type { CodeBridgeAssignment } from './store';
import type { WorkspaceToolRequest } from '../../../packages/code/src/protocol';

const redisUrl = process.env.BRIDGE_TEST_REDIS_URL;
const incarnationId = 'lane-incarnation';

function fenceKey(workerId: string, fence: string): string {
  const hash = createHash('sha256').update(fence).digest('hex');
  return `codeapi:bridge:v1:worker:${encodeURIComponent(workerId)}:workspace:${hash}:quarantined`;
}

async function withLaneWorker(
  run: (context: {
    store: RedisBridgeStore;
    redis: Redis;
    workerId: string;
    dispatch: (
      request: Partial<WorkspaceToolRequest>,
      budgetMs?: number,
    ) => Promise<unknown>;
    lease: (slot: number) => Promise<CodeBridgeAssignment | undefined>;
    settle: (assignment: CodeBridgeAssignment) => Promise<void>;
  }) => Promise<void>,
  scopes = true,
): Promise<void> {
  const redis = new Redis(redisUrl!);
  const store = new RedisBridgeStore(redis, 60, 1000, 3);
  const workerId = `lanes-${randomUUID()}`;
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    const generation = await store.register({
      protocolVersion: 1,
      workerId,
      incarnationId,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'native-srt',
        runtimes: [],
        workspaceLeaseSlots: 3,
        requiresReadyConfirmation: true,
        workspaceTools: {
          protocolVersion: 1,
          operations: ['read_file'],
          workspaces: [
            {
              id: 'repo',
              ...(scopes ? { workspaceScopes: ['git_linked_worktree' as const] } : {}),
            },
          ],
        },
      },
    });
    await store.confirmReady(workerId, incarnationId, generation);
    await run({
      store,
      redis,
      workerId,
      dispatch(request, budgetMs = 3000) {
        const result = store.dispatchWorkspaceTool({
          workerId,
          signal: controller.signal,
          deadlineAtMs: Date.now() + budgetMs,
          executionTimeoutMs: 5000,
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'repo',
            path: 'probe',
            ...request,
          } as WorkspaceToolRequest,
        });
        void result.catch(() => undefined);
        pending.push(result);
        return result;
      },
      lease: (slot) => store.lease(workerId, incarnationId, 1000, undefined, undefined, slot),
      async settle(assignment) {
        await store.acknowledgeLease(
          workerId,
          incarnationId,
          assignment.assignmentId,
          assignment.generation,
          assignment.leaseToken,
        );
        await store.settle(workerId, assignment.assignmentId, {
          protocolVersion: 1,
          incarnationId,
          generation: assignment.generation,
          leaseToken: assignment.leaseToken,
          status: 'rejected',
          error: 'probe complete',
        });
        await store.confirmWorkspaceCleanup(workerId, assignment.assignmentId, {
          protocolVersion: 1,
          incarnationId,
          generation: assignment.generation,
          leaseToken: assignment.leaseToken,
          status: 'rejected',
          error: 'local cleanup confirmed',
        });
      },
    });
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    await redis.quit();
  }
}

test.skipIf(!redisUrl)(
  'sibling linked-worktree lanes run together while their checkout waits for both',
  async () => {
    await withLaneWorker(async ({ dispatch, lease, settle }) => {
      const laneA = dispatch({ worktree: 'task-a' });
      const laneB = dispatch({ worktree: 'task-b' });
      const first = await lease(0);
      const second = await lease(1);
      expect(
        [first?.request, second?.request].map(
          (request) => (request as WorkspaceToolRequest).worktree,
        ).sort(),
      ).toEqual(['task-a', 'task-b']);

      const checkout = dispatch({}, 400);
      expect(await lease(2)).toBeUndefined();
      await expect(checkout).rejects.toMatchObject({ code: 'WORKSPACE_QUEUE_TIMEOUT' });

      await settle(first!);
      await settle(second!);
      await Promise.allSettled([laneA, laneB]);
    });
  },
);

test.skipIf(!redisUrl)('a busy checkout holds every lane beneath it', async () => {
  await withLaneWorker(async ({ dispatch, lease, settle }) => {
    const checkout = dispatch({});
    const held = await lease(0);
    expect((held?.request as WorkspaceToolRequest).worktree).toBeUndefined();

    const lane = dispatch({ worktree: 'task-a' });
    expect(await lease(1)).toBeUndefined();

    await settle(held!);
    await Promise.allSettled([checkout]);
    const admitted = await lease(0);
    expect((admitted?.request as WorkspaceToolRequest).worktree).toBe('task-a');
    await settle(admitted!);
    await Promise.allSettled([lane]);
  });
});

test.skipIf(!redisUrl)('a lane may not start while its checkout is quarantined', async () => {
  await withLaneWorker(async ({ redis, workerId, dispatch }) => {
    await redis.set(fenceKey(workerId, 'native-workspace:repo'), 'quarantined:earlier');
    await expect(dispatch({ worktree: 'task-a' })).rejects.toMatchObject({
      code: 'WORKSPACE_QUARANTINED',
    });
    expect(await redis.exists(fenceKey(workerId, 'native-workspace:\0linked-worktree\0repo\0task-a'))).toBe(0);
  });
});

test.skipIf(!redisUrl)('a lane is refused unless the worker advertises linked-worktree scopes', async () => {
  await withLaneWorker(async ({ dispatch }) => {
    await expect(dispatch({ worktree: 'task-a' })).rejects.toMatchObject({
      code: 'WORKER_MISMATCH',
    });
  }, false);
});
