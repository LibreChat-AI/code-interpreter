import { createHash, randomBytes } from 'crypto';
import type Redis from 'ioredis';
import type { WorkspaceToolRequest, WorkspaceToolResult } from '../../../packages/code/src/protocol';
import type { RedisBridgeStore, RegisteredBridgeWorker, DurableWorkspaceAssignment, CodeBridgeWorkspaceSettlement } from '../bridge/store';
import { BridgeAdmissionQueue } from '../bridge/admission';
import { BridgeStoreError, workspaceAdmissionId } from '../bridge/store';

const PREFIX = 'codeapi:workspace-requests:v1';
const ACTIVE = `${PREFIX}:active`;
const RETENTION_MS = 24 * 60 * 60_000;
const CLAIM_MS = 10_000;
export const WORKSPACE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export class WorkspaceRequestConflict extends Error {}

export interface WorkspaceRequestOwner {
  tenantId: string;
  userId: string;
}

export interface StoredWorkspaceRequest {
  id: string;
  key: string;
  fingerprint: string;
  workerId: string;
  tenantId: string;
  requireTenantBinding: boolean;
  request: WorkspaceToolRequest;
  registration: RegisteredBridgeWorker;
  createdAtMs: number;
  queueDeadlineAtMs: number;
  executionTimeoutMs: number;
  assignment?: DurableWorkspaceAssignment;
  settlement?: CodeBridgeWorkspaceSettlement;
  admittedAtMs?: number;
  finishedAtMs?: number;
  state: 'queued' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  cancelRequested?: boolean;
  result?: WorkspaceToolResult;
  error?: { code: string; message: string };
}

export interface WorkspaceRequestStatus {
  requestId: string;
  state: StoredWorkspaceRequest['state'];
  workerId: string;
  workspaceId: string;
  workspaceInstanceId?: string;
  worktree?: string;
  queuePosition?: number;
  queueWaitMs: number;
  executionDeadlineAt?: string;
  cancelRequested: boolean;
  result?: WorkspaceToolResult;
  error?: StoredWorkspaceRequest['error'];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Durable workspace transition timed out')), 8_000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

function requestKey(owner: WorkspaceRequestOwner, requestId: string, scope: string): string {
  return `${PREFIX}:${createHash('sha256').update(canonical([scope, owner.tenantId, owner.userId, requestId])).digest('hex')}`;
}

/** Redis owns requests; API replicas only advance bounded, fenced transitions. */
export class RedisWorkspaceRequests {
  private readonly activeKey: string;
  constructor(
    private readonly redis: Redis,
    private readonly bridge: RedisBridgeStore,
    private readonly transition?: (record: StoredWorkspaceRequest) => void,
    private readonly scope = '',
  ) {
    this.activeKey = scope.length === 0 ? ACTIVE : `${PREFIX}:${scope}:active`;
  }

  async submit(args: {
    owner: WorkspaceRequestOwner;
    requestId: string;
    workerId: string;
    requireTenantBinding: boolean;
    request: WorkspaceToolRequest;
    queueWaitMs: number;
    executionTimeoutMs: number;
  }): Promise<WorkspaceRequestStatus> {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(args.requestId)) {
      throw new BridgeStoreError('ASSIGNMENT_INVALID', 'Invalid durable workspace request ID');
    }
    const key = requestKey(args.owner, args.requestId, this.scope);
    const fingerprint = createHash('sha256').update(canonical({
      workerId: args.workerId, request: args.request,
      queueWaitMs: args.queueWaitMs, executionTimeoutMs: args.executionTimeoutMs,
      requireTenantBinding: args.requireTenantBinding,
    })).digest('hex');
    const existing = await this.read(key);
    if (existing != null) {
      if (existing.fingerprint !== fingerprint) throw new WorkspaceRequestConflict('Request ID was already used for different work');
      return this.status(existing, args.requestId);
    }
    const registration = await this.bridge.prepareDurableWorkspaceTool({
      ...args, tenantId: args.owner.tenantId,
    });
    const now = Date.now();
    const record: StoredWorkspaceRequest = {
      id: `durable-${randomBytes(18).toString('base64url')}`, key, fingerprint,
      workerId: args.workerId, tenantId: args.owner.tenantId,
      requireTenantBinding: args.requireTenantBinding,
      request: args.request, registration, createdAtMs: now,
      queueDeadlineAtMs: now + args.queueWaitMs,
      executionTimeoutMs: args.executionTimeoutMs, state: 'queued',
    };
    const queue = new BridgeAdmissionQueue(this.redis);
    const accepted = await queue.submit({
      workerId: record.workerId, id: record.id, deadlineAtMs: record.queueDeadlineAtMs,
      workspaceId: (registration.capabilities.workspaceLeaseSlots ?? 1) > 1
        ? workspaceAdmissionId(record.request.workspaceId, record.request.workspaceInstanceId, record.request.worktree)
        : undefined,
      key, activeKey: this.activeKey, fingerprint, record: JSON.stringify(record), retentionMs: RETENTION_MS,
    });
    if (accepted === 'conflict') throw new WorkspaceRequestConflict('Request ID was already used for different work');
    if (accepted === 'full') throw new BridgeStoreError('WORKER_QUEUE_FULL', 'Bridge worker pending request limit reached');
    const submitted = (await this.read(key))!;
    if (accepted === 'accepted') this.transition?.(submitted);
    return this.status(submitted, args.requestId);
  }

