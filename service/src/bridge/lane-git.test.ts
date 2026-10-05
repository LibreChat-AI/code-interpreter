import { afterEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';

import type Redis from 'ioredis';

import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { laneGitPolicy } from './lane-git';
import { RedisBridgeStore } from './store';

const redis = new RedisMock() as unknown as Redis;
const incarnationId = 'incarnation-00000001';
const head = 'a'.repeat(40);

afterEach(async () => {
  await redis.flushall();
});

function capabilities(advertise: boolean) {
  return {
    statefulWorkspace: true,
    sandboxProfile: 'nsjail',
    runtimes: ['bash'],
    workspaceTools: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operations: ['read_file' as const, 'execute_command' as const],
      workspaces: [{ id: 'primary' }],
      ...(advertise ? { commandResultFeatures: ['lane_git' as const] } : {}),
    },
  };
}

const request = {
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  operation: 'execute_command' as const,
  workspaceId: 'primary',
  command: 'git checkout -b agent',
};

function commandResult(extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'execute_command' as const,
    workspaceId: 'primary',
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    ...extra,
  };
}

/** Registers a worker, runs one command through the store, and returns what the caller receives. */
async function run(opts: { enabled: boolean; advertise: boolean; workerResult: Record<string, unknown> }) {
  const store = new RedisBridgeStore(redis, undefined, undefined, 1, opts.enabled);
  await store.register({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workerId: 'lane-worker',
    incarnationId,
    capabilities: capabilities(opts.advertise),
  });
  const completion = store.dispatchWorkspaceTool({
    workerId: 'lane-worker',
    tenantId: 'tenant-1',
    request,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const assignment = await store.lease('lane-worker', incarnationId, 1_000);
  await store.settle('lane-worker', assignment?.assignmentId ?? '', {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    generation: assignment?.generation ?? 0,
    leaseToken: assignment?.leaseToken ?? '',
    incarnationId,
    status: 'fulfilled',
    result: opts.workerResult as never,
  });
  // Read the durable copy before the dispatcher cleans it up; it must exist, or the
  // "not stored" assertions below would pass vacuously.
  const stored = await redis.get(`codeapi:bridge:v1:assignment:${assignment?.assignmentId}:settlement`);
  expect(stored).not.toBeNull();
  const settlement = await completion;
  return { settlement, stored: stored as string };
}

describe('laneGit on command settlements', () => {
  test('a valid laneGit from an advertising worker reaches the caller unchanged', async () => {
    const laneGit = { branch: 'librechat/conversation-abcd1234-0123', head };
    const { settlement } = await run({ enabled: true, advertise: true, workerResult: commandResult({ laneGit }) });
    expect(settlement.status).toBe('fulfilled');
    expect((settlement as { result: { laneGit?: unknown } }).result.laneGit).toEqual(laneGit);
  });

  test('null branch and head (detached, no commit) are valid and preserved', async () => {
    const laneGit = { branch: null, head: null };
    const { settlement } = await run({ enabled: true, advertise: true, workerResult: commandResult({ laneGit }) });
    expect((settlement as { result: { laneGit?: unknown } }).result.laneGit).toEqual(laneGit);
  });

  test('a 64 character head is accepted', async () => {
    const laneGit = { branch: 'main', head: 'b'.repeat(64) };
    const { settlement } = await run({ enabled: true, advertise: true, workerResult: commandResult({ laneGit }) });
    expect((settlement as { result: { laneGit?: unknown } }).result.laneGit).toEqual(laneGit);
  });

  const invalid: Array<[string, unknown]> = [
    ['extra keys', { branch: 'main', head, path: '/srv/repo' }],
    ['an over-long branch', { branch: 'x'.repeat(257), head }],
    ['an empty branch', { branch: '', head }],
    ['a control character in the branch', { branch: 'bad\nname', head }],
    ['uppercase hex', { branch: 'main', head: 'A'.repeat(40) }],
    ['a short head', { branch: 'main', head: 'a'.repeat(39) }],
    ['non-hex head', { branch: 'main', head: 'g'.repeat(40) }],
    ['a missing head', { branch: 'main' }],
    ['a non-object', 'main'],
    ['an array', [null, null]],
  ];
  for (const [name, laneGit] of invalid) {
    test(`laneGit with ${name} is dropped and the command still completes`, async () => {
      const { settlement, stored } = await run({ enabled: true, advertise: true, workerResult: commandResult({ laneGit }) });
      expect(settlement.status).toBe('fulfilled');
      const result = (settlement as unknown as { result: Record<string, unknown> }).result;
      expect('laneGit' in result).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(stored).not.toContain('laneGit');
      expect(stored).not.toContain('/srv/repo');
    });
  }

  test('laneGit from a worker that did not advertise lane_git is stripped', async () => {
    const { settlement, stored } = await run({
      enabled: true,
      advertise: false,
      workerResult: commandResult({ laneGit: { branch: 'main', head } }),
    });
    expect(settlement.status).toBe('fulfilled');
    expect('laneGit' in (settlement as { result: object }).result).toBe(false);
    expect(stored).not.toContain('laneGit');
  });

  test('laneGit is stripped when the deployment setting is off, even from an advertising worker', async () => {
    const { settlement, stored } = await run({
      enabled: false,
      advertise: true,
      workerResult: commandResult({ laneGit: { branch: 'main', head } }),
    });
    expect(settlement.status).toBe('fulfilled');
    expect('laneGit' in (settlement as { result: object }).result).toBe(false);
    expect(stored).not.toContain('laneGit');
  });

  test('an old worker without the field still registers and runs commands, with the setting on or off', async () => {
    for (const enabled of [false, true]) {
      const { settlement } = await run({ enabled, advertise: false, workerResult: commandResult() });
      expect(settlement.status).toBe('fulfilled');
      expect((settlement as { result: { exitCode: number } }).result.exitCode).toBe(0);
      await redis.flushall();
    }
  });

  test('the policy never reports the value, only a fixed reason', () => {
    const result = commandResult({ laneGit: { branch: 'secret-branch', head, path: '/srv/repo' } });
    const outcome = laneGitPolicy({ result, enabled: true, advertised: true });
    expect(outcome.dropped).toBe('invalid');
    expect(JSON.stringify(outcome.dropped)).not.toContain('secret-branch');
  });
});

describe('retried settlements across replicas that disagree on the setting', () => {
  // A replica commits a settlement and its response is lost; the worker retries the same body
  // against another replica mid-rollout. The retry must be recognized as the same settlement.
  for (const [first, second] of [
    [true, false],
    [false, true],
  ] as const) {
    test(`commit with the setting ${first ? 'on' : 'off'}, retry on a replica with it ${second ? 'on' : 'off'}`, async () => {
      const a = new RedisBridgeStore(redis, undefined, undefined, 1, first);
      const b = new RedisBridgeStore(redis, undefined, undefined, 1, second);
      await a.register({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: 'lane-worker',
        incarnationId,
        capabilities: capabilities(true),
      });
      const completion = a.dispatchWorkspaceTool({
        workerId: 'lane-worker',
        tenantId: 'tenant-1',
        request,
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      });
      completion.catch(() => undefined);
      const assignment = await a.lease('lane-worker', incarnationId, 1_000);
      const settlement = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: assignment?.generation ?? 0,
        leaseToken: assignment?.leaseToken ?? '',
        incarnationId,
        status: 'fulfilled' as const,
        result: commandResult({ laneGit: { branch: 'main', head } }) as never,
      };
      await a.settle('lane-worker', assignment?.assignmentId ?? '', settlement);
      await expect(b.settle('lane-worker', assignment?.assignmentId ?? '', settlement)).resolves.toBeUndefined();
      await completion;
    });
  }
});
