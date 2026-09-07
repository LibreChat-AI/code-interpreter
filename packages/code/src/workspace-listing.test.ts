import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { TestContext } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { BRIDGE_WORKSPACE_LIST_MAX_RESULTS } from './protocol.js';
import { isWorkspaceToolResult, LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';

const request = {
  protocolVersion: 1 as const,
  operation: 'list_files' as const,
  workspaceId: 'primary',
  maxResults: 1,
};
const skippedPaths = Array.from(
  { length: 2 * (BRIDGE_WORKSPACE_LIST_MAX_RESULTS + request.maxResults) + 5 },
  (_, index) => `a-${String(index).padStart(4, '0')}`,
);

// Control candidate discovery independently of filesystem verification, as
// files can vanish or be replaced by symlinks after rg has enumerated them.
function candidateSource(t: TestContext, paths: string[], onScan?: (scan: number) => void) {
  let scans = 0;
  let cappedScans = 0;
  t.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
    assert.equal(command, 'rg');
    assert.ok(args.includes('--no-follow'));
    assert.ok(args.includes('--null'));
    assert.ok(args.includes('--sort'));
    scans += 1;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => child.emit('close', 0));
    };
    Object.assign(child, {
      stdout,
      kill: () => { cappedScans += 1; close(); return true; },
    });
    onScan?.(scans);
    queueMicrotask(() => {
      if (closed) return;
      stdout.end(Buffer.from(`${paths.join('\0')}\0`));
      close();
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { get scans() { return scans; }, get cappedScans() { return cappedScans; } };
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-list-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await LocalWorkspaceTools.create({ workspaces: [{ id: 'primary', root }] });
  return { root, tools };
}

for (const skippedKind of ['missing', 'symlink'] as const) {
  test(`lists and paginates valid files after multiple windows of ${skippedKind} candidates`, async (t) => {
    const { root, tools } = await workspace(t);
    await writeFile(join(root, 'z-first.txt'), 'first');
    await writeFile(join(root, 'z-last.txt'), 'last');
    if (skippedKind === 'symlink') {
      await Promise.all(skippedPaths.map(path => symlink('z-first.txt', join(root, path))));
    }
    const source = candidateSource(t, [...skippedPaths, 'z-first.txt', 'z-last.txt']);
    const first = await tools.execute(request);
    assert.equal(isWorkspaceToolResult(request, first, tools.capabilities), true);
    assert.deepEqual(first, {
      protocolVersion: 1, operation: 'list_files', workspaceId: 'primary',
      paths: ['z-first.txt'], truncated: true, nextAfterPath: 'z-first.txt',
    });
    assert.equal(source.scans, 3);
    assert.equal(source.cappedScans, 2, 'each full candidate window still stops rg');
    const nextRequest = { ...request, afterPath: 'z-first.txt' };
    const last = await tools.execute(nextRequest);
    assert.equal(isWorkspaceToolResult(nextRequest, last, tools.capabilities), true);
    assert.deepEqual(last, {
      protocolVersion: 1, operation: 'list_files', workspaceId: 'primary',
      paths: ['z-last.txt'], truncated: false,
    });
    assert.equal(source.scans, 4);
  });
}

test('returns a complete empty page when successive skipped windows exhaust the listing', async (t) => {
  const { tools } = await workspace(t);
  const source = candidateSource(t, skippedPaths);
  const result = await tools.execute(request);
  assert.equal(isWorkspaceToolResult(request, result, tools.capabilities), true);
  assert.deepEqual(result, {
    protocolVersion: 1, operation: 'list_files', workspaceId: 'primary',
    paths: [], truncated: false,
  });
  assert.equal(source.scans, 3);
  assert.equal(source.cappedScans, 2);
});

test('successive candidate windows share the original listing deadline', async (t) => {
  const { tools } = await workspace(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const source = candidateSource(t, skippedPaths, () => { now += 6_000; });
  await assert.rejects(tools.execute(request), (error: unknown) =>
    error instanceof WorkspaceToolError && error.code === 'LIST_TIMEOUT');
  assert.equal(source.scans, 2, 'a later window must not reset the ten-second budget');
});

test('cancellation interrupts a later candidate window', async (t) => {
  const { tools } = await workspace(t);
  const controller = new AbortController();
  const source = candidateSource(t, skippedPaths, scan => {
    if (scan === 2) controller.abort();
  });
  await assert.rejects(tools.execute(request, controller.signal), (error: unknown) =>
    error instanceof WorkspaceToolError && error.code === 'EXECUTION_ABORTED');
  assert.equal(source.scans, 2);
});
