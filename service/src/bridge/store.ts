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
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;

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
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}`;
}

function workerIncarnationKey(workerId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation`;
}

function incarnationFenceKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:${incarnationId}:fenced`;
}

function quarantineKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:${incarnationId}:quarantined`;
}

function workspaceQuarantineKey(
  workerId: string,
  runtimeSessionId: string,
): string {
  const sessionHash = createHash('sha256')
    .update(runtimeSessionId)
    .digest('hex');
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:workspace:${sessionHash}:quarantined`;
}

function queueKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:${incarnationId}:assignments`;
}

function leaseClaimKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:${incarnationId}:lease-claim`;
}

function leaseAckKey(workerId: string, incarnationId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:incarnation:${incarnationId}:lease-ack`;
}

function generationKey(workerId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:generation`;
}

function lockKey(workerId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:lock`;
}

function lockIncarnationKey(workerId: string): string {
  return `${PREFIX}:worker:${encodeURIComponent(workerId)}:lock:incarnation`;
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

function signalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function boundedCommand<T>(
  command: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  void command.catch(() => undefined);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error(`${label} aborted`),
        ),
      );
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out`))),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    command.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export class RedisBridgeStore {
  constructor(
    private readonly redis: Redis,
    private readonly workerTtlSeconds = DEFAULT_WORKER_TTL_SECONDS,
    private readonly redisCommandTimeoutMs = DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  ) {}

  private async dispatchCommand<T>(
    command: () => Promise<T>,
    args: { deadlineAtMs: number; signal: AbortSignal },
    label: string,
  ): Promise<T> {
    this.assertDispatchActive(args.signal, args.deadlineAtMs);
    try {
      return await boundedCommand(
        command(),
        Math.max(
          1,
          Math.min(this.redisCommandTimeoutMs, args.deadlineAtMs - Date.now()),
        ),
        label,
        args.signal,
      );
    } catch (error) {
      this.assertDispatchActive(args.signal, args.deadlineAtMs);
      throw error;
    }
  }

  private async leaseCommand<T>(
    command: Promise<T>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    return await boundedCommand(
      command,
      this.redisCommandTimeoutMs,
      label,
      signal,
    );
  }

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
      await boundedCommand(
        this.redis.eval(
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
          `${PREFIX}:worker:${encodeURIComponent(registration.workerId)}:incarnation:`,
        ),
        this.redisCommandTimeoutMs,
        'Bridge worker registration',
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
    this.assertDispatchActive(args.signal, args.deadlineAtMs);
    let registration = await this.dispatchCommand(
      () => this.registration(args.workerId),
      args,
      'Bridge worker registration read',
    );
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
      (await this.dispatchCommand(
        () =>
          this.redis.exists(
            workspaceQuarantineKey(args.workerId, args.runtimeSessionId ?? ''),
          ),
        args,
        'Bridge workspace fence read',
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
    const lockIncarnationId = registration.incarnationId;
    let assignment: StoredAssignment | undefined;
    let resultCommitted = false;
    try {
      const locked = await this.dispatchCommand(
        () =>
          this.acquireLock(
            args.workerId,
            assignmentId,
            lockIncarnationId,
            ttlSeconds,
          ),
        args,
        'Bridge assignment lock acquisition',
      );
      if (!locked) {
        throw new BridgeStoreError(
          'WORKER_BUSY',
          `Bridge worker ${args.workerId} is busy`,
        );
      }
      this.assertDispatchActive(args.signal, args.deadlineAtMs);
      const generation = await this.dispatchCommand(
        () => this.redis.incr(generationKey(args.workerId)),
        args,
        'Bridge assignment generation allocation',
      );
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
        this.assertDispatchActive(args.signal, args.deadlineAtMs);
        assignment.incarnationId = registration.incarnationId;
        queued = await this.dispatchCommand(
          () => this.enqueueForActiveIncarnation(assignment!, ttlSeconds),
          args,
          'Bridge assignment enqueue',
        );
        if (queued) break;
        const replacement = await this.dispatchCommand(
          () => this.registration(args.workerId),
          args,
          'Bridge replacement registration read',
        );
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
      try {
        const result =
          args.finalize == null
            ? settlement
            : await args.finalize(settlement);
        await this.commitPendingWorkspace(
          assignment,
          settlement,
          args.deadlineAtMs,
          args.signal,
        );
        resultCommitted = true;
        return result;
      } catch (error) {
        if (args.runtimeSessionId !== undefined) {
          await this.quarantine(
            args.workerId,
            assignment.incarnationId,
            args.runtimeSessionId,
          );
        }
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
    let firstPoll = true;
    while (
      !signalAborted(signal) &&
      (firstPoll || Date.now() < deadline)
    ) {
      firstPoll = false;
      let assignmentId: string | null;
      try {
        assignmentId = await this.leaseCommand(
          this.claimOrPopLease(workerId, incarnationId),
          signal,
          'Bridge lease claim',
        );
      } catch (error) {
        if (signalAborted(signal)) return undefined;
        throw error;
      }
      if (assignmentId == null) {
        await delay(
          Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          signal,
        );
        continue;
      }
      try {
        const assignment = await this.leaseCommand(
          this.readAssignment(assignmentId),
          signal,
          'Bridge lease assignment read',
        );
        if (
          assignment == null ||
          assignment.workerId !== workerId ||
          assignment.incarnationId !== incarnationId
        ) {
          await this.leaseCommand(
            this.discardLeaseClaim(workerId, incarnationId, assignmentId),
            signal,
            'Bridge lease claim discard',
          );
          continue;
        }
        if (signalAborted(signal)) {
          await this.returnLease(assignment);
          return undefined;
        }
        const registration = await this.leaseCommand(
          this.registration(workerId),
          signal,
          'Bridge lease registration read',
        );
        if (registration?.incarnationId !== incarnationId) {
          throw new BridgeStoreError(
            'WORKER_FENCED',
            'Bridge worker incarnation was replaced',
          );
        }
        if (Date.parse(assignment.expiresAt) <= Date.now()) {
          const acknowledged =
            (await this.leaseCommand(
              this.redis.get(leaseAckKey(workerId, incarnationId)),
              signal,
              'Bridge lease acknowledgement read',
            )) === assignmentId;
          if (!acknowledged) {
            await this.leaseCommand(
              this.clearUndeliveredWorkspaceFence(assignment),
              signal,
              'Bridge undelivered workspace recovery',
            );
          }
          await this.leaseCommand(
            this.discardLeaseClaim(workerId, incarnationId, assignmentId),
            signal,
            'Bridge expired lease discard',
          );
          continue;
        }
        if (signalAborted(signal)) {
          await this.returnLease(assignment);
          return undefined;
        }
        const { leaseTokenHash: _leaseTokenHash, ...wireAssignment } = assignment;
        return {
          ...wireAssignment,
          remainingMs: Math.max(
            0,
            Date.parse(assignment.expiresAt) - Date.now(),
          ),
        };
      } catch (error) {
        await this.returnLeaseByIdWithRetry(
          workerId,
          incarnationId,
          assignmentId,
        );
        if (signalAborted(signal)) return undefined;
        throw error;
      }
    }
    return undefined;
  }

  async acknowledgeLease(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
    generation: number,
    leaseToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const assignment = await this.leaseCommand(
      this.readAssignment(assignmentId),
      signal,
      'Bridge acknowledgement assignment read',
    );
    const registration = await this.leaseCommand(
      this.registration(workerId),
      signal,
      'Bridge acknowledgement registration read',
    );
    if (
      assignment == null ||
      assignment.workerId !== workerId ||
      assignment.incarnationId !== incarnationId ||
      registration?.incarnationId !== incarnationId ||
      assignment.generation !== generation ||
      tokenHash(leaseToken) !== assignment.leaseTokenHash
    ) {
      throw new BridgeStoreError(
        'ASSIGNMENT_FENCED',
        'Bridge assignment lease acknowledgement is stale',
      );
    }
    const ttlSeconds = assignmentTtlSeconds(Date.parse(assignment.expiresAt));
    const acknowledged = Number(
      await this.leaseCommand(
        this.redis.eval(
          [
            "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
            "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])",
            'return 1',
          ].join('\n'),
          2,
          leaseClaimKey(workerId, incarnationId),
          leaseAckKey(workerId, incarnationId),
          assignmentId,
          String(ttlSeconds),
        ),
        signal,
        'Bridge lease acknowledgement',
      ),
    );
    if (acknowledged !== 1) {
      throw new BridgeStoreError(
        'ASSIGNMENT_FENCED',
        'Bridge assignment is not the active lease claim',
      );
    }
  }

  private async claimOrPopLease(
    workerId: string,
    incarnationId: string,
  ): Promise<string | null> {
    const result = await this.redis.eval(
      [
        "local claimed = redis.call('GET', KEYS[2])",
        'if claimed then return claimed end',
        "local ttl = redis.call('TTL', KEYS[1])",
        "local assignment = redis.call('LPOP', KEYS[1])",
        'if not assignment then return nil end',
        "redis.call('SET', KEYS[2], assignment, 'EX', math.max(1, ttl))",
        'return assignment',
      ].join('\n'),
      2,
      queueKey(workerId, incarnationId),
      leaseClaimKey(workerId, incarnationId),
    );
    return result == null ? null : String(result);
  }

  private async discardLeaseClaim(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
  ): Promise<void> {
    await this.redis.eval(
      [
        "if redis.call('GET', KEYS[1]) == ARGV[1] then",
        "  return redis.call('DEL', KEYS[1], KEYS[2])",
        'end',
        'return 0',
      ].join('\n'),
      2,
      leaseClaimKey(workerId, incarnationId),
      leaseAckKey(workerId, incarnationId),
      assignmentId,
    );
  }

  async returnLease(assignment: CodeBridgeAssignment): Promise<void> {
    await this.returnLeaseById(
      assignment.workerId,
      assignment.incarnationId,
      assignment.assignmentId,
    );
  }

  private async returnLeaseById(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
  ): Promise<void> {
    await boundedCommand(
      this.redis.eval(
        [
          "if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end",
          "if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end",
          "local ttl = redis.call('TTL', KEYS[1])",
          "redis.call('DEL', KEYS[3], KEYS[4])",
          "redis.call('LREM', KEYS[2], 0, ARGV[1])",
          "redis.call('LPUSH', KEYS[2], ARGV[1])",
          "if ttl > 0 then redis.call('EXPIRE', KEYS[2], ttl) end",
          'return 1',
        ].join('\n'),
        4,
        assignmentKey(assignmentId),
        queueKey(workerId, incarnationId),
        leaseClaimKey(workerId, incarnationId),
        leaseAckKey(workerId, incarnationId),
        assignmentId,
      ),
      this.redisCommandTimeoutMs,
      'Bridge lease return',
    );
  }

  private async returnLeaseByIdWithRetry(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.returnLeaseById(workerId, incarnationId, assignmentId);
        return;
      } catch (error) {
        lastError = error;
        await delay(25);
      }
    }
    throw lastError;
  }

  private async clearUndeliveredWorkspaceFence(
    assignment: StoredAssignment,
  ): Promise<void> {
    if (assignment.runtimeSessionId === undefined) return;
    await this.redis.eval(
      [
        "if redis.call('GET', KEYS[1]) == ARGV[1] then",
        "  return redis.call('DEL', KEYS[1])",
        'end',
        'return 0',
      ].join('\n'),
      1,
      workspaceQuarantineKey(
        assignment.workerId,
        assignment.runtimeSessionId,
      ),
      assignment.assignmentId,
    );
  }

  async settle(
    workerId: string,
    assignmentId: string,
    settlement: CodeBridgeSettlement,
    signal?: AbortSignal,
  ): Promise<void> {
    const serializedSettlement = JSON.stringify(settlement);
    const existingSettlement = await this.leaseCommand(
      this.redis.get(settlementKey(assignmentId)),
      signal,
      'Bridge settlement existing read',
    );
    if (existingSettlement === serializedSettlement) return;
    if (existingSettlement != null) {
      throw new BridgeStoreError(
        'ASSIGNMENT_FENCED',
        'Bridge assignment was already settled with a different result',
      );
    }
    const assignment = await this.leaseCommand(
      this.readAssignment(assignmentId),
      signal,
      'Bridge settlement assignment read',
    );
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
    const registration = await this.leaseCommand(
      this.registration(workerId),
      signal,
      'Bridge settlement registration read',
    );
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
    if (
      settlement.status !== 'rejected' &&
      Date.parse(assignment.expiresAt) <= Date.now()
    ) {
      throw new BridgeStoreError(
        'ASSIGNMENT_EXPIRED',
        'Bridge assignment has expired',
      );
    }
    const ttlSeconds = assignmentTtlSeconds(Date.parse(assignment.expiresAt));
    const settlementKeys = [
      assignmentKey(assignmentId),
      settlementKey(assignmentId),
      leaseClaimKey(workerId, assignment.incarnationId),
      leaseAckKey(workerId, assignment.incarnationId),
    ];
    if (assignment.runtimeSessionId !== undefined) {
      settlementKeys.push(
        workspaceQuarantineKey(workerId, assignment.runtimeSessionId),
      );
    }
    const script = [
      'local existing = redis.call(\'GET\', KEYS[2])',
      'if existing then',
      '  if existing == ARGV[1] then return 2 end',
      '  return -1',
      'end',
      'if redis.call(\'EXISTS\', KEYS[1]) == 0 then return 0 end',
      'if #KEYS == 5 and redis.call(\'GET\', KEYS[5]) ~= ARGV[3] then return -2 end',
      'redis.call(\'SET\', KEYS[2], ARGV[1], \"EX\", ARGV[2])',
      'if redis.call(\'GET\', KEYS[3]) == ARGV[3] then redis.call(\'DEL\', KEYS[3], KEYS[4]) end',
      'if #KEYS == 5 and ARGV[4] == \"rejected\" then redis.call(\'DEL\', KEYS[5]) end',
      'return 1',
    ].join('\n');
    const accepted = Number(
      await this.leaseCommand(
        this.redis.eval(
          script,
          settlementKeys.length,
          ...settlementKeys,
          serializedSettlement,
          String(ttlSeconds),
          assignmentId,
          settlement.status,
        ),
        signal,
        'Bridge settlement commit',
      ),
    );
    if (accepted === -1) {
      throw new BridgeStoreError(
        'ASSIGNMENT_FENCED',
        'Bridge assignment was already settled with a different result',
      );
    }
    if (accepted === -2) {
      throw new BridgeStoreError(
        'WORKSPACE_QUARANTINED',
        'Bridge workspace in-flight marker was lost before settlement',
      );
    }
    if (accepted !== 1 && accepted !== 2) {
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    const assignment = await this.leaseCommand(
      this.readAssignment(assignmentId),
      signal,
      'Bridge cancellation assignment read',
    );
    const registration = await this.leaseCommand(
      this.registration(workerId),
      signal,
      'Bridge cancellation registration read',
    );
    if (
      assignment == null ||
      assignment.workerId !== workerId ||
      assignment.incarnationId !== incarnationId ||
      registration?.incarnationId !== incarnationId
    ) {
      return true;
    }
    return (
      (await this.leaseCommand(
        this.redis.exists(cancellationKey(assignmentId)),
        signal,
        'Bridge cancellation marker read',
      )) === 1
    );
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
    await boundedCommand(
      this.redis.eval(
        script,
        keys.length,
        ...keys,
        incarnationId,
      ),
      this.redisCommandTimeoutMs,
      'Bridge worker quarantine',
    );
  }

  async resetWorkspace(
    workerId: string,
    incarnationId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    const result = Number(
      await this.redis.eval(
        [
          "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end",
          "if redis.call('EXISTS', KEYS[2]) == 1 then return -2 end",
          "redis.call('DEL', KEYS[3])",
          'return 1',
        ].join('\n'),
        3,
        workerIncarnationKey(workerId),
        lockKey(workerId),
        workspaceQuarantineKey(workerId, runtimeSessionId),
        incarnationId,
      ),
    );
    if (result === -1) {
      throw new BridgeStoreError(
        'WORKER_FENCED',
        'Only the active bridge worker incarnation can reset a workspace',
      );
    }
    if (result === -2) {
      throw new BridgeStoreError(
        'WORKER_BUSY',
        'Bridge workspace cannot be reset while worker execution is active',
      );
    }
  }

  private async registration(
    workerId: string,
  ): Promise<BridgeWorkerRegistration | undefined> {
    const raw = await this.redis.get(workerKey(workerId));
    return raw == null ? undefined : (JSON.parse(raw) as BridgeWorkerRegistration);
  }

  private assertDispatchActive(
    signal: AbortSignal,
    deadlineAtMs: number,
  ): void {
    if (signal.aborted || Date.now() >= deadlineAtMs) {
      throw new BridgeStoreError(
        'ASSIGNMENT_EXPIRED',
        'Bridge assignment ended before it could be delivered',
      );
    }
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
      const raw = await boundedCommand(
        this.redis.get(settlementKey(assignment.assignmentId)),
        Math.max(
          1,
          Math.min(this.redisCommandTimeoutMs, deadlineAtMs - Date.now()),
        ),
        'Bridge settlement poll',
        signal,
      );
      if (raw != null) return JSON.parse(raw) as CodeBridgeSettlement;
      await delay(POLL_INTERVAL_MS, signal);
    }
    const closeKeys = [
      assignmentKey(assignment.assignmentId),
      settlementKey(assignment.assignmentId),
    ];
    if (assignment.runtimeSessionId !== undefined) {
      closeKeys.push(
        workspaceQuarantineKey(
          assignment.workerId,
          assignment.runtimeSessionId,
        ),
      );
    }
    const closeScript = [
      'local settlement = redis.call(\'GET\', KEYS[2])',
      'if settlement then return settlement end',
      'if #KEYS == 3 and redis.call(\'GET\', KEYS[3]) == ARGV[1] then return nil end',
      'redis.call(\'DEL\', KEYS[1])',
      'return nil',
    ].join('\n');
    const finalSettlement = await boundedCommand(
      this.redis.eval(
        closeScript,
        closeKeys.length,
        ...closeKeys,
        assignment.assignmentId,
      ),
      this.redisCommandTimeoutMs,
      'Bridge settlement close',
    );
    if (finalSettlement != null) {
      return JSON.parse(String(finalSettlement)) as CodeBridgeSettlement;
    }
    throw new BridgeStoreError(
      'ASSIGNMENT_EXPIRED',
      'Bridge assignment exceeded its deadline',
    );
  }

  private async cancel(
    assignmentId: string,
    assignment?: StoredAssignment,
  ): Promise<void> {
    const ttlSeconds =
      assignment == null
        ? 30
        : assignmentTtlSeconds(Date.parse(assignment.expiresAt));
    await boundedCommand(
      this.redis.set(
        cancellationKey(assignmentId),
        '1',
        'EX',
        ttlSeconds,
      ),
      this.redisCommandTimeoutMs,
      'Bridge assignment cancellation',
    );
  }

  private async enqueueForActiveIncarnation(
    assignment: StoredAssignment,
    ttlSeconds: number,
  ): Promise<boolean> {
    const script = [
      'if redis.call(\'GET\', KEYS[1]) ~= ARGV[1] then return 0 end',
      'if #KEYS == 5 and redis.call(\'EXISTS\', KEYS[5]) == 1 then return -1 end',
      'redis.call(\'SET\', KEYS[2], ARGV[2], \"EX\", ARGV[3])',
      'redis.call(\'RPUSH\', KEYS[3], ARGV[4])',
      'redis.call(\'EXPIRE\', KEYS[3], ARGV[3])',
      'redis.call(\'SET\', KEYS[4], ARGV[1], \"PX\", ARGV[5])',
      'if #KEYS == 5 then redis.call(\'SET\', KEYS[5], ARGV[4]) end',
      'return 1',
    ].join('\n');
    const keys = [
      workerIncarnationKey(assignment.workerId),
      assignmentKey(assignment.assignmentId),
      queueKey(assignment.workerId, assignment.incarnationId),
      lockIncarnationKey(assignment.workerId),
    ];
    if (assignment.runtimeSessionId !== undefined) {
      keys.push(
        workspaceQuarantineKey(
          assignment.workerId,
          assignment.runtimeSessionId,
        ),
      );
    }
    const result = await this.redis.eval(
      script,
      keys.length,
      ...keys,
      assignment.incarnationId,
      JSON.stringify(assignment),
      String(ttlSeconds),
      assignment.assignmentId,
      String(ttlSeconds * 1000),
    );
    if (Number(result) === -1) {
      throw new BridgeStoreError(
        'WORKSPACE_QUARANTINED',
        'Bridge workspace already has incomplete stateful work',
      );
    }
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
    await Promise.all([
      this.cancel(assignmentId, assignment),
      assignment == null
        ? boundedCommand(
            this.releaseLock(workerId, assignmentId),
            this.redisCommandTimeoutMs,
            'Bridge assignment lock release',
          )
        : this.cleanup(assignment),
    ]);
  }

  private async commitPendingWorkspace(
    assignment: StoredAssignment,
    settlement: CodeBridgeSettlement,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      assignment.runtimeSessionId === undefined ||
      settlement.status !== 'fulfilled'
    ) {
      return;
    }
    const runtimeSessionId = assignment.runtimeSessionId;
    const script = [
      'if redis.call(\'GET\', KEYS[1]) == ARGV[1] then',
      '  return redis.call(\'DEL\', KEYS[1])',
      'end',
      'return 0',
    ].join('\n');
    const committed = Number(
      await boundedCommand(
        this.redis.eval(
          script,
          1,
          workspaceQuarantineKey(
            assignment.workerId,
            runtimeSessionId,
          ),
          assignment.assignmentId,
        ),
        Math.max(
          1,
          Math.min(this.redisCommandTimeoutMs, deadlineAtMs - Date.now()),
        ),
        'Bridge workspace commit',
        signal,
      ),
    );
    if (committed !== 1) {
      throw new BridgeStoreError(
        'WORKSPACE_QUARANTINED',
        'Bridge workspace commit marker was lost before finalization completed',
      );
    }
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
    const keys = [
      assignmentKey(assignment.assignmentId),
      queueKey(assignment.workerId, assignment.incarnationId),
      leaseClaimKey(assignment.workerId, assignment.incarnationId),
      leaseAckKey(assignment.workerId, assignment.incarnationId),
      assignment.runtimeSessionId === undefined
        ? `${assignmentKey(assignment.assignmentId)}:no-workspace`
        : workspaceQuarantineKey(
            assignment.workerId,
            assignment.runtimeSessionId,
          ),
    ];
    const cleanupScript = [
      "local queued = redis.call('LREM', KEYS[2], 0, ARGV[1])",
      "local claimed = redis.call('GET', KEYS[3]) == ARGV[1]",
      "local acknowledged = redis.call('GET', KEYS[4]) == ARGV[1]",
      'if ARGV[2] == "1" and (queued > 0 or (claimed and not acknowledged)) and redis.call(\'GET\', KEYS[5]) == ARGV[1] then',
      "  redis.call('DEL', KEYS[5])",
      'end',
      'if claimed and not acknowledged then',
      "  redis.call('DEL', KEYS[3], KEYS[4])",
      'end',
      'if queued == 0 and acknowledged and ARGV[2] == "1" and redis.call(\'GET\', KEYS[5]) == ARGV[1] then',
      '  return -1',
      'end',
      "return redis.call('DEL', KEYS[1], KEYS[3], KEYS[4])",
    ].join('\n');
    const cleanupResult = Number(
      await boundedCommand(
        this.redis.eval(
          cleanupScript,
          keys.length,
          ...keys,
          assignment.assignmentId,
          assignment.runtimeSessionId === undefined ? '0' : '1',
        ),
        this.redisCommandTimeoutMs,
        'Bridge assignment cleanup',
      ),
    );
    if (cleanupResult !== -1) {
      await boundedCommand(
        this.releaseLock(assignment.workerId, assignment.assignmentId),
        this.redisCommandTimeoutMs,
        'Bridge assignment lock release',
      );
    }
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
