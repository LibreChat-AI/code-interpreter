import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeWorker, BridgeWorkspaceQuarantinedError } from './worker.js';
import { workspaceIsolationKey } from './protocol.js';
import {
  clearWorkspaceMutationQuarantine,
  detachedWorkspaceMutationQuarantineDirectory,
} from './storage.js';
import { workspaceMutationGuard } from './workspace-guards.js';
import type { TestContext } from 'node:test';
import type {
  BridgeAssignment,
  BridgeWorkspaceToolCapabilities,
  WorkspaceExecuteCommandRequest,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from './protocol.js';

const lane = 'task-a';
const laneKey = workspaceIsolationKey('repo', undefined, lane);
const capabilities: BridgeWorkspaceToolCapabilities = {
  protocolVersion: 1,
  operations: ['read_file', 'execute_command'],
  workspaces: [{ id: 'repo', workspaceScopes: ['git_linked_worktree'] }],
  commandFeatures: ['detached'],
};

interface Gate {
  started: Promise<void>;
  markStarted(): void;
  finished: Promise<void>;
  release(): void;
}

interface Call {
  action: string;
  assignmentId?: string;
  body: Record<string, unknown>;
}

interface Harness {
  worker: BridgeWorker;
  calls: Call[];
  executed: string[];
  errors: unknown[];
  failures: Map<string, Error>;
  leases: BridgeAssignment[];
  unacknowledged: Set<string>;
  marker(worktree?: string): string;
  detachedMarkers(worktree?: string): Promise<string[]>;
  started(command: string): Promise<void>;
  release(command: string): void;
  quarantined(): Set<string>;
}

async function scratch(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-detached-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A regression must fail its test, not leave it waiting on a command that never runs. */
async function within<T>(pending: Promise<T>, expectation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectation}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function harness(
  t: TestContext,
  directory: string,
  options: { incarnationId?: string; offered?: boolean } = {},
): Harness {
  const incarnationId = options.incarnationId ?? 'incarnation-detached';
  const gates = new Map<string, Gate>();
  let finished = false;
  t.after(() => {
    finished = true;
    for (const running of gates.values()) running.release();
  });
  const gate = (command: string): Gate => {
    let existing = gates.get(command);
    if (existing == null) {
      let markStarted!: () => void;
      let release!: () => void;
      existing = {
        started: new Promise<void>((resolve) => { markStarted = resolve; }),
        markStarted: () => markStarted(),
        finished: new Promise<void>((resolve) => { release = resolve; }),
        release: () => release(),
      };
      gates.set(command, existing);
    }
    return existing;
  };
  const calls: Call[] = [];
  const executed: string[] = [];
  const errors: unknown[] = [];
  const failures = new Map<string, Error>();
  const leases: BridgeAssignment[] = [];
  const unacknowledged = new Set<string>();
  const marker = (worktree?: string): string =>
    join(directory, worktree == null ? 'repo.json' : `lane-${worktree}.json`);
  const worker = new BridgeWorker({
    codeApiUrl: 'http://localhost:1',
    token: 'fixture',
    workerId: 'worker',
    incarnationId,
    sandboxEndpoint: 'http://localhost:2',
    reconnectDelayMs: 1,
    onError: (error) => {
      errors.push(error);
    },
    capabilities: {
      statefulWorkspace: false,
      sandboxProfile: 'native-srt',
      runtimes: [],
      workspaceLeaseSlots: 3,
      requiresReadyConfirmation: true,
      workspaceTools: capabilities,
    },
    workspaceTools: {
      capabilities,
      mutationFailuresAreAtomic: true,
      async execute(request: WorkspaceToolRequest): Promise<WorkspaceToolResult> {
        if (request.operation !== 'execute_command') throw new Error('unexpected operation');
        executed.push(request.command);
        const running = gate(request.command);
        running.markStarted();
        if (!finished) await running.finished;
        const failure = failures.get(request.command);
        if (failure != null) throw failure;
        return {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: request.workspaceId,
          exitCode: 0,
          stdout: request.command,
          stderr: '',
          truncated: false,
          timedOut: false,
        };
      },
    },
    workspaceQuarantines: new Map([
      ['repo', workspaceMutationGuard(marker(), 'worker', 'repo', incarnationId)],
    ]),
    linkedWorktreeQuarantineResolver: (workspaceId, worktree) =>
      workspaceMutationGuard(
        marker(worktree),
        'worker',
        workspaceIsolationKey(workspaceId, undefined, worktree),
        incarnationId,
      ),
    linkedWorktreeNames: async () => [lane],
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const assignment = /\/assignments\/([^/]+)\/([^/]+)$/.exec(path);
      const action = assignment?.[2] ?? path.slice(path.lastIndexOf('/') + 1);
      const assignmentId = assignment == null ? undefined : decodeURIComponent(assignment[1]!);
      calls.push({ action, assignmentId, body });
      if (action === 'register') {
        return Response.json({
          protocolVersion: 1,
          workerId: 'worker',
          incarnationId,
          registrationGeneration: 1,
          registeredAt: new Date().toISOString(),
          leaseTtlMs: 60_000,
          workspaceLeaseSlots: 3,
          supportedWorkspaceToolOperations: ['read_file', 'execute_command'],
          supportedWorkspaceScopes: ['git_linked_worktree'],
          ...(options.offered === false ? {} : { supportedWorkspaceCommandFeatures: ['detached'] }),
        });
      }
      if (action === 'ready') return Response.json({ protocolVersion: 1, ready: true });
      if (action === 'cancellation') return Response.json({ protocolVersion: 1, cancelled: false });
      if (action === 'workspace-cleanup' && assignmentId != null && unacknowledged.has(assignmentId)) {
        return Response.json({ error: 'receipt outage' }, { status: 503 });
      }
      if (action === 'lease') {
        const index = leases.findIndex((lease) => lease.workspaceLeaseSlot === body.workspaceLeaseSlot);
        if (index >= 0) {
          return Response.json({
            protocolVersion: 1,
            serverElapsedMs: 0,
            assignment: leases.splice(index, 1)[0],
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10);
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return Response.json({ protocolVersion: 1, serverElapsedMs: 0 });
      }
      return Response.json({ protocolVersion: 1, accepted: true });
    },
  });
  return {
    worker,
    calls,
    executed,
    errors,
    failures,
    leases,
    unacknowledged,
    marker,
    async detachedMarkers(worktree) {
      try {
        return await readdir(detachedWorkspaceMutationQuarantineDirectory(marker(worktree)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    started: (command) => within(gate(command).started, `${command} to start`),
    release: (command) => gate(command).release(),
    quarantined: () =>
      (worker as unknown as { quarantinedWorkspaces: Set<string> }).quarantinedWorkspaces,
  };
}

function assignment(
  assignmentId: string,
  slot: number,
  request: Partial<WorkspaceExecuteCommandRequest> = {},
  incarnationId = 'incarnation-detached',
): BridgeAssignment {
  return {
    protocolVersion: 1,
    assignmentId,
    workerId: 'worker',
    incarnationId,
    generation: 1,
    leaseToken: 'lease-token-that-is-long-enough-for-testing',
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    remainingMs: 10_000,
    executionKind: 'workspace_tool',
    workspaceLeaseSlot: slot,
    request: {
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'repo',
      worktree: lane,
      command: assignmentId,
      ...request,
    },
  };
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false);

const settlements = (calls: Call[], assignmentId: string): Record<string, unknown>[] =>
  calls
    .filter((call) => call.action === 'settle' && call.assignmentId === assignmentId)
    .map((call) => call.body);

for (const detachedFirst of [true, false]) {
  test(`a detached command overlaps ordinary work in its lane and checkout (detached ${detachedFirst ? 'first' : 'second'})`, async (t) => {
    const fixture = harness(t, await scratch(t));
    await fixture.worker.register();
    const run = (id: string, slot: number, request?: Partial<WorkspaceExecuteCommandRequest>) =>
      fixture.worker.executeAndSettle(assignment(id, slot, request));
    const order = detachedFirst ? ['background', 'ordinary'] : ['ordinary', 'background'];
    const pending = new Map<string, Promise<void>>();
    for (const [slot, id] of order.entries()) {
      pending.set(id, run(id, slot, id === 'background' ? { detached: true } : {}));
      await fixture.started(id);
    }
    assert.deepEqual(fixture.executed, order);
    assert.equal(await exists(fixture.marker(lane)), true);
    assert.deepEqual(await fixture.detachedMarkers(lane), ['background.json']);

    fixture.release('ordinary');
    await pending.get('ordinary');
    assert.equal(await exists(fixture.marker(lane)), false);
    assert.deepEqual(await fixture.detachedMarkers(lane), ['background.json']);

    const next = run('next', detachedFirst ? 1 : 0);
    await fixture.started('next');
    fixture.release('next');
    await next;
    const checkout = run('checkout', detachedFirst ? 1 : 0, { worktree: undefined });
    await fixture.started('checkout');
    assert.equal(await exists(fixture.marker()), true);
    fixture.release('checkout');
    await checkout;

    fixture.release('background');
    await pending.get('background');
    assert.deepEqual(await fixture.detachedMarkers(lane), []);
    assert.equal(await exists(fixture.marker()), false);
    assert.equal(fixture.quarantined().size, 0);
    for (const id of ['background', 'ordinary', 'next', 'checkout']) {
      assert.deepEqual(
        settlements(fixture.calls, id).map((body) => [body.status, (body.result as { stdout: string }).stdout]),
        [['fulfilled', id]],
      );
      assert.equal(
        fixture.calls.filter((call) => call.action === 'workspace-cleanup' && call.assignmentId === id).length,
        1,
      );
    }
    assert.equal(fixture.calls.some((call) => call.action === 'quarantine'), false);
  });
}

test('a detached marker left by another incarnation quarantines the worktree until an operator clears it', async (t) => {
  const directory = await scratch(t);
  const previous = harness(t, directory, { incarnationId: 'incarnation-previous' });
  const crashed = previous.worker.executeAndSettle(
    assignment('crashed', 0, { detached: true }, 'incarnation-previous'),
  );
  await previous.started('crashed');
  assert.deepEqual(await previous.detachedMarkers(lane), ['crashed.json']);
  assert.equal(await exists(previous.marker(lane)), false);

  const restarted = harness(t, directory);
  await restarted.worker.register();
  for (const [slot, request] of [{ worktree: undefined }, {}, { detached: true as const }].entries()) {
    await assert.rejects(
      restarted.worker.executeAndSettle(assignment(`refused-${slot}`, slot, request)),
      BridgeWorkspaceQuarantinedError,
    );
  }
  assert.deepEqual(restarted.executed, []);
  assert.deepEqual([...restarted.quarantined()].sort(), ['repo', laneKey].sort());

  const maintenance = harness(t, directory, { incarnationId: 'incarnation-maintenance' });
  await assert.rejects(
    maintenance.worker.resetNativeWorkspace('repo', undefined, undefined, lane),
    { code: 'WORKSPACE_QUARANTINED' },
  );
  assert.equal(maintenance.calls.some((call) => call.action === 'reset'), false);
  await clearWorkspaceMutationQuarantine(previous.marker(lane));
  assert.equal(await exists(detachedWorkspaceMutationQuarantineDirectory(previous.marker(lane))), false);
  await maintenance.worker.resetNativeWorkspace('repo', undefined, undefined, lane);
  assert.deepEqual(
    maintenance.calls.filter((call) => call.action === 'reset').map((call) => call.body.runtimeSessionId),
    [`native-workspace:${laneKey}`],
  );

  const recovered = harness(t, directory, { incarnationId: 'incarnation-recovered' });
  await recovered.worker.register();
  const ordinary = recovered.worker.executeAndSettle(
    assignment('recovered', 0, {}, 'incarnation-recovered'),
  );
  await recovered.started('recovered');
  recovered.release('recovered');
  await ordinary;
  assert.deepEqual(recovered.executed, ['recovered']);

  previous.release('crashed');
  await crashed.catch(() => undefined);
});

test('an ambiguous detached failure quarantines its worktree, keeps its marker and reports the assignment', async (t) => {
  const fixture = harness(t, await scratch(t));
  fixture.failures.set('background', new Error('executor state unknown'));
  fixture.leases.push(assignment('background', 0, { detached: true }));
  const controller = new AbortController();
  const running = fixture.worker.run(controller.signal);
  const reported = async (assignmentId: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!fixture.calls.some((call) => call.action === 'quarantine' && call.assignmentId === assignmentId)) {
      assert.ok(Date.now() < deadline, `Timed out waiting for the quarantine receipt of ${assignmentId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await fixture.started('background');
    assert.deepEqual(await fixture.detachedMarkers(lane), ['background.json']);
    fixture.release('background');
    await reported('background');
    assert.deepEqual(await fixture.detachedMarkers(lane), ['background.json']);
    assert.equal(await exists(fixture.marker(lane)), false);
    assert.deepEqual([...fixture.quarantined()], [laneKey]);
    assert.deepEqual(settlements(fixture.calls, 'background'), []);

    fixture.leases.push(assignment('ordinary', 1));
    await reported('ordinary');
    fixture.leases.push(assignment('checkout', 2, { worktree: undefined }));
    await reported('checkout');
    assert.deepEqual(fixture.executed, ['background']);
    assert.deepEqual(
      fixture.errors.map((error) => [(error as Error).name, (error as Error).message]),
      [
        ['Error', 'executor state unknown'],
        [
          'BridgeWorkspaceQuarantinedError',
          'Worker stopped after a workspace mutation completed without a fulfilled settlement',
        ],
        ['BridgeWorkspaceQuarantinedError', 'Workspace is quarantined'],
        ['BridgeWorkspaceQuarantinedError', 'Workspace is quarantined'],
      ],
    );
  } finally {
    controller.abort();
    await running;
  }
});

test('a lost cleanup acknowledgement for a detached command leaves its worktree usable', async (t) => {
  const fixture = harness(t, await scratch(t));
  await fixture.worker.register();
  fixture.unacknowledged.add('background');
  const background = fixture.worker.executeAndSettle(assignment('background', 0, { detached: true }));
  await fixture.started('background');
  fixture.release('background');
  await assert.rejects(background, (error: unknown) =>
    error instanceof BridgeWorkspaceQuarantinedError && error.acknowledgementOnly,
  );
  assert.deepEqual(await fixture.detachedMarkers(lane), []);
  assert.equal(fixture.quarantined().size, 0);
  assert.equal(settlements(fixture.calls, 'background')[0]?.status, 'fulfilled');

  fixture.unacknowledged.add('ordinary');
  const ordinary = fixture.worker.executeAndSettle(assignment('ordinary', 1));
  await fixture.started('ordinary');
  fixture.release('ordinary');
  await assert.rejects(ordinary, BridgeWorkspaceQuarantinedError);
  assert.deepEqual([...fixture.quarantined()], [laneKey]);
});

test('a detached request is refused unless Code API negotiated the feature', async (t) => {
  const withheld = harness(t, await scratch(t), { offered: false });
  await withheld.worker.register();
  const registrations = (calls: Call[]): unknown[] =>
    calls
      .filter((call) => call.action === 'register')
      .map((call) => (call.body.capabilities as { workspaceTools?: BridgeWorkspaceToolCapabilities })
        .workspaceTools?.commandFeatures);
  assert.deepEqual(registrations(withheld.calls).filter((features) => features !== undefined), []);
  await withheld.worker.executeAndSettle(assignment('background', 0, { detached: true }));
  assert.deepEqual(withheld.executed, []);
  assert.deepEqual(await withheld.detachedMarkers(lane), []);
  assert.equal(withheld.quarantined().size, 0);
  assert.deepEqual(
    settlements(withheld.calls, 'background').map((body) => [body.status, body.error]),
    [['rejected', 'Workspace command feature is not advertised']],
  );

  const offered = harness(t, await scratch(t));
  await offered.worker.register();
  assert.deepEqual(registrations(offered.calls).at(-1), ['detached']);
});

test('detached commands cannot be advertised with a single lease slot', () => {
  const capabilities: BridgeWorkspaceToolCapabilities = {
    protocolVersion: 1,
    operations: ['execute_command'],
    workspaces: [{ id: 'repo' }],
    commandFeatures: ['detached'],
  };
  assert.throws(
    () =>
      new BridgeWorker({
        codeApiUrl: 'http://localhost:1',
        token: 'fixture',
        workerId: 'worker',
        sandboxEndpoint: 'http://localhost:2',
        capabilities: {
          statefulWorkspace: false,
          sandboxProfile: 'native-srt',
          runtimes: [],
          workspaceTools: capabilities,
        },
        workspaceTools: {
          capabilities,
          async execute() {
            throw new Error('must not execute');
          },
        },
        workspaceMutationQuarantine: {
          async assertAvailable() {},
          async arm() {},
          async clear() {},
          async quarantine() {},
        },
      }),
    /Detached commands require at least two lease slots/,
  );
});
