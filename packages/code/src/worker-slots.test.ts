import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeWorker } from './worker.js';
import type { BridgeWorkspaceToolCapabilities } from './protocol.js';

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
