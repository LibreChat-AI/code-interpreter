import { createHash, randomBytes } from 'crypto';

import type Redis from 'ioredis';
import type * as t from '../types';
import type {
  BridgeAssignment,
  BridgeSettlement,
  BridgeWorkerRegistration,
} from '../../../packages/code/src/protocol';

import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';

const PREFIX = 'codeapi:bridge:v1';
const POLL_INTERVAL_MS = 100;
const DEFAULT_WORKER_TTL_SECONDS = 60;
const MAX_ASSIGNMENT_TTL_SECONDS = 10 * 60;

export type CodeBridgeAssignment = BridgeAssignment<t.PayloadBody>;
export type CodeBridgeSettlement = BridgeSettlement<
  t.ExecuteResponse & {
    session_id: string;
    files?: t.FileRefs;
    run?: t.ExecuteResponse['run'];
  }
>;

export class BridgeStoreError extends Error {
  constructor(
    public readonly code:
      | 'WORKER_OFFLINE'
      | 'WORKER_BUSY'
      | 'ASSIGNMENT_EXPIRED'
      | 'ASSIGNMENT_FENCED'
      | 'ASSIGNMENT_NOT_FOUND'
      | 'WORKER_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeStoreError';
  }
}

interface StoredAssignment extends CodeBridgeAssignment {
  leaseTokenHash: string;
}

function workerKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}`;
}

function queueKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:assignments`;
}

function generationKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:generation`;
}

function lockKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:lock`;
}

function assignmentKey(assignmentId: string): string {
  return `${PREFIX}:assignment:${assignmentId}`;
}

function settlementKey(assignmentId: string): string {
  return `${PREFIX}:assignment:${assignmentId}:settlement`;
}

