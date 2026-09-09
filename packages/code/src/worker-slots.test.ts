import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeWorker } from './worker.js';
import type {
  BridgeAssignment,
  BridgeWorkspaceToolCapabilities,
} from './protocol.js';

const capabilities: BridgeWorkspaceToolCapabilities = {
  protocolVersion: 1,
  operations: ['read_file'],
  workspaces: [{ id: 'a' }, { id: 'b' }],
};
for (const receipt of [undefined, 1]) {
  test(`worker keeps serial lease wire format for receipt ${receipt}`, async () => {
    const controller = new AbortController();
    let leases = 0;
    const worker = new BridgeWorker({
      codeApiUrl: 'http://localhost:1',
      token: 'fixture',
      workerId: 'worker',
      incarnationId: 'incarnation-test-slots',
      sandboxEndpoint: 'http://localhost:2',
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'fixture',
        runtimes: [],
        workspaceLeaseSlots: 2,
        requiresReadyConfirmation: true,
        workspaceTools: capabilities,
      },
      workspaceTools: {
        capabilities,
        async execute() {
          throw new Error('must not execute');
        },
      },
      workspaceQuarantines: new Map(
        ['a', 'b'].map((root) => [
          root,
          {
            async assertAvailable() {},
            async arm() {},
            async clear() {},
            async quarantine() {},
          },
        ]),
      ),
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/register'))
          return Response.json({
            protocolVersion: 1,
            workerId: 'worker',
            incarnationId: 'incarnation-test-slots',
            registrationGeneration: 1,
            registeredAt: new Date().toISOString(),
            leaseTtlMs: 60000,
            ...(receipt === undefined ? {} : { workspaceLeaseSlots: receipt }),
          });
        if (path.endsWith('/lease')) {
          leases++;
          assert.equal(
            JSON.parse(String(init?.body)).workspaceLeaseSlot,
            undefined,
          );
          controller.abort();
        }
        return Response.json({ protocolVersion: 1, ready: true });
      },
    });
    await worker.run(controller.signal);
    assert.equal(leases, 1);
    await assert.rejects(worker.lease(undefined, 0), /negotiated capacity/);
  });
}

for (const cancelled of [false, true]) {
  test(`local cleanup wait rejects unexecuted work on ${cancelled ? 'cancellation' : 'expiry'}`, async () => {
    const worker = new BridgeWorker({
      codeApiUrl: 'http://localhost:1',
      token: 'fixture',
      workerId: 'worker',
      sandboxEndpoint: 'http://localhost:2',
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'fixture',
        runtimes: [],
      },
    });
    // Exercise the handoff seam without involving the unrelated HTTP settlement retry loop.
    const internals = worker as unknown as {
      activeWorkspaceAssignments: Map<
        string,
        { id: string; done: Promise<void> }
      >;
      rejectUnexecutedAssignment: () => Promise<void>;
      executeOwned: () => Promise<void>;
    };
    internals.activeWorkspaceAssignments.set('a', {
      id: 'previous',
      done: new Promise(() => {}),
    });
    let rejected = false;
    internals.rejectUnexecutedAssignment = async () => {
      rejected = true;
    };
    internals.executeOwned = async () => {
      assert.fail('must not enter a root still cleaning up');
    };
    const controller = new AbortController();
    if (cancelled) controller.abort();
    await worker.executeAndSettle(
      {
        assignmentId: 'next',
        executionKind: 'workspace_tool',
        remainingMs: cancelled ? 60000 : 5,
        request: {
          protocolVersion: 1,
          workspaceId: 'a',
          operation: 'read_file',
          path: 'test.txt',
        },
      } as BridgeAssignment,
      controller.signal,
    );
    assert.equal(rejected, true);
    assert.equal(internals.activeWorkspaceAssignments.get('a')?.id, 'previous');
  });
}