  async get(owner: WorkspaceRequestOwner, requestId: string): Promise<WorkspaceRequestStatus | undefined> {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId)) return undefined;
    const record = await this.read(requestKey(owner, requestId, this.scope));
    return record == null ? undefined : this.status(record, requestId);
  }

  async cancel(owner: WorkspaceRequestOwner, requestId: string): Promise<WorkspaceRequestStatus | undefined> {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId)) return undefined;
    const key = requestKey(owner, requestId, this.scope);
    await this.redis.eval([
      'local state = redis.call(\'HGET\', KEYS[1], \'state\')',
      'if state ~= \'queued\' and state ~= \'admitted\' then return 0 end',
      'redis.call(\'HSET\', KEYS[1], \'cancelRequested\', \'1\')',
      'redis.call(\'ZADD\', KEYS[2], ARGV[1], KEYS[1])',
      'return 1',
    ].join('\n'), 2, key, this.activeKey, Date.now());
    return this.get(owner, requestId);
  }

  private async read(key: string): Promise<StoredWorkspaceRequest | undefined> {
    const fields: Partial<Record<string, string>> = await this.redis.hgetall(key);
    if (fields.record == null) return undefined;
    return {
      ...JSON.parse(fields.record) as StoredWorkspaceRequest,
      ...(fields.outcome == null ? {} : JSON.parse(fields.outcome)),
      state: fields.state as StoredWorkspaceRequest['state'],
      assignment: fields.assignment == null ? undefined : JSON.parse(fields.assignment),
      admittedAtMs: fields.admittedAtMs == null ? undefined : Number(fields.admittedAtMs),
      cancelRequested: fields.cancelRequested === '1',
    };
  }

  private async status(record: StoredWorkspaceRequest, requestId: string): Promise<WorkspaceRequestStatus> {
    const rank = record.state === 'queued'
      ? await new BridgeAdmissionQueue(this.redis).position(record.workerId, record.id)
      : undefined;
    return {
      requestId, state: record.state, workerId: record.workerId,
      workspaceId: record.request.workspaceId,
      workspaceInstanceId: record.request.workspaceInstanceId, worktree: record.request.worktree,
      queuePosition: rank, queueWaitMs: Math.max(0, (record.admittedAtMs ?? Math.min(record.finishedAtMs ?? Date.now(), record.queueDeadlineAtMs)) - record.createdAtMs),
      executionDeadlineAt: record.assignment?.expiresAt,
      cancelRequested: record.cancelRequested === true,
      result: record.result, error: record.error,
    };
  }

  async reconcile(): Promise<void> {
    const keys = await deadline(this.redis.zrangebyscore(this.activeKey, '-inf', Date.now(), 'LIMIT', 0, 32));
    const results = await Promise.allSettled(keys.map(key => deadline(this.advance(key))));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async advance(key: string): Promise<void> {
    const claimKey = `${key}:claim`;
    const token = randomBytes(18).toString('hex');
    const claimed = await this.redis.eval([
      'if not redis.call(\'SET\', KEYS[1], ARGV[1], \'PX\', ARGV[2], \'NX\') then return 0 end',
      'redis.call(\'ZADD\', KEYS[2], ARGV[3], KEYS[3])',
      'return 1',
    ].join('\n'), 3, claimKey, this.activeKey, key, token, CLAIM_MS, Date.now() + CLAIM_MS);
    if (Number(claimed) !== 1) return;
    try {
      let record = await this.read(key);
      if (record == null) { await this.redis.zrem(this.activeKey, key); return; }
      if (record.state === 'queued' || record.state === 'admitted') {
        const previousState = record.state;
        try {
          const outcome = await deadline(this.bridge.advanceDurableWorkspaceTool(record, { key, claimKey, token }));
          if (outcome != null) {
            await this.redis.eval([
              'if redis.call(\'GET\', KEYS[2]) ~= ARGV[1] then return 0 end',
              'local state = redis.call(\'HGET\', KEYS[1], \'state\')',
              'if state ~= \'queued\' and state ~= \'admitted\' then return 0 end',
              'redis.call(\'HSET\', KEYS[1], \'state\', ARGV[3], \'outcome\', ARGV[2])',
              'return 1',
            ].join('\n'), 2, key, claimKey, token, JSON.stringify({ ...outcome, finishedAtMs: Date.now() }), outcome.state);
          }
        } catch (error) {
          // Infrastructure uncertainty is reconciled, never retried as a new command.
          if (!(error instanceof BridgeStoreError)) throw error;
          if (error.code === 'WORKER_OFFLINE') {
            // The original worker may reconnect within the remaining admission budget.
            await this.redis.zadd(this.activeKey, Date.now() + 250, key);
            return;
          }
          const current = await this.read(key);
          if (current?.state === 'admitted') throw error;
          await this.redis.eval([
            'if redis.call(\'GET\', KEYS[2]) ~= ARGV[1] then return 0 end',
            'if redis.call(\'HGET\', KEYS[1], \'state\') ~= \'queued\' then return 0 end',
            'redis.call(\'HSET\', KEYS[1], \'state\', \'failed\', \'outcome\', ARGV[2])',
            'return 1',
          ].join('\n'), 2, key, claimKey, token, JSON.stringify({ state: 'failed', finishedAtMs: Date.now(), error: { code: error.code, message: error.message } }));
        }
        record = (await this.read(key))!;
        if (record.state !== previousState) this.transition?.(record);
      }
      if (record.state !== 'queued' && record.state !== 'admitted') {
        await deadline(this.bridge.finishDurableWorkspaceTool(record));
        await this.redis.zrem(this.activeKey, key);
      } else {
        await this.redis.zadd(this.activeKey, Date.now() + 250, key);
      }
    } finally {
      await this.redis.eval('if redis.call(\'GET\', KEYS[1]) == ARGV[1] then return redis.call(\'DEL\', KEYS[1]) end return 0', 1, claimKey, token);
    }
  }
}
