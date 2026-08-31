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
      | 'WORKER_FENCED'
      | 'WORKER_QUARANTINED'
      | 'WORKSPACE_QUARANTINED'
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

function workerIncarnationKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:incarnation`;
}

function incarnationFenceKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${workerId}:incarnation:${incarnationId}:fenced`;
}

function quarantineKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${workerId}:incarnation:${incarnationId}:quarantined`;
}

function workspaceQuarantineKey(
  workerId: string,
  runtimeSessionId: string,
): string {
  const sessionHash = createHash('sha256')
    .update(runtimeSessionId)
    .digest('hex');
  return `${PREFIX}:worker:${workerId}:workspace:${sessionHash}:quarantined`;
}

function queueKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${workerId}:incarnation:${incarnationId}:assignments`;
}

function generationKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:generation`;
}

function lockKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:lock`;
}

function lockIncarnationKey(workerId: string): string {
  return `${PREFIX}:worker:${workerId}:lock:incarnation`;
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
  return Math.max(1, Math.ceil((deadlineAtMs - Date.now()) / 1000) + 30);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RedisBridgeStore {
  constructor(
    private readonly redis: Redis,
    private readonly workerTtlSeconds = DEFAULT_WORKER_TTL_SECONDS,
  ) {}

  async register(registration: BridgeWorkerRegistration): Promise<void> {
    const script = [
      'if redis.call(\'EXISTS\', KEYS[3]) == 1 then return -2 end',
      'if redis.call(\'EXISTS\', KEYS[2]) == 1 then return -1 end',
      'local current = redis.call(\'GET\', KEYS[4])',
      'if not current and redis.call(\'EXISTS\', KEYS[5]) == 1 then',
      '  local owner = redis.call(\'GET\', KEYS[6])',
      '  if owner ~= ARGV[1] then return -3 end',
      'end',
      'if current then',
      '  if current ~= ARGV[1] then',
      '    if redis.call(\'EXISTS\', KEYS[5]) == 1 then return -3 end',
      '    redis.call(\'SET\', ARGV[4] .. current .. \':fenced\', \"1\")',
      '  end',
      'end',
      'redis.call(\'SET\', KEYS[1], ARGV[2], \"EX\", ARGV[3])',
      'redis.call(\'SET\', KEYS[4], ARGV[1], \"EX\", ARGV[3])',
      'return 1',
    ].join('\n');
    const result = Number(
      await this.redis.eval(
        script,
        6,
        workerKey(registration.workerId),
        incarnationFenceKey(registration.workerId, registration.incarnationId),
        quarantineKey(registration.workerId, registration.incarnationId),
        workerIncarnationKey(registration.workerId),
        lockKey(registration.workerId),
        lockIncarnationKey(registration.workerId),
        registration.incarnationId,
        JSON.stringify(registration),
        String(this.workerTtlSeconds),
        `${PREFIX}:worker:${registration.workerId}:incarnation:`,
      ),
    );
    if (result === -2) {
      throw new BridgeStoreError(
        'WORKER_QUARANTINED',
        'Bridge worker incarnation is quarantined',
      );
    }
    if (result === -1) {
      throw new BridgeStoreError(
        'WORKER_FENCED',
        'Bridge worker incarnation was replaced',
      );
    }
    if (result === -3) {
      throw new BridgeStoreError(
        'WORKER_BUSY',
        'Bridge worker cannot be replaced during an active assignment',
      );
    }
  }

  async dispatch(args: {
    workerId: string;
    body: t.PayloadBody;
    headers: Record<string, string>;
    runtimeSessionId?: string;
    deadlineAtMs: number;
    signal: AbortSignal;
    finalize?: (
      settlement: CodeBridgeSettlement,
    ) => Promise<CodeBridgeSettlement>;
  }): Promise<CodeBridgeSettlement> {
    let registration = await this.registration(args.workerId);
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
    if (
      args.runtimeSessionId !== undefined &&
      (await this.redis.exists(
        workspaceQuarantineKey(args.workerId, args.runtimeSessionId),
      )) === 1
    ) {
      throw new BridgeStoreError(
        'WORKSPACE_QUARANTINED',
        'Bridge workspace is quarantined after an incomplete result commit',
      );
    }

    const assignmentId = randomBytes(18).toString('base64url');
    const leaseToken = randomBytes(32).toString('base64url');
    const ttlSeconds = assignmentTtlSeconds(args.deadlineAtMs);
    const locked = await this.acquireLock(
      args.workerId,
      assignmentId,
      registration.incarnationId,
      ttlSeconds,
    );
    if (!locked) {
      throw new BridgeStoreError(
        'WORKER_BUSY',
        `Bridge worker ${args.workerId} is busy`,
      );
    }

    let assignment: StoredAssignment | undefined;
    let resultCommitted = false;
    try {
      const generation = await this.redis.incr(generationKey(args.workerId));
      assignment = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        assignmentId,
        workerId: args.workerId,
        incarnationId: registration.incarnationId,
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
      let queued = false;
      for (let attempt = 0; attempt < 8 && !queued; attempt += 1) {
        assignment.incarnationId = registration.incarnationId;
        queued = await this.enqueueForActiveIncarnation(assignment, ttlSeconds);
        if (queued) break;
        const replacement = await this.registration(args.workerId);
        if (replacement == null) {
          throw new BridgeStoreError(
            'WORKER_OFFLINE',
            `Bridge worker ${args.workerId} went offline during dispatch`,
          );
        }
        if (
          args.runtimeSessionId !== undefined &&
          replacement.capabilities.statefulWorkspace !== true
        ) {
          throw new BridgeStoreError(
            'WORKER_MISMATCH',
            `Bridge worker ${args.workerId} does not provide a stateful workspace`,
          );
        }
        registration = replacement;
      }
      if (!queued) {
        throw new BridgeStoreError(
          'WORKER_OFFLINE',
          `Bridge worker ${args.workerId} changed incarnation repeatedly during dispatch`,
        );
      }
      const settlement = await this.waitForSettlement(
        assignment,
        args.deadlineAtMs,
        args.signal,
      );
      if (args.finalize == null) {
        resultCommitted = true;
        return settlement;
      }
      try {
        const result = await args.finalize(settlement);
        resultCommitted = true;
        return result;
      } catch (error) {
        await this.quarantine(
          args.workerId,
          assignment.incarnationId,
          args.runtimeSessionId,
        );
        throw error;
      }
    } finally {
      if (resultCommitted) {
        try {
          await this.cleanupWithRetry(args.workerId, assignmentId, assignment);
        } catch {
          // The lock and assignment have deadline-derived TTLs. Preserve the
          // already committed result rather than turning cleanup availability
          // into a client-visible failure that could prompt duplicate work.
        }
      } else {
        await this.cleanupDispatch(args.workerId, assignmentId, assignment);
      }
    }
  }

  async lease(
    workerId: string,
    incarnationId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<CodeBridgeAssignment | undefined> {
    const deadline = Date.now() + waitMs;
    while (signal?.aborted !== true && Date.now() < deadline) {
      const assignmentId = await this.redis.lpop(
        queueKey(workerId, incarnationId),
      );
      if (assignmentId == null) {
        await delay(
          Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          signal,
        );
        continue;
      }
      const assignment = await this.readAssignment(assignmentId);
      if (assignment == null || assignment.workerId !== workerId) continue;
      if (assignment.incarnationId !== incarnationId) continue;
      const registration = await this.registration(workerId);
      if (registration?.incarnationId !== incarnationId) {
        throw new BridgeStoreError(
          'WORKER_FENCED',
          'Bridge worker incarnation was replaced',
        );
      }
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
    const registration = await this.registration(workerId);
    if (
      settlement.incarnationId !== assignment.incarnationId ||
      registration?.incarnationId !== settlement.incarnationId ||
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
    const script = [
      'if redis.call(\'EXISTS\', KEYS[1]) == 0 then return 0 end',
      'redis.call(\'SET\', KEYS[2], ARGV[1], \"EX\", ARGV[2])',
      'return 1',
    ].join('\n');
    const accepted = Number(
      await this.redis.eval(
        script,
        2,
        assignmentKey(assignmentId),
        settlementKey(assignmentId),
        JSON.stringify(settlement),
        String(ttlSeconds),
      ),
    );
    if (accepted !== 1) {
      throw new BridgeStoreError(
        'ASSIGNMENT_EXPIRED',
        'Bridge assignment closed before settlement was committed',
      );
    }
  }

  async cancelled(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
  ): Promise<boolean> {
    const assignment = await this.readAssignment(assignmentId);
    const registration = await this.registration(workerId);
    if (
      assignment == null ||
      assignment.workerId !== workerId ||
      assignment.incarnationId !== incarnationId ||
      registration?.incarnationId !== incarnationId
    ) {
      return true;
    }
    return (await this.redis.exists(cancellationKey(assignmentId))) === 1;
  }

  async quarantine(
    workerId: string,
    incarnationId: string,
    runtimeSessionId?: string,
  ): Promise<void> {
    const script = [
      'redis.call(\'SET\', KEYS[2], \"1\")',
      'if #KEYS == 4 then redis.call(\'SET\', KEYS[4], \"1\") end',
      'local current = redis.call(\'GET\', KEYS[3])',
      'if current == ARGV[1] then',
      '  return redis.call(\'DEL\', KEYS[1], KEYS[3])',
      'end',
      'return 0',
    ].join('\n');
    const keys = [
      workerKey(workerId),
      quarantineKey(workerId, incarnationId),
      workerIncarnationKey(workerId),
    ];
    if (runtimeSessionId !== undefined) {
      keys.push(workspaceQuarantineKey(workerId, runtimeSessionId));
    }
    await this.redis.eval(
      script,
      keys.length,
      ...keys,
      incarnationId,
    );
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
    const closeScript = [
      'local settlement = redis.call(\'GET\', KEYS[2])',
      'if settlement then return settlement end',
      'redis.call(\'DEL\', KEYS[1])',
      'return nil',
    ].join('\n');
    const finalSettlement = await this.redis.eval(
      closeScript,
      2,
      assignmentKey(assignment.assignmentId),
      settlementKey(assignment.assignmentId),
    );
    if (finalSettlement != null) {
      return JSON.parse(String(finalSettlement)) as CodeBridgeSettlement;
    }
    throw new BridgeStoreError(
      'ASSIGNMENT_EXPIRED',
      'Bridge assignment exceeded its deadline',
    );
  }

  private async cancel(assignmentId: string): Promise<void> {
    await this.redis.set(cancellationKey(assignmentId), '1', 'EX', 30);
  }

  private async enqueueForActiveIncarnation(
    assignment: StoredAssignment,
    ttlSeconds: number,
  ): Promise<boolean> {
    const script = [
      'if redis.call(\'GET\', KEYS[1]) ~= ARGV[1] then return 0 end',
      'redis.call(\'SET\', KEYS[2], ARGV[2], \"EX\", ARGV[3])',
      'redis.call(\'RPUSH\', KEYS[3], ARGV[4])',
      'redis.call(\'EXPIRE\', KEYS[3], ARGV[3])',
      'redis.call(\'SET\', KEYS[4], ARGV[1], \"PX\", ARGV[5])',
      'return 1',
    ].join('\n');
    const result = await this.redis.eval(
      script,
      4,
      workerIncarnationKey(assignment.workerId),
      assignmentKey(assignment.assignmentId),
      queueKey(assignment.workerId, assignment.incarnationId),
      lockIncarnationKey(assignment.workerId),
      assignment.incarnationId,
      JSON.stringify(assignment),
      String(ttlSeconds),
      assignment.assignmentId,
      String(ttlSeconds * 1000),
    );
    return Number(result) === 1;
  }

  private async acquireLock(
    workerId: string,
    assignmentId: string,
    incarnationId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const script = [
      'if redis.call(\'EXISTS\', KEYS[1]) == 1 then return 0 end',
      'redis.call(\'SET\', KEYS[1], ARGV[1], \"PX\", ARGV[3])',
      'redis.call(\'SET\', KEYS[2], ARGV[2], \"PX\", ARGV[3])',
      'return 1',
    ].join('\n');
    const result = await this.redis.eval(
      script,
      2,
      lockKey(workerId),
      lockIncarnationKey(workerId),
      assignmentId,
      incarnationId,
      String(ttlSeconds * 1000),
    );
    return Number(result) === 1;
  }

  private async cleanupDispatch(
    workerId: string,
    assignmentId: string,
    assignment: StoredAssignment | undefined,
  ): Promise<void> {
    await this.cancel(assignmentId);
    if (assignment == null) {
      await this.releaseLock(workerId, assignmentId);
      return;
    }
    await this.cleanup(assignment);
  }

  private async cleanupWithRetry(
    workerId: string,
    assignmentId: string,
    assignment: StoredAssignment | undefined,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.cleanupDispatch(workerId, assignmentId, assignment);
        return;
      } catch (error) {
        lastError = error;
        await delay(25);
      }
    }
    throw lastError;
  }

  private async cleanup(assignment: StoredAssignment): Promise<void> {
    await Promise.all([
      this.redis.del(
        assignmentKey(assignment.assignmentId),
        settlementKey(assignment.assignmentId),
      ),
      this.releaseLock(assignment.workerId, assignment.assignmentId),
    ]);
  }

  private async releaseLock(
    workerId: string,
    assignmentId: string,
  ): Promise<void> {
    const script = [
      'if redis.call(\'GET\', KEYS[1]) == ARGV[1] then',
      '  return redis.call(\'DEL\', KEYS[1], KEYS[2])',
      'end',
      'return 0',
    ].join('\n');
    await this.redis.eval(
      script,
      2,
      lockKey(workerId),
      lockIncarnationKey(workerId),
      assignmentId,
    );
  }
}
