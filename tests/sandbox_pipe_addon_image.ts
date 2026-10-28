// Run in a disposable guest rootfs image with --privileged --network none.
// Exercise the installed entrypoint and bundled API, not the IPC test stage:
// Docker ENV metadata is absent when the rootfs is copied into a runner/VM.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  EXECUTION_MANIFEST_HEADER,
  executionManifestBodySha256,
  signExecutionManifestWithPrivateKey,
} from '../api/src/execution-manifest';

const mode = process.argv[2] ?? 'unset';
assert(['unset', 'empty', 'override'].includes(mode));
const env = { ...process.env };
delete env.SANDBOX_PIPE_ADDON;
if (mode === 'empty') env.SANDBOX_PIPE_ADDON = '';
if (mode === 'override') {
  env.SANDBOX_PIPE_ADDON = '/opt/override-pipes.node';
  copyFileSync('/usr/local/lib/anonymous-pipes.node', env.SANDBOX_PIPE_ADDON);
  unlinkSync('/usr/local/lib/anonymous-pipes.node');
}

// A tiny runtime uses the image's shell, avoiding the unrelated package build.
const runtime = '/pkgs/pipe-smoke/1.0.0';
mkdirSync(runtime, { recursive: true });
writeFileSync(`${runtime}/pkg-info.json`, JSON.stringify({ language: 'pipe-smoke', version: '1.0.0' }));
writeFileSync(`${runtime}/.package-installed`, '');
writeFileSync(`${runtime}/run`, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const server = spawn('/sandbox_api/entrypoint.sh', [], {
  env: {
    ...env,
    // Hosted Docker runners do not delegate cgroups. NsJail namespaces,
    // per-job identities, seccomp and the supervisor filter remain enabled.
    SANDBOX_USE_CGROUPV2: 'false',
    SANDBOX_REQUIRE_EGRESS_MANIFEST: 'true',
    SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    SANDBOX_LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const exited = once(server, 'exit');
const base = 'http://127.0.0.1:2000/api/v2';
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, 'guest entrypoint exited before API readiness');
    ready = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.ok).catch(() => false);
    if (ready) break;
    await Bun.sleep(100);
  }
  assert(ready, 'guest API did not become ready');
  const body = {
    session_id: 'pipe-addon-smoke',
    language: 'pipe-smoke',
    version: '1.0.0',
    stdin: 'packaged anonymous pipes work\n',
    files: [{ name: 'main.sh', content: 'IFS= read -r line; printf "%s\\n" "$line"; printf "pipe stderr\\n" >&2' }],
  };
  const request = (manifest?: string) => fetch(`${base}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(manifest ? { [EXECUTION_MANIFEST_HEADER]: manifest } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal((await request()).status, 401, 'unsigned execution must be rejected');
  const now = Math.floor(Date.now() / 1000);
  const manifest = signExecutionManifestWithPrivateKey({
    v: 1, exec_id: 'pipe-smoke', tenant_id: 'test', user_id: 'test', session_key: 'test',
    input_files: [], read_sessions: [], output_session_id: body.session_id,
    max_upload_bytes: 1024, max_output_files: 1, max_requests: 10,
    iat: now, exp: now + 60, tool_call_socket: false,
    execute_body_sha256: executionManifestBodySha256(body),
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const response = await request(manifest);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.run.code, 0, JSON.stringify(result));
  assert.equal(result.run.stdout, body.stdin);
  assert.equal(result.run.stderr, 'pipe stderr\n');
  console.log(`PASS: packaged guest execution with ${mode} addon path`);
} finally {
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
