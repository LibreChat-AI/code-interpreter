import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeWorker } from './worker.js';
import type { WorkspaceMutationQuarantine } from './worker.js';
import type {
  BridgeAssignment,
  BridgeWorkspaceToolCapabilities,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from './protocol.js';

const incarnationId = 'incarnation-receipts';
const capabilities: BridgeWorkspaceToolCapabilities = {
  protocolVersion: 1,
  operations: ['read_file', 'execute_command'],
  workspaces: [{ id: 'a' }],
};

interface Exchange {
  action: string;
  body: Record<string, unknown>;
}

interface Fixture {
  operation: 'read_file' | 'execute_command';
  execute(signal: AbortSignal | undefined, controller: AbortController): Promise<WorkspaceToolResult>;
  guard?: Partial<WorkspaceMutationQuarantine>;
  /** A response that replaces a registration, by 1-based registration attempt. */
  registration?: (attempt: number) => Response | undefined;
  /** Throw to model a lost control receipt, by 1-based delivery attempt. */
  receipt?: (action: string, attempt: number) => void;
  leaseTtlMs?: number;
}

function result(request: WorkspaceToolRequest): WorkspaceToolResult {
  return (request.operation === 'execute_command'
    ? { protocolVersion: 1, operation: 'execute_command', workspaceId: 'a', stdout: 'done', stderr: '', exitCode: 0, truncated: false, timedOut: false }
    : { protocolVersion: 1, operation: 'read_file', workspaceId: 'a', path: 'file.txt', content: 'done', startLine: 1, endLine: 1, truncated: false }) as WorkspaceToolResult;
}

/** A worker on one lane-scoped slot against a fixture bridge that records every control exchange. */
function laneWorker(fixture: Fixture): {
  worker: BridgeWorker;
  exchanges: Exchange[];
  errors: unknown[];
  run(): { controller: AbortController; done: Promise<void> };
} {
  const exchanges: Exchange[] = [];
  const errors: unknown[] = [];
  const attempts = new Map<string, number>();
  let registrations = 0;
  let leased = false;
  let controller = new AbortController();
  const request = {
    protocolVersion: 1,
    operation: fixture.operation,
    workspaceId: 'a',
    ...(fixture.operation === 'execute_command' ? { command: 'true' } : { path: 'file.txt' }),
  } as WorkspaceToolRequest;
  const worker = new BridgeWorker({
    codeApiUrl: 'http://localhost:1',
    token: 'fixture',
    workerId: 'worker',
    incarnationId,
    sandboxEndpoint: 'http://localhost:2',
    leaseWaitMs: 10,
    reconnectDelayMs: 10,
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'native-srt',
      runtimes: [],
      workspaceLeaseSlots: 2,
      requiresReadyConfirmation: true,
      workspaceTools: capabilities,
    },
    workspaceTools: {
      capabilities,
      mutationFailuresAreAtomic: true,
      execute: async (_request, signal) => await fixture.execute(signal, controller),
    },
    workspaceQuarantines: new Map([
      ['a', {
        async assertAvailable() {},
        async arm() {},
        async clear() {},
        async quarantine() {},
        ...fixture.guard,
      }],
    ]),
    onError: (error) => errors.push(error),
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const action = path.split('/').at(-1)!;
      if (action === 'register') {
        registrations += 1;
        return fixture.registration?.(registrations) ?? Response.json({
          protocolVersion: 1, workerId: 'worker', incarnationId,
          registrationGeneration: registrations, registeredAt: new Date().toISOString(),
          leaseTtlMs: fixture.leaseTtlMs ?? 60_000, workspaceLeaseSlots: 2,
          supportedWorkspaceToolOperations: capabilities.operations,
        });
      }
      if (action === 'ready') return Response.json({ protocolVersion: 1, ready: true });
      if (action === 'lease') {
        exchanges.push({ action, body });
        if (!leased && body.workspaceLeaseSlot === 0) {
          leased = true;
          return Response.json({
            protocolVersion: 1, serverElapsedMs: 0,
            assignment: {
              protocolVersion: 1, assignmentId: 'assignment-a', workerId: 'worker', incarnationId,
              generation: 1, leaseToken: 'l'.repeat(43), workspaceLeaseSlot: 0,
              expiresAt: new Date(Date.now() + 30_000).toISOString(), remainingMs: 30_000,
              executionKind: 'workspace_tool', request,
            } satisfies BridgeAssignment,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ protocolVersion: 1, serverElapsedMs: 0 });
      }
      if (action === 'ack') return Response.json({ protocolVersion: 1, accepted: true });
      if (action === 'cancellation') return Response.json({ protocolVersion: 1, cancelled: false });
      const attempt = (attempts.get(action) ?? 0) + 1;
      attempts.set(action, attempt);
      fixture.receipt?.(action, attempt);
      exchanges.push({ action, body });
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  return {
    worker,
    exchanges,
    errors,
    run() {
      controller = new AbortController();
      return { controller, done: worker.run(controller.signal) };
    },
  };
}

function actions(exchanges: Exchange[]): string[] {
  return exchanges.map((exchange) => exchange.action).filter((action) => action !== 'lease');
}

function receipt(exchanges: Exchange[], action: string): Record<string, unknown> | undefined {
  return exchanges.find((exchange) => exchange.action === action)?.body;
}

async function until(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), message);
}

for (const operation of ['read_file', 'execute_command'] as const) {
  test(`a committed ${operation} result still releases its lane when the run stops before cleanup is acknowledged`, async () => {
    let stop!: () => void;
    const lane = laneWorker({
      operation,
      execute: async (_signal, controller) => {
        stop = () => controller.abort();
        return result({ operation } as WorkspaceToolRequest);
      },
      // The run stops in the gap between the committed settlement and the cleanup acknowledgement.
      receipt: (action) => {
        if (action === 'settle') stop();
      },
    });
    await lane.run().done;
    assert.deepEqual(actions(lane.exchanges), ['settle', 'workspace-cleanup']);
    assert.equal(receipt(lane.exchanges, 'settle')?.status, 'fulfilled');
  });
}

test('an interrupted command still quarantines its lane, and the receipt is delivered after the run stops', async () => {
  let quarantined = 0;
  const lane = laneWorker({
    operation: 'execute_command',
    guard: { async quarantine() { quarantined += 1; } },
    execute: async (signal, controller) => {
      controller.abort();
      assert.equal(signal?.aborted, true);
      throw new DOMException('aborted', 'AbortError');
    },
  });
  await lane.run().done;
  assert.equal(quarantined, 1);
  assert.deepEqual(actions(lane.exchanges), ['quarantine']);
});

test('a quarantine receipt that cannot be delivered while the run stops is delivered before the next run leases', async () => {
  let outage = true;
  const lane = laneWorker({
    operation: 'execute_command',
    execute: async (_signal, controller) => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    },
    receipt: () => {
      if (outage) throw new TypeError('fetch failed');
    },
  });
  await lane.run().done;
  assert.deepEqual(actions(lane.exchanges), []);

  outage = false;
  lane.exchanges.length = 0;
  const next = lane.run();
  try {
    await until(() => lane.exchanges.some((exchange) => exchange.action === 'lease'), 'the next run never leased');
  } finally {
    next.controller.abort();
    await next.done;
  }
  assert.equal(lane.exchanges[0].action, 'quarantine');
  assert.equal(receipt(lane.exchanges, 'quarantine')?.leaseToken, 'l'.repeat(43));

  lane.exchanges.length = 0;
  const later = lane.run();
  try {
    await until(() => lane.exchanges.some((exchange) => exchange.action === 'lease'), 'the later run never leased');
  } finally {
    later.controller.abort();
    await later.done;
  }
  assert.deepEqual(actions(lane.exchanges), []);
});

