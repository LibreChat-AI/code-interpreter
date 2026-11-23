import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearWorkspaceMutationQuarantine,
  detachedWorkspaceMutationQuarantineDirectory,
  detachedWorkspaceMutationQuarantinePath,
  loadWorkspaceMutationQuarantine,
  loadWorkspaceMutationQuarantines,
} from './storage.js';
import { workspaceMutationGuard } from './workspace-guards.js';

import type { FileHandle } from 'node:fs/promises';
import type { TestContext } from 'node:test';

async function markerPath(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-guards-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state', 'workspace.json');
}

const guard = (path: string, incarnationId = 'incarnation-1') =>
  workspaceMutationGuard(path, 'worker', 'repo', incarnationId);

const live = (...assignmentIds: string[]) => (assignmentId: string): boolean =>
  assignmentIds.includes(assignmentId);

const quarantined = { code: 'WORKSPACE_QUARANTINED' };

test('a detached command keeps its own private marker beside the workspace marker', async (t) => {
  const path = await markerPath(t);
  const directory = detachedWorkspaceMutationQuarantineDirectory(path);
  const workspace = guard(path);
  await workspace.arm('ordinary mutation', 'ordinary');
  await workspace.detached!.arm('detached command', 'background-1');
  await workspace.detached!.arm('detached command', 'durable-background_2');
  await assert.rejects(workspace.arm('second ordinary mutation', 'other'), { code: 'EEXIST' });
  await assert.rejects(workspace.detached!.arm('replayed', 'background-1'), { code: 'EEXIST' });

  assert.equal(directory, `${path}.detached`);
  assert.deepEqual((await readdir(directory)).sort(), ['background-1.json', 'durable-background_2.json']);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const marker = detachedWorkspaceMutationQuarantinePath(path, 'background-1');
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  const records = await loadWorkspaceMutationQuarantines(path);
  assert.deepEqual([records[0]?.ownerId, records[0]?.reason], ['incarnation-1:ordinary', 'ordinary mutation']);
  assert.deepEqual(
    records.slice(1).map((record) => [record.ownerId, record.reason]).sort(),
    [
      ['incarnation-1:background-1', 'detached command'],
      ['incarnation-1:durable-background_2', 'detached command'],
    ],
  );

  await workspace.detached!.quarantine('ambiguous', undefined, 'background-1');
  await assert.rejects(
    guard(path, 'incarnation-2').detached!.quarantine('ambiguous', undefined, 'background-1'),
    /owned by another worker incarnation/,
  );
  await assert.rejects(
    guard(path, 'incarnation-2').detached!.clear('background-1'),
    /owned by another worker incarnation/,
  );
  await workspace.detached!.clear('background-1');
  await workspace.clear('ordinary');
  assert.equal(await loadWorkspaceMutationQuarantine(path), undefined);
  assert.deepEqual(await readdir(directory), ['durable-background_2.json']);
  await assert.rejects(workspace.detached!.clear('background-1'), /owned by another worker incarnation/);
});

test('only markers of assignments still running in this incarnation leave a workspace available', async (t) => {
  const path = await markerPath(t);
  const workspace = guard(path);
  await workspace.assertAvailable();
  await workspace.assertAvailable(live());

  await workspace.detached!.arm('detached command', 'background');
  await assert.rejects(workspace.assertAvailable(), quarantined);
  await assert.rejects(workspace.assertAvailable(live('ordinary')), quarantined);
  await workspace.assertAvailable(live('background'));

  await workspace.arm('ordinary mutation', 'ordinary');
  await assert.rejects(workspace.assertAvailable(live('background')), quarantined);
  await workspace.assertAvailable(live('background', 'ordinary'));
  await assert.rejects(
    guard(path, 'incarnation-2').assertAvailable(live('background', 'ordinary')),
    quarantined,
  );

  await workspace.clear('ordinary');
  await workspace.detached!.clear('background');
  await guard(path, 'incarnation-2').assertAvailable();
});

test('a detached marker requires a filename-safe assignment', async (t) => {
  const path = await markerPath(t);
  const workspace = guard(path);
  for (const assignmentId of ['../escape', 'a/b', '', '.', 'x'.repeat(129), 'with space']) {
    await assert.rejects(workspace.detached!.arm('detached command', assignmentId));
  }
  assert.throws(
    () => detachedWorkspaceMutationQuarantinePath(path, '../escape'),
    /filename-safe assignment ID/,
  );
  await assert.rejects(stat(join(path, '..')), { code: 'ENOENT' });
});

test('an operator clear removes every detached marker with the workspace marker', async (t) => {
  const path = await markerPath(t);
  const directory = detachedWorkspaceMutationQuarantineDirectory(path);
  const previous = guard(path, 'incarnation-previous');
  await previous.detached!.arm('detached command', 'background-1');
  await previous.detached!.arm('detached command', 'background-2');
  await writeFile(join(directory, 'torn.json'), '{"version":', { mode: 0o600 });
  await assert.rejects(guard(path).assertAvailable(), /invalid workspace quarantine file/i);

  await clearWorkspaceMutationQuarantine(path);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await guard(path).assertAvailable();

  await previous.arm('ordinary mutation', 'ordinary');
  await previous.detached!.arm('detached command', 'background-3');
  await clearWorkspaceMutationQuarantine(path);
  assert.deepEqual(await loadWorkspaceMutationQuarantines(path), []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('an availability check waits for a marker that is still being armed', async (t) => {
  const path = await markerPath(t);
  const probe = await open(tmpdir(), 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    chmod(mode: number): Promise<void>;
  };
  await probe.close();
  const originalChmod = fileHandlePrototype.chmod;
  let created!: () => void;
  let finish!: () => void;
  let finished = Promise.resolve();
  t.mock.method(fileHandlePrototype, 'chmod', async function (this: FileHandle, mode: number) {
    created();
    await finished;
    return originalChmod.call(this, mode);
  });
  const arms: Array<(workspace: ReturnType<typeof guard>) => Promise<void>> = [
    (workspace) => workspace.arm('ordinary mutation', 'assignment'),
    (workspace) => workspace.detached!.arm('detached command', 'assignment'),
  ];
  for (const arm of arms) {
    const creating = new Promise<void>((resolve) => { created = resolve; });
    finished = new Promise<void>((resolve) => { finish = resolve; });
    const arming = arm(guard(path));
    await creating;
    let settled = false;
    const check = guard(path).assertAvailable(live('assignment')).finally(() => { settled = true; });
    void check.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    finish();
    await arming;
    await check;
  }
  await guard(path).clear('assignment');
  await guard(path).detached!.clear('assignment');
  await guard(path).assertAvailable();
});
