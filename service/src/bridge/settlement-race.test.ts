import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import type * as t from '../types';
import { RedisBridgeStore } from './store';
import type { CodeBridgeAssignment, CodeBridgeSettlement } from './store';

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

// Optional real Redis run: use a test server. Keys are isolated per test and
// cleaned up by prefix, with separate dispatcher and worker connections.
const redisUrl = process.env.BRIDGE_TEST_REDIS_URL;
for (const backend of ['mock', 'redis'] as const) {
  const suite =
    backend === 'redis' && (redisUrl == null || redisUrl === '')
      ? describe.skip
      : describe;
  suite(`settlement/close arbitration (${backend})`, () => {
    let redis: Redis;
    let workerRedis: Redis;
    let admin: Redis | undefined;
    let prefix: string;
    let store: RedisBridgeStore;
    let worker: RedisBridgeStore;
    let originalEval: Redis['eval'];
    let originalGet: Redis['get'];
    const incarnationId = 'incarnation-settlement-race';
    const workerId = 'settlement-race';
    const markerPattern =
      'codeapi:bridge:v1:worker:settlement-race:workspace:*:quarantined';

    beforeEach(() => {
      prefix = `race-test:${randomUUID()}:`;
      if (backend === 'redis') {
        admin = new Redis(redisUrl!);
        redis = new Redis(redisUrl!, { keyPrefix: prefix });
        workerRedis = new Redis(redisUrl!, { keyPrefix: prefix });
      } else {
        redis = new RedisMock() as unknown as Redis;
        workerRedis = redis;
      }
      store = new RedisBridgeStore(redis, 60, 100);
      worker = new RedisBridgeStore(workerRedis, 60, 100);
      originalEval = redis.eval.bind(redis) as Redis['eval'];
      originalGet = redis.get.bind(redis) as Redis['get'];
    });
    afterEach(async () => {
      if (admin) {
        const keys = await admin.keys(`${prefix}*`);
        if (keys.length) await admin.del(...keys);
        admin.disconnect();
        admin = undefined;
      } else {
        await redis.flushall();
      }
      redis.disconnect();
      workerRedis.disconnect();
    });
    async function start(stateful = true): Promise<{
      controller: AbortController;
      completion: Promise<CodeBridgeSettlement>;
      assignment: CodeBridgeAssignment;
      finalizations: string[];
    }> {
      await store.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId,
        incarnationId,
        capabilities: {
          statefulWorkspace: stateful,
          sandboxProfile: 'nsjail',
          runtimes: [],
        },
      });
      const controller = new AbortController();
      const finalizations: string[] = [];
      const completion = store.dispatch({
        workerId,
        body: { language: 'bash' } as t.PayloadBody,
        headers: {},
        ...(stateful ? { runtimeSessionId: 'race-workspace' } : {}),
        deadlineAtMs: Date.now() + 10_000,
        signal: controller.signal,
        finalize: async settlement => {
          finalizations.push(settlement.status);
          return settlement;
        },
      });
      void completion.catch(() => undefined);
      const assignment = (await worker.lease(workerId, incarnationId, 1_000))!;
      expect(assignment).toBeDefined();
      await worker.acknowledgeLease(
        workerId,
        incarnationId,
        assignment.assignmentId,
        assignment.generation,
        assignment.leaseToken,
      );
      return { controller, completion, assignment, finalizations };
    }
    function result(assignment: CodeBridgeAssignment): CodeBridgeSettlement {
      return {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        incarnationId,
        generation: assignment.generation,
        leaseToken: assignment.leaseToken,
        status: 'fulfilled' as const,
        result: {
          language: 'bash',
          version: '5.2',
          session_id: 'race-result',
          files: [],
        },
      };
    }
    async function markers(): Promise<string[]> {
      return admin
        ? admin.keys(`${prefix}${markerPattern}`)
        : redis.keys(markerPattern);
    }
    for (const stateful of [true, false]) {
      test(`close rejects fulfillment already past preflight (stateful=${stateful})`, async () => {
        const { controller, completion, assignment, finalizations } =
          await start(stateful);
        const entered = barrier();
        const resume = barrier();
        const workerEval = workerRedis.eval.bind(workerRedis);
        workerRedis.eval = (async (...args: Parameters<Redis['eval']>) => {
          if (
            String(args[0]).includes(
              'local existing = redis.call(\'GET\', KEYS[2])',
            )
          ) {
            entered.release();
            await resume.promise;
          }
          return workerEval(...args);
        }) as Redis['eval'];
        const settling = worker.settle(
          workerId,
          assignment.assignmentId,
          result(assignment),
        );
        void settling.catch(() => undefined);
        await entered.promise;
        controller.abort();
        try {
          await expect(completion).rejects.toMatchObject({
            code: 'ASSIGNMENT_EXPIRED',
          });
        } finally {
          resume.release();
        }
        await expect(settling).rejects.toMatchObject({
          code: 'ASSIGNMENT_EXPIRED',
        });
        expect(
          await redis.get(
            `codeapi:bridge:v1:assignment:${assignment.assignmentId}:settlement`,
          ),
        ).toBeNull();
        expect(
          await redis.exists(
            `codeapi:bridge:v1:assignment:${assignment.assignmentId}:deadline`,
          ),
        ).toBe(0);
        expect(finalizations).toEqual([]);
        expect(await markers()).toHaveLength(stateful ? 1 : 0);
        if (stateful) {
          await worker.settle(workerId, assignment.assignmentId, {
            ...result(assignment),
            status: 'rejected',
            error: 'not executed',
          });
          expect(await markers()).toHaveLength(0);
        }
      });
    }
    test('settlement wins before close and commits despite caller abort', async () => {
      const { controller, completion, assignment, finalizations } =
        await start();
      const entered = barrier();
      const resume = barrier();
      redis.eval = (async (...args: Parameters<Redis['eval']>) => {
        if (
          String(args[0]).includes(
            'local settlement = redis.call(\'GET\', KEYS[2])',
          )
        ) {
          entered.release();
          await resume.promise;
        }
        return originalEval(...args);
      }) as Redis['eval'];
      controller.abort();
      await entered.promise;
      try {
        await worker.settle(
          workerId,
          assignment.assignmentId,
          result(assignment),
        );
      } finally {
        resume.release();
      }
      await expect(completion).resolves.toEqual(result(assignment));
      expect(finalizations).toEqual(['fulfilled']);
      expect(await markers()).toHaveLength(0);
      await expect(
        worker.settle(workerId, assignment.assignmentId, result(assignment)),
      ).resolves.toBeUndefined();
    });
    for (const failure of ['abort', 'timeout', 'error'] as const) {
      test(`a poll ${failure} still closes fulfillment`, async () => {
        const entered = barrier();
        let intercept = false;
        redis.get = ((key: string) => {
          if (intercept && key.endsWith(':settlement')) {
            entered.release();
            return failure === 'error'
              ? Promise.reject(new Error('poll unavailable'))
              : new Promise<never>(() => {});
          }
          return originalGet(key);
        }) as Redis['get'];
        const { controller, completion, assignment } = await start();
        intercept = true;
        await entered.promise;
        if (failure === 'abort') controller.abort();
        const messages = {
          abort: 'deadline',
          error: 'poll unavailable',
          timeout: 'poll timed out',
        };
        await expect(completion).rejects.toThrow(messages[failure]);
        redis.get = originalGet;
        await expect(
          worker.settle(workerId, assignment.assignmentId, result(assignment)),
        ).rejects.toMatchObject({ code: 'ASSIGNMENT_EXPIRED' });
        expect(await markers()).toHaveLength(1);
      });
    }
    test('an unconfirmed close preserves the workspace fence', async () => {
      const { controller, completion } = await start();
      redis.eval = ((...args: Parameters<Redis['eval']>) => {
        if (
          String(args[0]).includes(
            'local settlement = redis.call(\'GET\', KEYS[2])',
          )
        )
          return new Promise<never>(() => {});
        return originalEval(...args);
      }) as Redis['eval'];
      controller.abort();
      await expect(completion).rejects.toThrow(
        'Bridge settlement close timed out',
      );
      expect(await markers()).toHaveLength(1);
      expect(
        await redis.get('codeapi:bridge:v1:worker:settlement-race:lock'),
      ).not.toBeNull();
    });
  });
}
