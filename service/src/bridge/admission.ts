import type Redis from 'ioredis';

/** Redis time and claim ownership gate every durable admission mutation. */
export function durableAdmissionFence(
  requestKey: string,
  claimKey: string,
  token: string,
  rejected: number,
): string[] {
  return [
    `if redis.call('GET', ${claimKey}) ~= ${token} then return ${rejected} end`,
    `if redis.call('HGET', ${requestKey}, 'state') ~= 'queued' then return ${rejected} end`,
    `if redis.call('HGET', ${requestKey}, 'cancelRequested') == '1' then return ${rejected} end`,
    'local admissionTime = redis.call(\'TIME\')',
    'local admissionNowMs = tonumber(admissionTime[1]) * 1000.0 + math.floor(tonumber(admissionTime[2]) / 1000)',
    `if tonumber(redis.call('HGET', ${requestKey}, 'queueDeadlineAtMs')) <= admissionNowMs then return ${rejected} end`,
  ];
}

/** Bounded FIFO admission shared by API replicas. Entries expire after caller deadlines. */
export class BridgeAdmissionQueue {
  constructor(
    private readonly redis: Redis,
    private readonly capacity = 32,
  ) {}

  private keys(workerId: string): [string, string, string, string] {
    const prefix = `codeapi:bridge:v1:worker:${encodeURIComponent(workerId)}:admission`;
    return [
      prefix,
      `${prefix}:deadlines`,
      `${prefix}:sequence`,
      `${prefix}:workspaces`,
    ];
  }

  async enter(
    workerId: string,
    id: string,
    deadlineAtMs: number,
    workspaceId?: string,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          [
            "local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])",
            'for _, id in ipairs(expired) do',
            "  redis.call('ZREM', KEYS[1], id)",
            "  redis.call('ZREM', KEYS[2], id)",
            "  redis.call('HDEL', KEYS[4], id)",
            'end',
            "if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end",
            "if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end",
            "local sequence = redis.call('INCR', KEYS[3])",
            "redis.call('ZADD', KEYS[1], sequence, ARGV[1])",
            "redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])",
            "if ARGV[5] ~= '' then redis.call('HSET', KEYS[4], ARGV[1], ARGV[5]) end",
            "local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')",
            'for _, key in ipairs(KEYS) do',
            "  redis.call('PEXPIREAT', key, tonumber(latest[2]) + 30000)",
            'end',
            'return 1',
          ].join('\n'),
          4,
          ...this.keys(workerId),
          id,
          Date.now(),
          deadlineAtMs,
          this.capacity,
          workspaceId ?? '',
        ),
      ) === 1
    );
  }

  async submit(args: {
    workerId: string; id: string; deadlineAtMs: number; workspaceId?: string;
    key: string; activeKey: string; fingerprint: string; record: string; retentionMs: number;
  }): Promise<'accepted' | 'existing' | 'conflict' | 'full'> {
    const result = Number(await this.redis.eval([
      'local fingerprint = redis.call(\'HGET\', KEYS[5], \'fingerprint\')',
      'if fingerprint then',
      '  if fingerprint == ARGV[6] then return 2 end',
      '  return -1',
      'end',
      'local expired = redis.call(\'ZRANGEBYSCORE\', KEYS[2], \'-inf\', ARGV[2])',
      'for _, id in ipairs(expired) do',
      '  redis.call(\'ZREM\', KEYS[1], id); redis.call(\'ZREM\', KEYS[2], id); redis.call(\'HDEL\', KEYS[4], id)',
      'end',
      'if redis.call(\'ZCARD\', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end',
      'local sequence = redis.call(\'INCR\', KEYS[3])',
      'redis.call(\'ZADD\', KEYS[1], sequence, ARGV[1])',
      'redis.call(\'ZADD\', KEYS[2], ARGV[3], ARGV[1])',
      'if ARGV[5] ~= \'\' then redis.call(\'HSET\', KEYS[4], ARGV[1], ARGV[5]) end',
      'local latest = redis.call(\'ZREVRANGE\', KEYS[2], 0, 0, \'WITHSCORES\')',
      'for i = 1, 4 do redis.call(\'PEXPIREAT\', KEYS[i], tonumber(latest[2]) + 30000) end',
      'redis.call(\'HSET\', KEYS[5], \'record\', ARGV[7], \'fingerprint\', ARGV[6], \'state\', \'queued\', \'queueDeadlineAtMs\', ARGV[3])',
      'redis.call(\'PEXPIRE\', KEYS[5], ARGV[8])',
      'redis.call(\'ZADD\', KEYS[6], ARGV[2], KEYS[5])',
      'return 1',
    ].join('\n'), 6, ...this.keys(args.workerId), args.key, args.activeKey,
    args.id, Date.now(), args.deadlineAtMs, this.capacity, args.workspaceId ?? '',
    args.fingerprint, args.record, args.retentionMs));
    if (result === 2) return 'existing';
    if (result === -1) return 'conflict';
    return result === 1 ? 'accepted' : 'full';
  }

  async position(workerId: string, id: string): Promise<number | undefined> {
    const rank = await this.redis.zrank(this.keys(workerId)[0], id);
    return rank == null ? undefined : rank + 1;
  }

  async isHead(workerId: string, id: string): Promise<boolean> {
    const [order, deadlines, , workspaces] = this.keys(workerId);
    return (
      Number(
        await this.redis.eval(
          [
            "local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])",
            'for _, id in ipairs(expired) do',
            "  redis.call('ZREM', KEYS[1], id)",
            "  redis.call('ZREM', KEYS[2], id)",
            "  redis.call('HDEL', KEYS[3], id)",
            'end',
            "local head = redis.call('ZRANGE', KEYS[1], 0, 0)",
            'if head[1] == ARGV[1] then return 1 end',
            'return 0',
          ].join('\n'),
          3,
          order,
          deadlines,
          workspaces,
          id,
          Date.now(),
        ),
      ) === 1
    );
  }

  async leave(workerId: string, id: string): Promise<void> {
    const [order, deadlines, , workspaces] = this.keys(workerId);
    await this.redis.eval(
      [
        "redis.call('ZREM', KEYS[1], ARGV[1])",
        "redis.call('ZREM', KEYS[2], ARGV[1])",
        "redis.call('HDEL', KEYS[3], ARGV[1])",
        'return 1',
      ].join('\n'),
      3,
      order,
      deadlines,
      workspaces,
      id,
    );
  }
}
