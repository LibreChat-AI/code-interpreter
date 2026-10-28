import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import { register } from 'prom-client';
import { Job } from './job';
import type { Runtime } from './runtime';
import type { SessionWorkspace } from './session-workspace';
import {
  clearRetainedWorkspaceCleanupsForTest,
  retainedWorkspaceCleanupCount,
  retryRetainedWorkspaceCleanups,
  sandboxJobUidPool,
} from './workspace-isolation';

import type {
  SandboxJobIdentity,
  SandboxWorkspaceLease,
} from './workspace-isolation';

interface Internals {
  submissionDir: string;
  workspaceLease?: SandboxWorkspaceLease;
  jobIdentity?: SandboxJobIdentity;
}
const roots: string[] = [];
afterEach(async () => {
  await retryRetainedWorkspaceCleanups();
  clearRetainedWorkspaceCleanupsForTest();
  for (const root of roots.splice(0))
    await fsp.rm(root, { recursive: true, force: true });
});

async function fixture(persistent = false) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'job-cleanup-metric-'));
  roots.push(dir);
  const identity = sandboxJobUidPool.acquire()!;
  expect(identity).not.toBeNull();
  const lease = { dir, workspaceId: path.basename(dir), identity };
  const rt: Runtime = {
    language: 'bash',
    version: new semver.SemVer('5.2.0'),
    aliases: [],
    pkgdir: '/tmp',
    compiled: false,
    env_vars: {},
    timeouts: { compile: 1000, run: 1000 },
    cpu_times: { compile: 1000, run: 1000 },
    memory_limits: { compile: -1, run: -1 },
    max_process_count: 64,
    max_open_files: 64,
    max_file_size: 1000,
    output_max_size: 1000,
  };
  const job = new Job({
    runtime: rt,
    files: [],
    args: [],
    stdin: '',
    timeouts: rt.timeouts,
    cpu_times: rt.cpu_times,
    memory_limits: rt.memory_limits,
    is_synthetic: true,
    session: persistent ? ({} as SessionWorkspace) : undefined,
  });
  Object.assign(job as unknown as Internals, {
    submissionDir: dir,
    workspaceLease: lease,
    jobIdentity: identity,
  });
  return { job, dir, identity };
}

async function counter(mode: string, outcome: string): Promise<number> {
  const metric = register.getSingleMetric('codeapi_sandbox_cleanup_total')!;
  return (
    (await metric.get()).values.find(
      value => value.labels.mode === mode && value.labels.outcome === outcome
    )?.value ?? 0
  );
}

test('failed removal is measured as retained and does not release its UID before retry', async () => {
  const activeBefore = sandboxJobUidPool.activeCount();
  const retainedBefore = await counter('disposable', 'retained');
  const { job, dir } = await fixture();
  const rm = spyOn(fsp, 'rm').mockRejectedValueOnce(
    Object.assign(new Error('test busy workspace'), { code: 'EBUSY' })
  );
  try {
    await job.cleanup();
    expect(await counter('disposable', 'retained')).toBe(retainedBefore + 1);
    expect(sandboxJobUidPool.activeCount()).toBe(activeBefore + 1);
    expect(retainedWorkspaceCleanupCount()).toBe(1);
    expect((await fsp.lstat(dir)).isDirectory()).toBe(true);
  } finally {
    rm.mockRestore();
    await retryRetainedWorkspaceCleanups();
  }
  expect(sandboxJobUidPool.activeCount()).toBe(activeBefore);
  expect(await fsp.lstat(dir).catch(() => null)).toBeNull();
});

test('session cleanup is measured as preserved and retains both files and pinned UID', async () => {
  const activeBefore = sandboxJobUidPool.activeCount();
  const preservedBefore = await counter('session', 'preserved');
  const { job, dir, identity } = await fixture(true);
  try {
    await fsp.writeFile(path.join(dir, 'state'), 'keep');
    await job.cleanup();
    expect(await counter('session', 'preserved')).toBe(preservedBefore + 1);
    expect(await fsp.readFile(path.join(dir, 'state'), 'utf8')).toBe('keep');
    expect(sandboxJobUidPool.activeCount()).toBe(activeBefore + 1);
  } finally {
    sandboxJobUidPool.release(identity);
  }
});
