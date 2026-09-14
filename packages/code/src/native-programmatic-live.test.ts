import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';
import { resolveNativeSrtCommandPolicy } from './native-policy.js';

test('real SRT prevents speculative network effects under trusted-vm', {
  skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-ptc-effects-'));
  let effects = 0;
  const server = createServer((_req, res) => { effects += 1; res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const executor = new NativeProcessWorkspaceCommandSandbox({
    workspaceRoot: root,
    commandPolicy: resolveNativeSrtCommandPolicy('trusted-vm'),
    programmaticFileUpstream: `http://127.0.0.1:${port}`,
  });
  try {
    await executor.prepare();
    const result = await executor.executeProgrammatic('primary', { headers: {}, body: {
      language: 'bash', version: '5.2.0', session_id: 'isolated-canary', replay_tool_count: 1,
      run_timeout: 5000,
      files: [{ name: 'main.sh', content: `curl --noproxy '*' --connect-timeout 1 --max-time 2 -s -X POST http://127.0.0.1:${port}/effect >/dev/null\nprintf once >> commit.txt\n` }],
    } }) as { run: { code: number } };
    assert.equal(result.run.code, 0);
    assert.equal(effects, 1, 'probe must not emit a network effect');
    assert.equal(await readFile(join(root, 'commit.txt'), 'utf8'), 'once');
  } finally {
    try { await executor.close(); } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
