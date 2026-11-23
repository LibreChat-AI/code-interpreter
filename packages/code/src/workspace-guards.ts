import { BridgeProtocolError } from './protocol.js';
import {
  assertWorkspaceMutationQuarantineOwner,
  clearWorkspaceMutationQuarantine,
  detachedWorkspaceMutationQuarantinePath,
  loadWorkspaceMutationQuarantines,
  saveWorkspaceMutationQuarantine,
} from './storage.js';
import type { WorkspaceMutationQuarantineRecord } from './storage.js';
import type { WorkspaceMutationQuarantine } from './worker.js';

const markerOperations = new Map<string, Promise<void>>();

/**
 * Detached commands let one workspace's markers be armed, cleared and checked at
 * the same time. Each workspace's marker accesses run one after another, so a
 * check never reads a marker this process is still writing.
 */
async function exclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (markerOperations.get(path) ?? Promise.resolve()).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  markerOperations.set(path, settled);
  try {
    return await result;
  } finally {
    if (markerOperations.get(path) === settled) markerOperations.delete(path);
  }
}

/** Each path is outside sandbox roots and each pending write has a unique owner. */
export function workspaceMutationGuard(
  path: string,
  workerId: string,
  workspaceId: string,
  incarnationId: string,
): WorkspaceMutationQuarantine {
  const required = (assignmentId?: string): string => {
    if (!assignmentId)
      throw new Error('Workspace mutation requires an assignment owner');
    return assignmentId;
  };
  const owner = (assignmentId?: string): string =>
    `${incarnationId}:${required(assignmentId)}`;
  const record = (reason: string, assignmentId?: string): WorkspaceMutationQuarantineRecord => ({
    version: 1,
    workerId,
    workspaceId,
    ownerId: owner(assignmentId),
    quarantinedAt: new Date().toISOString(),
    reason,
  });
  const detachedPath = (assignmentId?: string): string =>
    detachedWorkspaceMutationQuarantinePath(path, required(assignmentId));
  const liveOwnerPrefix = `${incarnationId}:`;
  return {
    async assertAvailable(isLive) {
      const records = await exclusive(path, () => loadWorkspaceMutationQuarantines(path));
      const inFlight = ({ ownerId }: WorkspaceMutationQuarantineRecord): boolean =>
        isLive != null &&
        ownerId?.startsWith(liveOwnerPrefix) === true &&
        isLive(ownerId.slice(liveOwnerPrefix.length));
      if (!records.every(inFlight))
        throw new BridgeProtocolError(
          `Workspace ${workspaceId} is quarantined; inspect it and clear its quarantine before restarting the worker`,
          undefined,
          'WORKSPACE_QUARANTINED',
        );
    },
    async arm(reason, assignmentId) {
      const pending = record(reason, assignmentId);
      await exclusive(path, () => saveWorkspaceMutationQuarantine(path, pending));
    },
    async clear(assignmentId) {
      const ownerId = owner(assignmentId);
      await exclusive(path, () => clearWorkspaceMutationQuarantine(path, ownerId));
    },
    async quarantine(_reason, _cause, assignmentId) {
      const ownerId = owner(assignmentId);
      await exclusive(path, () => assertWorkspaceMutationQuarantineOwner(path, ownerId));
    },
    detached: {
      async arm(reason, assignmentId) {
        const marker = detachedPath(assignmentId);
        const pending = record(reason, assignmentId);
        await exclusive(path, () => saveWorkspaceMutationQuarantine(marker, pending));
      },
      async clear(assignmentId) {
        const marker = detachedPath(assignmentId);
        const ownerId = owner(assignmentId);
        await exclusive(path, () => clearWorkspaceMutationQuarantine(marker, ownerId));
      },
      async quarantine(_reason, _cause, assignmentId) {
        const marker = detachedPath(assignmentId);
        const ownerId = owner(assignmentId);
        await exclusive(path, () => assertWorkspaceMutationQuarantineOwner(marker, ownerId));
      },
    },
  };
}