function cancellationKey(assignmentId: string): string {
  return `${PREFIX}:assignment:${assignmentId}:cancelled`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function assignmentTtlSeconds(deadlineAtMs: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_ASSIGNMENT_TTL_SECONDS,
      Math.ceil((deadlineAtMs - Date.now()) / 1000) + 30,
    ),
  );
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class RedisBridgeStore {
  constructor(
    private readonly redis: Redis,
    private readonly workerTtlSeconds = DEFAULT_WORKER_TTL_SECONDS,
  ) {}

  async register(registration: BridgeWorkerRegistration): Promise<void> {
    await this.redis.set(
      workerKey(registration.workerId),
      JSON.stringify(registration),
      'EX',
      this.workerTtlSeconds,
    );
  }

  async dispatch(args: {
    workerId: string;
    body: t.PayloadBody;
    headers: Record<string, string>;
    runtimeSessionId?: string;
    deadlineAtMs: number;
    signal: AbortSignal;
  }): Promise<CodeBridgeSettlement> {
    const registration = await this.registration(args.workerId);
    if (registration == null) {
      throw new BridgeStoreError(
        'WORKER_OFFLINE',
        `Bridge worker ${args.workerId} is offline`,
      );
    }
    if (
      args.runtimeSessionId !== undefined &&
      registration.capabilities.statefulWorkspace !== true
    ) {
      throw new BridgeStoreError(
        'WORKER_MISMATCH',
        `Bridge worker ${args.workerId} does not provide a stateful workspace`,
      );
    }

    const assignmentId = randomBytes(18).toString('base64url');
    const leaseToken = randomBytes(32).toString('base64url');
    const ttlSeconds = assignmentTtlSeconds(args.deadlineAtMs);
    const locked = await this.redis.set(
      lockKey(args.workerId),
      assignmentId,
      'PX',
      ttlSeconds * 1000,
      'NX',
    );
    if (locked !== 'OK') {
      throw new BridgeStoreError(
        'WORKER_BUSY',
        `Bridge worker ${args.workerId} is busy`,
      );
    }

    const generation = await this.redis.incr(generationKey(args.workerId));
    const assignment: StoredAssignment = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      assignmentId,
      workerId: args.workerId,
      generation,
      leaseToken,
      leaseTokenHash: tokenHash(leaseToken),
      expiresAt: new Date(args.deadlineAtMs).toISOString(),
      runtimeSessionId: args.runtimeSessionId,
      request: {
        body: args.body,
        headers: args.headers,
      },
    };

    try {
      const transaction = this.redis.multi();
      transaction.set(
        assignmentKey(assignmentId),
        JSON.stringify(assignment),
        'EX',
        ttlSeconds,
      );
      transaction.rpush(queueKey(args.workerId), assignmentId);
      transaction.expire(queueKey(args.workerId), ttlSeconds);
      await transaction.exec();
      return await this.waitForSettlement(
        assignment,
        args.deadlineAtMs,
        args.signal,
      );
    } finally {
      await this.cancel(assignmentId);
      await this.cleanup(assignment);
    }
  }

  async lease(
    workerId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<CodeBridgeAssignment | undefined> {
    const deadline = Date.now() + waitMs;
    while (signal?.aborted !== true && Date.now() < deadline) {
      const assignmentId = await this.redis.lpop(queueKey(workerId));
      if (assignmentId == null) {
        await delay(
          Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          signal,
        );
        continue;
      }
      const assignment = await this.readAssignment(assignmentId);
      if (assignment == null || assignment.workerId !== workerId) continue;
      if (Date.parse(assignment.expiresAt) <= Date.now()) continue;
      const { leaseTokenHash: _leaseTokenHash, ...wireAssignment } = assignment;
      return wireAssignment;
    }
    return undefined;
  }

  async settle(
    workerId: string,
    assignmentId: string,
    settlement: CodeBridgeSettlement,
  ): Promise<void> {
    const assignment = await this.readAssignment(assignmentId);
    if (assignment == null) {
      throw new BridgeStoreError(
        'ASSIGNMENT_NOT_FOUND',
        'Bridge assignment was not found',
      );
    }
    if (assignment.workerId !== workerId) {
      throw new BridgeStoreError(
        'WORKER_MISMATCH',
        'Bridge assignment belongs to another worker',
      );
    }
    if (
      settlement.generation !== assignment.generation ||
      tokenHash(settlement.leaseToken) !== assignment.leaseTokenHash
    ) {
      throw new BridgeStoreError(
        'ASSIGNMENT_FENCED',
        'Bridge assignment lease is stale',
      );
    }
    if (Date.parse(assignment.expiresAt) <= Date.now()) {
      throw new BridgeStoreError(
        'ASSIGNMENT_EXPIRED',
        'Bridge assignment has expired',
      );
    }
    const ttlSeconds = assignmentTtlSeconds(Date.parse(assignment.expiresAt));
    await this.redis.set(
      settlementKey(assignmentId),
      JSON.stringify(settlement),
      'EX',
      ttlSeconds,
    );
  }

  async cancelled(workerId: string, assignmentId: string): Promise<boolean> {
    const assignment = await this.readAssignment(assignmentId);
    if (assignment == null || assignment.workerId !== workerId) return true;
    return (await this.redis.exists(cancellationKey(assignmentId))) === 1;
  }

  private async registration(
    workerId: string,
  ): Promise<BridgeWorkerRegistration | undefined> {
    const raw = await this.redis.get(workerKey(workerId));
    return raw == null ? undefined : (JSON.parse(raw) as BridgeWorkerRegistration);
  }

  private async readAssignment(
    assignmentId: string,
  ): Promise<StoredAssignment | undefined> {
    const raw = await this.redis.get(assignmentKey(assignmentId));
    return raw == null ? undefined : (JSON.parse(raw) as StoredAssignment);
  }

  private async waitForSettlement(
    assignment: StoredAssignment,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<CodeBridgeSettlement> {
    while (!signal.aborted && Date.now() < deadlineAtMs) {
      const raw = await this.redis.get(settlementKey(assignment.assignmentId));
      if (raw != null) return JSON.parse(raw) as CodeBridgeSettlement;
      await delay(POLL_INTERVAL_MS, signal);
    }
    throw new BridgeStoreError(
      'ASSIGNMENT_EXPIRED',
      'Bridge assignment exceeded its deadline',
    );
  }

  private async cancel(assignmentId: string): Promise<void> {
    await this.redis.set(cancellationKey(assignmentId), '1', 'EX', 30);
  }

  private async cleanup(assignment: StoredAssignment): Promise<void> {
    const script = [
      'if redis.call(\'GET\', KEYS[1]) == ARGV[1] then',
      '  return redis.call(\'DEL\', KEYS[1])',
      'end',
      'return 0',
    ].join('\n');
    await Promise.all([
      this.redis.del(
        assignmentKey(assignment.assignmentId),
        settlementKey(assignment.assignmentId),
      ),
      this.redis.eval(
        script,
        1,
        lockKey(assignment.workerId),
        assignment.assignmentId,
      ),
    ]);
  }
}
