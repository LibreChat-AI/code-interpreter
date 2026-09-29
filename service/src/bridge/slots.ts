import type Redis from 'ioredis';

/** Hard bound keeps every atomic scheduling scan constant-sized. */
export const MAX_WORKSPACE_LEASE_SLOTS = 8;

/** Reservations share the legacy admission queue and aggregate worker lock.
 * Thus a serial dispatcher or replacement incarnation cannot race active slots.
 * Workspace mutation uncertainty is fenced separately by the assignment store.
 *
 * Keys are hierarchical: a linked-worktree lane (`\0linked-worktree\0<parent>\0<name>`)
 * conflicts with itself and with its parent checkout, and a checkout conflicts
 * with every lane beneath it. Sibling lanes run concurrently. A waiting checkout
 * request also holds back newer lanes beneath it, so root operations such as
 * `git worktree add` cannot be starved by a steady stream of lane work.
 */
export class BridgeWorkspaceSlots {
  constructor(private readonly redis: Redis) {}

  private keys(workerId: string): string[] {
    const prefix = `codeapi:bridge:v1:worker:${encodeURIComponent(workerId)}`;
    return [
      `${prefix}:workspace-slots`,
      `${prefix}:lock`,
      `${prefix}:lock:incarnation`,
      `${prefix}:incarnation`,
      `${prefix}:admission`,
      `${prefix}:admission:deadlines`,
      `${prefix}:admission:workspaces`,
      `${prefix}:workspace-slot-capacity`,
    ];
  }

