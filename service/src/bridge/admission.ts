import type Redis from 'ioredis';

/** Bounded FIFO admission shared by API replicas. Entries expire after caller deadlines. */
export class BridgeAdmissionQueue {
  constructor(
    private readonly redis: Redis,
    private readonly capacity = 32,
  ) {}

  private keys(workerId: string): [string, string, string] {
    const prefix = `codeapi:bridge:v1:worker:${encodeURIComponent(workerId)}:admission`;
    return [prefix, `${prefix}:deadlines`, `${prefix}:sequence`];
  }

  async enter(
    workerId: string,
    id: string,
    deadlineAtMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          [
            "local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])",
            'for _, id in ipairs(expired) do',
            "  redis.call('ZREM', KEYS[1], id)",
            "  redis.call('ZREM', KEYS[2], id)",
            'end',
            "if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end",
            "if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end",
            "local sequence = redis.call('INCR', KEYS[3])",
            "redis.call('ZADD', KEYS[1], sequence, ARGV[1])",
            "redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])",
            "local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')",
            'for _, key in ipairs(KEYS) do',
            "  redis.call('PEXPIREAT', key, tonumber(latest[2]) + 30000)",
            'end',
            'return 1',
          ].join('\n'),
          3,
          ...this.keys(workerId),
          id,
          Date.now(),
          deadlineAtMs,
          this.capacity,
        ),
      ) === 1
    );
  }

  async isHead(workerId: string, id: string): Promise<boolean> {
    const [order, deadlines] = this.keys(workerId);
    return (
      Number(
        await this.redis.eval(
          [
            "local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])",
            'for _, id in ipairs(expired) do',
            "  redis.call('ZREM', KEYS[1], id)",
            "  redis.call('ZREM', KEYS[2], id)",
            'end',
            "local head = redis.call('ZRANGE', KEYS[1], 0, 0)",
            'if head[1] == ARGV[1] then return 1 end',
            'return 0',
          ].join('\n'),
          2,
          order,
          deadlines,
          id,
          Date.now(),
        ),
      ) === 1
    );
  }

  async leave(workerId: string, id: string): Promise<void> {
    const [order, deadlines] = this.keys(workerId);
    await this.redis.eval(
      [
        "redis.call('ZREM', KEYS[1], ARGV[1])",
        "redis.call('ZREM', KEYS[2], ARGV[1])",
        'return 1',
      ].join('\n'),
      2,
      order,
      deadlines,
      id,
    );
  }
}