for (const failures of [1, 2]) {
  test(`${failures} consecutive failed heartbeat${failures === 1 ? ' is retried' : 's stop every slot'}`, async () => {
    let started = false;
    let failed = 0;
    let executionAborted: boolean | undefined;
    const lane = laneWorker({
      operation: 'read_file',
      leaseTtlMs: 100,
      registration: () => {
        if (!started || failed >= failures) return undefined;
        failed += 1;
        return Response.json({ error: 'Bad gateway' }, { status: 502 });
      },
      execute: async (signal) => {
        started = true;
        await until(() => failed === failures || signal?.aborted === true, 'the heartbeat never failed');
        await new Promise((resolve) => setTimeout(resolve, 150));
        executionAborted = signal?.aborted === true;
        return result({ operation: 'read_file' } as WorkspaceToolRequest);
      },
    });
    const { controller, done } = lane.run();
    try {
      await until(() => executionAborted !== undefined, 'the execution never finished');
      if (failures === 1) {
        await until(() => actions(lane.exchanges).includes('workspace-cleanup'), 'the lane was never released');
      }
    } finally {
      controller.abort();
      await done;
    }
    assert.equal(executionAborted, failures > 1);
    if (failures > 1) return;
    assert.deepEqual(actions(lane.exchanges), ['settle', 'workspace-cleanup']);
    assert.equal(receipt(lane.exchanges, 'settle')?.status, 'fulfilled');
    assert.deepEqual(lane.errors, []);
  });
}
