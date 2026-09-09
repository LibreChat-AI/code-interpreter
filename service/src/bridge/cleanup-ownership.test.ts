import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { RedisBridgeStore } from './store';
import type { CodeBridgeAssignment } from './store';

const redisUrl = process.env.BRIDGE_TEST_REDIS_URL;
for (const backend of ['mock', 'redis'] as const) {
  const suite = backend === 'redis' && !redisUrl ? describe.skip : describe;
  suite(`lease cleanup ownership (${backend})`, () => {
    let redis: Redis;
    let admin: Redis | undefined;
    let prefix: string;
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
    });

    for (const stateful of [false, true]) {
      for (const acknowledged of [false, true]) {
        test(`delayed cleanup preserves replacement lease (acknowledged=${acknowledged}, stateful=${stateful})`, async () => {
          prefix = `cleanup-test:${randomUUID()}:`;
          if (backend === 'redis') {
            admin = new Redis(redisUrl!);
            redis = new Redis(redisUrl!, { keyPrefix: prefix });
          } else {
            redis = new RedisMock() as unknown as Redis;
          }
          const store = new RedisBridgeStore(redis);
          const workerId = 'cleanup-owner';
          const incarnationId = 'cleanup-incarnation';
          const claim = `codeapi:bridge:v1:worker:${workerId}:incarnation:${incarnationId}:lease-claim`;
          const ack = `codeapi:bridge:v1:worker:${workerId}:incarnation:${incarnationId}:lease-ack`;
          const assignmentId = 'old-assignment';
          const replacementId = 'replacement-assignment';
          const lock = `codeapi:bridge:v1:worker:${workerId}:lock`;
          const runtimeSessionId = stateful ? 'old-workspace' : undefined;
          const marker = `codeapi:bridge:v1:worker:${workerId}:workspace:${createHash(
            'sha256',
          )
            .update(runtimeSessionId ?? '')
            .digest('hex')}:quarantined`;
          await redis.set(claim, replacementId);
          if (acknowledged) await redis.set(ack, replacementId);
          await redis.set(lock, replacementId);
          await redis.set(`codeapi:bridge:v1:assignment:${assignmentId}`, '{}');
          if (stateful) await redis.set(marker, assignmentId);
          // Model an already-issued cleanup that resumes after the worker's
          // previous lock expired and a replacement assignment claimed it.
          const cleanupStore = store as unknown as {
            cleanup(assignment: CodeBridgeAssignment): Promise<void>;
          };
          await cleanupStore.cleanup({
            workerId,
            incarnationId,
            assignmentId,
            runtimeSessionId,
          } as CodeBridgeAssignment);
          expect(await redis.get(claim)).toBe(replacementId);
          expect(await redis.get(ack)).toBe(
            acknowledged ? replacementId : null,
          );
          expect(await redis.get(lock)).toBe(replacementId);
          expect(
            await redis.get(`codeapi:bridge:v1:assignment:${assignmentId}`),
          ).toBeNull();
          // Unknown previous execution must remain fenced, independently of
          // the newer assignment's claim and lock.
          if (stateful) expect(await redis.get(marker)).toBe(assignmentId);
        });
      }
    }
  });
}
