import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  postCleanupMemory,
  postCleanupTmp,
  postCleanupWorkspaces,
  readCleanupResources,
  recordCleanupResources,
} from './cleanup-metrics';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-metrics-'));
  roots.push(root);
  const cgroupRoot = path.join(root, 'cgroup');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(cgroupRoot);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(cgroupRoot, 'memory.current'), '1048576\n');
  fs.writeFileSync(
    path.join(cgroupRoot, 'memory.stat'),
    'anon 262144\nfile 786432\nshmem 524288\n'
  );
  return { cgroupRoot, workspaceRoot, tmpRoot: root };
}

describe('post-cleanup resources', () => {
  test('reads byte-accurate cgroup counters without adding shmem to file', () => {
    const paths = fixture();
    // The API child cgroup excludes sibling jails. Sample the visible root.
    fs.mkdirSync(path.join(paths.cgroupRoot, 'sandbox_api'));
    fs.writeFileSync(
      path.join(paths.cgroupRoot, 'sandbox_api/memory.current'),
      '1'
    );
    const snapshot = readCleanupResources(paths);
    expect(snapshot.memory).toEqual({
      current: 1048576,
      anon: 262144,
      file: 786432,
      shmem: 524288,
    });
    expect(snapshot.tmp?.bytes).toBeGreaterThanOrEqual(0);
    expect(snapshot.tmp?.inodes).toBeGreaterThanOrEqual(0);
    expect(snapshot.errors).toEqual({});
  });

  test('separates disposable, persistent and unexpected entries without following symlinks', () => {
    const paths = fixture();
    fs.mkdirSync(path.join(paths.workspaceRoot, 'ws_active'));
    fs.mkdirSync(path.join(paths.workspaceRoot, 'session'));
    fs.mkdirSync(path.join(paths.workspaceRoot, 'unknown'));
    fs.symlinkSync(paths.tmpRoot, path.join(paths.workspaceRoot, 'ws_symlink'));
    expect(readCleanupResources(paths).workspaces).toEqual({
      disposable: 1,
      session: 1,
      other: 2,
    });
  });

  test('does not turn missing or malformed statistics into a healthy zero', () => {
    const paths = fixture();
    fs.writeFileSync(
      path.join(paths.cgroupRoot, 'memory.stat'),
      'anon 1\nfile 2\n'
    );
    expect(readCleanupResources(paths).memory).toBeNull();
    fs.writeFileSync(
      path.join(paths.cgroupRoot, 'memory.current'),
      'not-a-number'
    );
    const snapshot = readCleanupResources(paths);
    expect(snapshot.memory).toBeNull();
    expect(snapshot.tmp).not.toBeNull();
    expect(snapshot.workspaces).not.toBeNull();
    expect(snapshot.errors.memory).toBe('unavailable');
  });

  test('unreadable sources remove stale gauges without failing cleanup', async () => {
    const paths = fixture();
    const context = {
      job: 'test',
      mode: 'disposable',
      outcome: 'removed',
      suppressSuccessLogs: true,
    } as const;
    recordCleanupResources(context, readCleanupResources(paths));
    expect((await postCleanupMemory.get()).values).toHaveLength(4);
    expect((await postCleanupTmp.get()).values).toHaveLength(3);
    expect((await postCleanupWorkspaces.get()).values).toHaveLength(3);
    fs.rmSync(paths.tmpRoot, { recursive: true });
    const snapshot = readCleanupResources(paths);
    expect(snapshot.errors).toEqual({
      memory: 'ENOENT',
      tmp: 'ENOENT',
      workspaces: 'ENOENT',
    });
    expect(() => recordCleanupResources(context, snapshot)).not.toThrow();
    expect((await postCleanupMemory.get()).values).toHaveLength(0);
    expect((await postCleanupTmp.get()).values).toHaveLength(0);
    expect((await postCleanupWorkspaces.get()).values).toHaveLength(0);
  });
});
