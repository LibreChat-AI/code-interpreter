import { expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisBridgeStore } from './store';
import { BridgeWorker } from '../../../packages/code/src/worker';
import { WorkspaceToolError } from '../../../packages/code/src/workspace';
import type { WorkspaceMutationQuarantine } from '../../../packages/code/src/worker';
import type { BridgeWorkspaceToolCapabilities } from '../../../packages/code/src/protocol';

for (const failure of ['execution', 'cleanup', 'post-unlink']) {
  const cleanupFailure = failure !== 'execution';
  test(`concurrent worker isolates ${failure} failure`, async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisBridgeStore(redis, 60, 1000, 2);
    const controller = new AbortController();
    const workerId = 'worker-concurrency';
    const incarnationId = 'incarnation-concurrency';
    const guards = new Map<string, WorkspaceMutationQuarantine>();
    const pending = new Set<string>();
    for (const root of ['a', 'b'])
      guards.set(root, {
        async assertAvailable() {
          if (pending.has(root)) throw new Error('quarantined');
        },
        async arm() {
          pending.add(root);
        },
        async clear() {
          if (failure === 'post-unlink') pending.delete(root);
          if (cleanupFailure && root === 'a')
            throw new Error('injected guard cleanup failure');
          pending.delete(root);
        },
        async quarantine() {
          expect(pending.has(root)).toBe(true);
        },
      });
    const capabilities: BridgeWorkspaceToolCapabilities = {
      protocolVersion: 1,
      operations: ['execute_command'],
      workspaces: [{ id: 'a' }, { id: 'b' }],
    };
    let startBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      startBoth = resolve;
    });
    const started = new Set<string>();
    const errors: unknown[] = [];
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const worker = new BridgeWorker({
      codeApiUrl: 'http://fixture.invalid',
      token: 'fixture',
      workerId,
      incarnationId,
      sandboxEndpoint: 'http://sandbox.invalid',
      leaseWaitMs: 50,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'native-srt',
        runtimes: [],
        requiresReadyConfirmation: true,
        workspaceLeaseSlots: 2,
        workspaceTools: capabilities,
      },
      workspaceQuarantines: guards,
      onError: (error) => {
        errors.push(error);
      },
      workspaceTools: {
        capabilities,
        mutationFailuresAreAtomic: true,
        async execute(request) {
          started.add(request.workspaceId);
          if (started.size === 2) startBoth();
          await bothStarted;
          if (request.workspaceId === 'a' && !cleanupFailure)
            throw new WorkspaceToolError(
              'uncertain command',
              'COMMAND_UNAVAILABLE',
              true,
            );
          return {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: request.workspaceId,
            stdout: 'completed',
            stderr: '',
            exitCode: 0,
            truncated: false,
            timedOut: false,
          };
        },
      },
      fetchImpl: (async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init?.body));
        const signal = init?.signal ?? undefined;
        let result: object;
        if (path.endsWith('/register')) {
          const generation = await store.register(body);
          result = {
            protocolVersion: 1,
            workerId,
            incarnationId,
            registrationGeneration: generation,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60000,
            workspaceLeaseSlots: 2,
            supportedWorkspaceToolOperations: ['execute_command'],
          };
        } else if (path.endsWith('/ready')) {
          await store.confirmReady(
            workerId,
            incarnationId,
            body.registrationGeneration,
          );
          registered();
          result = { protocolVersion: 1, ready: true };
        } else if (path.endsWith('/lease')) {
          result = {
            protocolVersion: 1,
            serverElapsedMs: 0,
            assignment: await store.lease(
              workerId,
              incarnationId,
              body.waitMs,
              signal,
              undefined,
              body.workspaceLeaseSlot,
            ),
          };
        } else {
          const id = path.split('/').at(-2)!;
          if (path.endsWith('/ack')) {
            await store.acknowledgeLease(
              workerId,
              incarnationId,
              id,
              body.generation,
              body.leaseToken,
              signal,
            );
            result = { protocolVersion: 1, accepted: true };
          } else if (path.endsWith('/cancellation')) {
            result = {
              protocolVersion: 1,
              cancelled: await store.cancelled(
                workerId,
                incarnationId,
                id,
                signal,
              ),
            };
          } else {
            await store.settle(
              workerId,
              id,
              body,
              signal,
              undefined,
              path.endsWith('/quarantine'),
            );
            result = { protocolVersion: 1, accepted: true };
          }
        }
        return Response.json(result);
      }) as typeof fetch,
    });
    const running = worker.run(controller.signal);
    void running.catch(() => undefined);
    try {
      await ready;
      const results = await Promise.allSettled(
        ['a', 'b'].map((workspaceId) =>
          store.dispatchWorkspaceTool({
            workerId,
            signal: controller.signal,
            deadlineAtMs: Date.now() + 3000,
            request: {
              protocolVersion: 1,
              operation: 'execute_command',
              workspaceId,
              command: 'fixture',
            },
          }),
        ),
      );
      if (!cleanupFailure)
        expect(results[0]).toMatchObject({
          status: 'fulfilled',
          value: { status: 'rejected' },
        });
      else if (results[0].status === 'fulfilled')
        expect(results[0].value).toMatchObject({ status: 'fulfilled', result: { stdout: 'completed' } });
      else expect(results[0].reason).toMatchObject({ code: 'WORKSPACE_QUARANTINED' });
      expect(results[1]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'fulfilled' },
      });
      for (let i = 0; i < 100 && errors.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(errors.length).toBe(1);
      await expect(
        store.dispatchWorkspaceTool({
          workerId,
          signal: controller.signal,
          deadlineAtMs: Date.now() + 1000,
          request: {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: 'a',
            command: 'must not execute',
          },
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_QUARANTINED' });
      await expect(
        store.dispatchWorkspaceTool({
          workerId,
          signal: controller.signal,
          deadlineAtMs: Date.now() + 1000,
          request: {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: 'b',
            command: 'still healthy',
          },
        }),
      ).resolves.toMatchObject({ status: 'fulfilled' });
      expect([...pending]).toEqual(failure === 'post-unlink' ? [] : ['a']);
      expect(started.size).toBe(2);
    } catch (error) {
      throw new AggregateError(
        [error, ...errors],
        `Started roots: ${[...started].join(',')}`,
      );
    } finally {
      controller.abort();
      await running;
      await redis.flushall();
      redis.disconnect();
    }
  });
}
