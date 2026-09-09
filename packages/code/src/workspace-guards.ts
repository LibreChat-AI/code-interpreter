import { BridgeProtocolError } from './protocol.js';
import {
  assertWorkspaceMutationQuarantineOwner,
  clearWorkspaceMutationQuarantine,
  loadWorkspaceMutationQuarantine,
  saveWorkspaceMutationQuarantine,
} from './storage.js';
import type { WorkspaceMutationQuarantine } from './worker.js';

/** Each path is outside sandbox roots and each pending write has a unique owner. */
export function workspaceMutationGuard(
  path: string,
  workerId: string,
  workspaceId: string,
  incarnationId: string,
): WorkspaceMutationQuarantine {
  const owner = (assignmentId?: string): string => {
    if (!assignmentId)
      throw new Error('Workspace mutation requires an assignment owner');
    return `${incarnationId}:${assignmentId}`;
  };
  return {
    async assertAvailable() {
      const record = await loadWorkspaceMutationQuarantine(path);
      if (record != null)
        throw new BridgeProtocolError(
          `Workspace ${workspaceId} is quarantined; inspect it and clear its quarantine before restarting the worker`,
          undefined,
          'WORKSPACE_QUARANTINED',
        );
    },
    async arm(reason, assignmentId) {
      await saveWorkspaceMutationQuarantine(path, {
        version: 1,
        workerId,
        workspaceId,
        ownerId: owner(assignmentId),
        quarantinedAt: new Date().toISOString(),
        reason,
      });
    },
    async clear(assignmentId) {
      await clearWorkspaceMutationQuarantine(path, owner(assignmentId));
    },
    async quarantine(_reason, _cause, assignmentId) {
      await assertWorkspaceMutationQuarantineOwner(path, owner(assignmentId));
    },
  };
}
