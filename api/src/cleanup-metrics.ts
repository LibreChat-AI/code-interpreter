import * as fs from 'fs';
import * as path from 'path';
import { Counter, Gauge } from 'prom-client';
import { logger } from './logger';
import {
  SANDBOX_WORKSPACE_ROOT,
  SESSION_WORKSPACE_ID,
  WORKSPACE_ID_PREFIX,
  retainedWorkspaceCleanupCount,
  sandboxJobUidPool,
} from './workspace-isolation';

const memoryKinds = ['current', 'anon', 'file', 'shmem'] as const;
const workspaceKinds = ['disposable', 'session', 'other'] as const;
type MemoryKind = typeof memoryKinds[number];
type WorkspaceKind = typeof workspaceKinds[number];

export const postCleanupMemory = new Gauge({
  name: 'codeapi_sandbox_post_cleanup_memory_bytes',
  help: 'Last post-cleanup cgroup-root memory sample; file includes shmem, not additive',
  labelNames: ['kind'] as const,
});
export const postCleanupTmp = new Gauge({
  name: 'codeapi_sandbox_post_cleanup_tmp_used',
  help: 'Last post-cleanup /tmp filesystem allocation, including unlinked open files',
  labelNames: ['resource'] as const,
});
export const postCleanupWorkspaces = new Gauge({
  name: 'codeapi_sandbox_post_cleanup_workspaces',
  help: 'Remaining workspace-root entries after cleanup; includes other active jobs',
  labelNames: ['kind'] as const,
});
const cleanupAttempts = new Counter({
  name: 'codeapi_sandbox_cleanup_total',
  help: 'Job cleanup attempts; session workspaces are intentionally preserved',
  labelNames: ['mode', 'outcome'] as const,
});
const sampleSuccess = new Gauge({
  name: 'codeapi_sandbox_post_cleanup_sample_success',
  help: 'Whether each source was readable on the last post-cleanup sample',
  labelNames: ['source'] as const,
});
const sampleTimestamp = new Gauge({
  name: 'codeapi_sandbox_post_cleanup_timestamp_seconds',
  help: 'Timestamp of the last job cleanup resource sample, not a live usage gauge',
});

export interface CleanupResourceSnapshot {
  memory: Record<MemoryKind, number> | null;
  tmp: { bytes: number; inodes: number; isTmpfs: boolean } | null;
  workspaces: Record<WorkspaceKind, number> | null;
  errors: Partial<Record<'memory' | 'tmp' | 'workspaces', string>>;
}

/** Read only fixed kernel files and the workspace root, never recurse into
 * untrusted workspace trees or follow their symlinks. Synchronous sampling
 * avoids older, slower samples overwriting newer ones during parallel cleanup.
 * The visible cgroup mount root includes the API AND sibling NsJail cgroups;
 * /proc/self/cgroup may point only at the delegated sandbox_api child instead.
 * These are runner-wide observations, not memory attributable to one job. */
export function readCleanupResources(
  paths: {
    cgroupRoot?: string;
    tmpRoot?: string;
    workspaceRoot?: string;
  } = {}
): CleanupResourceSnapshot {
  const snapshot: CleanupResourceSnapshot = {
    memory: null,
    tmp: null,
    workspaces: null,
    errors: {},
  };
  function sample<T>(
    source: keyof CleanupResourceSnapshot['errors'],
    read: () => T
  ): T | null {
    try {
      return read();
    } catch (error) {
      snapshot.errors[source] =
        (error as NodeJS.ErrnoException).code ?? 'unavailable';
      return null;
    }
  }
  snapshot.memory = sample('memory', () => {
    const root = paths.cgroupRoot ?? '/sys/fs/cgroup';
    const current = fs
      .readFileSync(path.join(root, 'memory.current'), 'utf8')
      .trim();
    const stat = fs.readFileSync(path.join(root, 'memory.stat'), 'utf8');
    const values = Object.fromEntries(
      stat
        .trim()
        .split('\n')
        .map(line => line.trim().split(/\s+/))
    );
    const result = {} as Record<MemoryKind, number>;
    for (const kind of memoryKinds) {
      const raw = kind === 'current' ? current : values[kind];
      if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error('Invalid memory statistic');
      }
      result[kind] = Number(raw);
    }
    return result;
  });
  snapshot.tmp = sample('tmp', () => {
    const stat = fs.statfsSync(paths.tmpRoot ?? '/tmp');
    return {
      bytes: (stat.blocks - stat.bfree) * stat.bsize,
      inodes: stat.files - stat.ffree,
      isTmpfs: stat.type === 0x01021994,
    };
  });
  snapshot.workspaces = sample('workspaces', () => {
    const counts = { disposable: 0, session: 0, other: 0 };
    for (const entry of fs.readdirSync(
      paths.workspaceRoot ?? SANDBOX_WORKSPACE_ROOT,
      { withFileTypes: true }
    )) {
      const kind =
        entry.isDirectory() && entry.name === SESSION_WORKSPACE_ID
          ? 'session'
          : entry.isDirectory() && entry.name.startsWith(WORKSPACE_ID_PREFIX)
          ? 'disposable'
          : 'other';
      counts[kind]++;
    }
    return counts;
  });
  return snapshot;
}

export function recordCleanupResources(
  context: {
    job: string;
    mode: 'disposable' | 'session';
    outcome: 'removed' | 'preserved' | 'retained' | 'error';
    suppressSuccessLogs?: boolean;
  },
  snapshot = readCleanupResources()
): void {
  cleanupAttempts.inc({ mode: context.mode, outcome: context.outcome });
  sampleTimestamp.set(Date.now() / 1000);
  for (const source of ['memory', 'tmp', 'workspaces'] as const) {
    sampleSuccess.set({ source }, snapshot[source] === null ? 0 : 1);
  }
  for (const kind of memoryKinds) {
    if (snapshot.memory) postCleanupMemory.set({ kind }, snapshot.memory[kind]);
    else postCleanupMemory.remove({ kind });
  }
  for (const resource of ['bytes', 'inodes', 'is_tmpfs'] as const) {
    if (snapshot.tmp) {
      postCleanupTmp.set(
        { resource },
        resource === 'is_tmpfs'
          ? Number(snapshot.tmp.isTmpfs)
          : snapshot.tmp[resource]
      );
    } else postCleanupTmp.remove({ resource });
  }
  for (const kind of workspaceKinds) {
    if (snapshot.workspaces)
      postCleanupWorkspaces.set({ kind }, snapshot.workspaces[kind]);
    else postCleanupWorkspaces.remove({ kind });
  }
  if (
    !context.suppressSuccessLogs ||
    context.outcome === 'retained' ||
    context.outcome === 'error'
  ) {
    logger.info(
      {
        job: context.job,
        mode: context.mode,
        outcome: context.outcome,
        ...snapshot,
        activeUidSlots: sandboxJobUidPool.activeCount(),
        retainedCleanups: retainedWorkspaceCleanupCount(),
      },
      'Post-cleanup resources'
    );
  }
}