  async reserve(args: {
    workerId: string;
    incarnationId: string;
    assignmentId: string;
    workspaceId: string;
    capacity: number;
    expiresAtMs: number;
  }): Promise<number | undefined> {
    if (
      !Number.isSafeInteger(args.capacity) ||
      args.capacity < 1 ||
      args.capacity > MAX_WORKSPACE_LEASE_SLOTS ||
      !args.workspaceId ||
      !Number.isSafeInteger(args.expiresAtMs) ||
      args.expiresAtMs <= Date.now()
    ) {
      throw new Error('Invalid workspace slot reservation');
    }
    const result = Number(
      await this.redis.eval(
        [
          "if redis.call('GET', KEYS[4]) ~= ARGV[1] then return -2 end",
          "if (redis.call('GET', KEYS[8]) or '1') ~= ARGV[4] then return -2 end",
          // Parent of a linked-worktree lane key; nil for a checkout key.
          'local lanePrefix = "\\0linked-worktree\\0"',
          'local function parentOf(key)',
          '  if string.sub(key, 1, #lanePrefix) ~= lanePrefix then return nil end',
          '  local last = nil',
          '  local cursor = #lanePrefix + 1',
          '  while true do',
          '    local found = string.find(key, "\\0", cursor, true)',
          '    if not found then break end',
          '    last = found',
          '    cursor = found + 1',
          '  end',
          '  if last == nil or last <= #lanePrefix + 1 then return nil end',
          '  return string.sub(key, #lanePrefix + 1, last - 1)',
          'end',
          "local lock = redis.call('GET', KEYS[2])",
          "local owner = 'workspace-slots:' .. ARGV[1]",
          'if lock and lock ~= owner then return -1 end',
          'local busy = {}',
          'local busyChildren = {}',
          'local free = nil',
          'local latest = tonumber(ARGV[5])',
          `for slot = 0, ${MAX_WORKSPACE_LEASE_SLOTS - 1} do`,
          "  local entry = redis.call('HMGET', KEYS[1], 'a:' .. slot, 'i:' .. slot, 'w:' .. slot, 'e:' .. slot)",
          '  local occupied = entry[1]',
          '  if occupied then',
          '    if entry[2] ~= ARGV[1] or tonumber(entry[4]) <= tonumber(ARGV[6]) then',
          "      redis.call('HDEL', KEYS[1], 'a:' .. slot, 'i:' .. slot, 'w:' .. slot, 'e:' .. slot)",
          '      occupied = false',
          '    else',
          '      if entry[1] == ARGV[2] then return slot end',
          '      busy[entry[3]] = true',
          '      local busyParent = parentOf(entry[3])',
          '      if busyParent then busyChildren[busyParent] = true end',
          '      latest = math.max(latest, tonumber(entry[4]))',
          '    end',
          '  end',
          '  if not occupied and free == nil and slot < tonumber(ARGV[4]) then free = slot end',
          'end',
          'local function conflicts(key)',
          '  if busy[key] then return true end',
          '  local parent = parentOf(key)',
          '  if parent then return busy[parent] == true end',
          '  return busyChildren[key] == true',
          'end',
          'if free == nil or conflicts(ARGV[3]) then return -1 end',
          // Expiry removes queue metadata, never a workspace uncertainty fence.
          "local expired = redis.call('ZRANGEBYSCORE', KEYS[6], '-inf', ARGV[6])",
          'for _, id in ipairs(expired) do',
          "  redis.call('ZREM', KEYS[5], id)",
          "  redis.call('ZREM', KEYS[6], id)",
          "  redis.call('HDEL', KEYS[7], id)",
          'end',
          "local pending = redis.call('ZRANGE', KEYS[5], 0, 31)",
          'local selected = nil',
          'local waitingCheckouts = {}',
          'for _, id in ipairs(pending) do',
          "  local workspace = redis.call('HGET', KEYS[7], id)",
          // An older serial request remains a barrier until its dispatcher finishes.
          '  if not workspace then return -1 end',
          '  local parent = parentOf(workspace)',
          '  local held = conflicts(workspace) or (parent ~= nil and waitingCheckouts[parent] == true)',
          '  if not held then selected = id; break end',
          '  if parent == nil then waitingCheckouts[workspace] = true end',
          'end',
          'if selected ~= ARGV[2] then return -1 end',
          "redis.call('HSET', KEYS[1], 'a:' .. free, ARGV[2], 'i:' .. free, ARGV[1], 'w:' .. free, ARGV[3], 'e:' .. free, ARGV[5])",
          "redis.call('PEXPIREAT', KEYS[1], latest)",
          "redis.call('SET', KEYS[2], owner, 'PXAT', latest)",
          "redis.call('SET', KEYS[3], ARGV[1], 'PXAT', latest)",
          'return free',
        ].join('\n'),
        8,
        ...this.keys(args.workerId),
        args.incarnationId,
        args.assignmentId,
        args.workspaceId,
        args.capacity,
        args.expiresAtMs,
        Date.now(),
      ),
    );
    if (result === -2)
      throw new Error('Workspace slot incarnation was replaced');
    return result < 0 ? undefined : result;
  }

  async release(
    workerId: string,
    incarnationId: string,
    assignmentId: string,
  ): Promise<void> {
    await this.redis.eval(
      [
        'local latest = 0',
        `for slot = 0, ${MAX_WORKSPACE_LEASE_SLOTS - 1} do`,
        "  local entry = redis.call('HMGET', KEYS[1], 'a:' .. slot, 'i:' .. slot, 'e:' .. slot)",
        '  if entry[2] == ARGV[1] and entry[1] == ARGV[2] then',
        "    redis.call('HDEL', KEYS[1], 'a:' .. slot, 'i:' .. slot, 'w:' .. slot, 'e:' .. slot)",
        '  elseif type(entry[1]) == "string" then latest = math.max(latest, tonumber(entry[3]))',
        '  end',
        'end',
        "if redis.call('HLEN', KEYS[1]) == 0 and redis.call('GET', KEYS[2]) == 'workspace-slots:' .. ARGV[1] then",
        "  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
        "elseif latest > 0 and redis.call('GET', KEYS[2]) == 'workspace-slots:' .. ARGV[1] then",
        '  for _, key in ipairs(KEYS) do',
        "    redis.call('PEXPIREAT', key, latest)",
        '  end',
        'end',
        'return 1',
      ].join('\n'),
      3,
      ...this.keys(workerId).slice(0, 3),
      incarnationId,
      assignmentId,
    );
  }
}
