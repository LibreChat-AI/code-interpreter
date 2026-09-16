import { expect, test } from 'bun:test';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisBridgeStore } from './store';
import type { CodeBridgeAssignment } from './store';

/** Opt-in integration check against a disposable Redis, never a deployment database. */
test.skipIf(!process.env.BRIDGE_TEST_REDIS_URL)(
    'admission saturation is isolated across machines and independent roots',
    async () => {
        const redis = new Redis(process.env.BRIDGE_TEST_REDIS_URL!);
        const store = new RedisBridgeStore(redis, 60, 1000, 2);
        const prefix = `fleet-${randomUUID()}`;
        const machines = [`${prefix}-a`, `${prefix}-b`];
        const incarnationId = 'fleet-incarnation';
        const pending: Promise<unknown>[] = [];
        const controller = new AbortController();
        const dispatch = (
            workerId: string,
            workspaceId: string,
            budgetMs = 3000,
        ) => {
            const result = store.dispatchWorkspaceTool({
                workerId,
                signal: controller.signal,
                deadlineAtMs: Date.now() + budgetMs,
                executionTimeoutMs: 5000,
                request: {
                    protocolVersion: 1,
                    operation: 'read_file',
                    workspaceId,
                    path: 'probe',
                },
            });
            void result.catch(() => undefined);
            pending.push(result);
            return result;
        };
        const settle = async (assignment: CodeBridgeAssignment) => {
            await store.acknowledgeLease(
                assignment.workerId,
                incarnationId,
                assignment.assignmentId,
                assignment.generation,
                assignment.leaseToken,
            );
            await store.settle(assignment.workerId, assignment.assignmentId, {
                protocolVersion: 1,
                incarnationId,
                generation: assignment.generation,
                leaseToken: assignment.leaseToken,
                status: 'rejected',
                error: 'probe complete',
            });
        };
        try {
            for (const workerId of machines) {
                const generation = await store.register({
                    protocolVersion: 1,
                    workerId,
                    incarnationId,
                    capabilities: {
                        statefulWorkspace: false,
                        sandboxProfile: 'native-srt',
                        runtimes: [],
                        workspaceLeaseSlots: 2,
                        requiresReadyConfirmation: true,
                        workspaceTools: {
                            protocolVersion: 1,
                            operations: ['read_file'],
                            workspaces: [{ id: 'a' }, { id: 'b' }],
                        },
                    },
                });
                await store.confirmReady(workerId, incarnationId, generation);
            }
            const busy = dispatch(machines[0], 'a');
            const held = await store.lease(
                machines[0],
                incarnationId,
                1000,
                undefined,
                undefined,
                0,
            );
            expect(held).toBeDefined();
            const blocked = dispatch(machines[0], 'a', 300);
            const independent = dispatch(machines[0], 'b');
            const otherMachine = dispatch(machines[1], 'a');
            const root = await store.lease(
                machines[0],
                incarnationId,
                1000,
                undefined,
                undefined,
                1,
            );
            const remote = await store.lease(
                machines[1],
                incarnationId,
                1000,
                undefined,
                undefined,
                0,
            );
            expect(root?.request).toMatchObject({ workspaceId: 'b' });
            expect(remote?.workerId).toBe(machines[1]);
            await settle(root!);
            await settle(remote!);
            await Promise.all([independent, otherMachine]);
            await expect(blocked).rejects.toMatchObject({
                code: 'WORKSPACE_QUEUE_TIMEOUT',
            });
            await settle(held!);
            await busy;
            expect(
                await store.lease(
                    machines[0],
                    incarnationId,
                    20,
                    undefined,
                    undefined,
                    0,
                ),
            ).toBeUndefined();
        } finally {
            controller.abort();
            await Promise.allSettled(pending);
            await redis.quit();
        }
    },
);
