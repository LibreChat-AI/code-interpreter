import assert from 'node:assert/strict';
import test from 'node:test';
import { relative, sep } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

import { browserSetupAttemptPath, browserSetupProtectedPaths } from './browser-setup.js';

test('browser setup namespace denies journal, lock and crash-left temporaries outside home', async t => {
  const attempt = browserSetupAttemptPath('/srv/code-state/profile.json');
  const paths = browserSetupProtectedPaths(attempt);
  assert.deepEqual(paths, ['/srv/code-state/profile.json.setup']);
  const previous = SandboxManager.getConfig();
  t.after(async () => {
    await SandboxManager.reset();
    if (previous) SandboxManager.updateConfig(previous);
  });
  SandboxManager.updateConfig({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: paths },
    credentials: { files: paths.map(path => ({ path, mode: 'deny' as const })) },
  });
  const effective = SandboxManager.getFsReadConfig();
  for (const file of [attempt, `${attempt}.lock`, `${attempt}.0123456789abcdef.tmp`, `${attempt}.future.tmp`]) {
    assert.ok(effective.denyOnly.some(directory => {
      const child = relative(directory, file);
      return child !== '..' && !child.startsWith(`..${sep}`);
    }), 'every journal generation must remain beneath an effective directory deny');
  }
  assert.deepEqual(browserSetupProtectedPaths(undefined), []);
  assert.throws(() => browserSetupProtectedPaths('/srv/code-state/profile.json.setup.json'), /Unsupported setup journal/);
});
