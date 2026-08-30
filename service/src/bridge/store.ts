import { createHash, randomBytes } from 'crypto';

import type Redis from 'ioredis';
import type * as t from '../types';
import type {
  BridgeAssignment,
  BridgeSettlement,
  BridgeWorkerRegistration,
} from '../../../packages/code/src/protocol';

import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import type { BridgeWorkerBinding } from './pairing';

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
      | 'WORKER_UNAUTHORIZED'
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
  workerIdentityId?: string;
}

export interface RegisteredBridgeWorker extends BridgeWorkerRegistration {
  binding?: BridgeWorkerBinding;
  credentialId?: string;
  identityId?: string;
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

function queuedAssignment(
  assignmentId: string,
  workerIdentityId?: string,
): string {
  const identity = workerIdentityId ?? '';
  return `${identity.length}:${identity}${assignmentId}`;
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

  async register(registration: RegisteredBridgeWorker): Promise<void> {
    const script = [
      'if redis.call(\'EXISTS\', KEYS[3]) == 1 then return -2 end',
      'if redis.call(\'EXISTS\', KEYS[2]) == 1 then return -1 end',
      'local current = redis.call(\'GET\', KEYS[4])',
      'if current then',
      '  if current ~= ARGV[1] then',
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
        4,
        workerKey(registration.workerId),
        incarnationFenceKey(registration.workerId, registration.incarnationId),
        quarantineKey(registration.workerId, registration.incarnationId),
        workerIncarnationKey(registration.workerId),
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
  }

  async dispatch(args: {
    workerId: string;
    tenantId?: string;
    requireTenantBinding?: boolean;
    body: t.PayloadBody;
    headers: Record<string, string>;
    runtimeSessionId?: string;
    deadlineAtMs: number;
    signal: AbortSignal;
    finalize?: (
      settlement: CodeBridgeSettlement,
    ) => Promise<CodeBridgeSettlement>;
  }): Promise<CodeBridgeSettlement> {
    const registration = await this.registration(args.workerId);
    if (registration == null) {
      throw new BridgeStoreError(
        'WORKER_OFFLINE',
        `Bridge worker ${args.workerId} is offline`,
      );
    }
    if (
      (args.requireTenantBinding === true && registration.binding == null) ||
      (registration.binding != null &&
        (args.tenantId == null ||
          args.tenantId.length === 0 ||
          registration.binding.tenantId !== args.tenantId))
    ) {
      throw new BridgeStoreError(
        'WORKER_UNAUTHORIZED',
        `Bridge worker ${args.workerId} is not authorized for this tenant`,
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

    let assignment: StoredAssignment | undefined;
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
        ...(registration.identityId != null
          ? { workerIdentityId: registration.identityId }
          : {}),
        expiresAt: new Date(args.deadlineAtMs).toISOString(),
        runtimeSessionId: args.runtimeSessionId,
        request: {
          body: args.body,
          headers: args.headers,
        },
      };
      const transaction = this.redis.multi();
      transaction.set(
        assignmentKey(assignmentId),
        JSON.stringify(assignment),
        'EX',
        ttlSeconds,
      );
      transaction.rpush(
        queueKey(args.workerId),
        queuedAssignment(assignmentId, assignment.workerIdentityId),
      );
      transaction.expire(queueKey(args.workerId), ttlSeconds);
      await transaction.exec();
      const settlement = await this.waitForSettlement(
        assignment,
        args.deadlineAtMs,
        args.signal,
      );
      if (args.finalize == null) return settlement;
      try {
        return await args.finalize(settlement);
      } catch (error) {
        await this.quarantine(args.workerId, registration.incarnationId);
        if (args.runtimeSessionId !== undefined) {
          await this.redis.set(
            workspaceQuarantineKey(args.workerId, args.runtimeSessionId),
            '1',
          );
        }
        throw error;
      }
    } finally {
      await this.cancel(assignmentId);
      if (assignment == null) {
        await this.releaseLock(args.workerId, assignmentId);
      } else {
        await this.cleanup(assignment);
      }
    }
  }

  async lease(
    workerId: string,
    incarnationId: string,
    waitMs: number,
    signal?: AbortSignal,
    identityId?: string,
  ): Promise<CodeBridgeAssignment | undefined> {
    const deadline = Date.now() + waitMs;
    while (signal?.aborted !== true && Date.now() < deadline) {
      const raw = await this.redis.eval(
        [
          "local entries = redis.call('LRANGE', KEYS[1], 0, -1)",
          'for _, entry in ipairs(entries) do',
          "  local separator = string.find(entry, ':', 1, true)",
          '  local id = nil',
          "  local identity = ''",
          '  if separator then',
          '    local identityLength = tonumber(string.sub(entry, 1, separator - 1))',
          '    if identityLength then',
          '      identity = string.sub(entry, separator + 1, separator + identityLength)',
          '      id = string.sub(entry, separator + identityLength + 1)',
          '    end',
          "  elseif ARGV[3] == '' then",
          '    id = entry',
          '  end',
          '  if id and identity == ARGV[3] then',
          "  local raw = redis.call('GET', ARGV[1] .. id)",
          '  if not raw then',
          "    redis.call('LREM', KEYS[1], 1, entry)",
          '  else',
          "      redis.call('LREM', KEYS[1], 1, entry)",
          '      return raw',
          '  end',
          '  end',
          'end',
          'return nil',
        ].join('\n'),
        1,
        queueKey(workerId),
        `${PREFIX}:assignment:`,
        workerId,
        identityId ?? '',
      );
      if (raw == null) {
        await delay(
          Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          signal,
        );
        continue;
      }
      const assignment = JSON.parse(String(raw)) as StoredAssignment;
      if (assignment.incarnationId !== incarnationId) continue;
      const registration = await this.registration(workerId);
      if (registration?.incarnationId !== incarnationId) {
        throw new BridgeStoreError(
          'WORKER_FENCED',
          'Bridge worker incarnation was replaced',
        );
      }
      if (
        assignment.workerId !== workerId ||
        assignment.workerIdentityId !== identityId
      ) {
        continue;
      }
      if (Date.parse(assignment.expiresAt) <= Date.now()) continue;
      const {
        leaseTokenHash: _leaseTokenHash,
        workerIdentityId: _workerIdentityId,
        ...wireAssignment
      } = assignment;
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
    await this.redis.set(
      settlementKey(assignmentId),
      JSON.stringify(settlement),
      'EX',
      ttlSeconds,
    );
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

  async quarantine(workerId: string, incarnationId: string): Promise<void> {
    const script = [
      'redis.call(\'SET\', KEYS[2], \"1\")',
      'local current = redis.call(\'GET\', KEYS[3])',
      'if current == ARGV[1] then',
      '  return redis.call(\'DEL\', KEYS[1], KEYS[3])',
      'end',
      'return 0',
    ].join('\n');
    await this.redis.eval(
      script,
      3,
      workerKey(workerId),
      quarantineKey(workerId, incarnationId),
      workerIncarnationKey(workerId),
      incarnationId,
    );
  }

  private async registration(
    workerId: string,
  ): Promise<RegisteredBridgeWorker | undefined> {
    const raw = await this.redis.get(workerKey(workerId));
    return raw == null ? undefined : (JSON.parse(raw) as RegisteredBridgeWorker);
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
      '  return redis.call(\'DEL\', KEYS[1])',
      'end',
      'return 0',
    ].join('\n');
    await this.redis.eval(script, 1, lockKey(workerId), assignmentId);
  }
}
