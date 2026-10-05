#!/usr/bin/env node
// Run inside the sandbox-build image with its Mac/Docker capabilities and a
// read-only /pkgs mount. Arguments: generated pipe preamble, Python version.
// Exercises the signed API route and the normal NsJail namespace/mount setup.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function main() {
  const [preamblePath, version = '3.14.4'] = process.argv.slice(2);
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/tool-call');
      assert.equal(req.headers['x-execution-id'], 'pipe-test-execution');
      assert.equal(req.headers['x-callback-token'], 'pipe-test-token');
      let bytes = '';
      for await (const part of req) bytes += part;
      const { n } = JSON.parse(bytes).input;
      calls.push(n);
      await sleep((8 - n) * 10);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, result: n }));
    } catch (error) { res.writeHead(500).end(JSON.stringify({ success: false, error: String(error) })); }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = upstream.address().port;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const api = spawn('/sandbox_api/entrypoint.sh', [], { cwd: '/sandbox_api', stdio: ['ignore', 'inherit', 'inherit'], env: {
    ...process.env, PORT: '2000', SANDBOX_USE_CGROUPV2: 'false',
    SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP: 'false', SANDBOX_REQUIRE_EGRESS_MANIFEST: 'true',
    SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    SANDBOX_ALLOWED_LOCAL_NETWORK_PORT: String(port), SANDBOX_FORWARD_TARGET: `http://127.0.0.1:${port}`,
    SANDBOX_OUTPUT_MAX_SIZE: '65536', SANDBOX_LOG_LEVEL: 'info',
  }});
  try {
    for (let n = 0; n < 200; n++) {
      if (api.exitCode !== null) throw new Error(`API exited: ${api.exitCode}`);
      try { if ((await fetch('http://127.0.0.1:2000/')).ok) break; } catch {}
      if (n === 199) throw new Error('API did not start');
      await sleep(50);
    }
    const runtimes = await (await fetch('http://127.0.0.1:2000/api/v2/runtimes')).json();
    assert(runtimes.some(runtime => runtime.language === 'python' && runtime.version === version), JSON.stringify(runtimes));
    const outerNamespaces = Object.fromEntries(['net', 'pid', 'mnt', 'user', 'ipc', 'uts', 'cgroup'].map(name => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]));
    const client = fs.readFileSync(preamblePath, 'utf8') + `
import errno, socket, subprocess, sys, multiprocessing as mp
def _mp_echo(sender):
    try:
        _do_request('POST', '/tool-call', '{}')
    except RuntimeError as error:
        assert 'primary process' in str(error)
    else:
        raise AssertionError('child acquired tool-call capability')
    sender.send('child IPC works')
    sender.close()
if __name__ == '__main__':
    assert sys.version.split()[0] == ${JSON.stringify(version)}
    assert os.getuid() == 65534
    assert _stat.S_ISFIFO(os.fstat(3).st_mode) and _stat.S_ISFIFO(os.fstat(4).st_mode)
    for _namespace, _outside in ${JSON.stringify(outerNamespaces)}.items():
        assert os.readlink('/proc/self/ns/' + _namespace) != _outside, _namespace
    for domain in (socket.AF_UNIX, socket.AF_INET, socket.AF_INET6):
        try: socket.socket(domain, socket.SOCK_STREAM)
        except OSError as error: assert error.errno == errno.EPERM
        else: raise AssertionError('socket creation allowed')
    try: socket.socketpair()
    except OSError as error: assert error.errno == errno.EPERM
    else: raise AssertionError('socketpair allowed')
    assert subprocess.check_output([sys.executable, '-c', "import os; print(os.path.exists('/proc/self/fd/3'))"]).strip() == b'False'
    async def check():
        results = await asyncio.gather(*[_execute_tool_internal_async('echo', {'n': n}) for n in range(8)])
        assert results == list(range(8)), results
    asyncio.run(check())
    # Pools need /dev/shm and forkserver needs a named AF_UNIX listener.
    # Test the supported pipe-only spawn/fork multiprocessing paths.
    for method in ('spawn', 'fork'):
        ctx = mp.get_context(method)
        receiver, sender = ctx.Pipe()
        assert _stat.S_ISFIFO(os.fstat(receiver.fileno()).st_mode)
        child = ctx.Process(target=_mp_echo, args=(sender,))
        child.start()
        sender.close()
        assert receiver.poll(5), method
        assert receiver.recv() == 'child IPC works'
        receiver.close()
        child.join(5)
        assert child.exitcode == 0, (method, child.exitcode)
    print('PASS: packaged Python, signed API, NsJail namespaces, pipes, concurrent tools, subprocess and multiprocessing')
`;
    async function execute(content, pipes, language = 'python', runtimeVersion = version) {
      const body = { language, version: runtimeVersion, session_id: `pipe-canary-${crypto.randomUUID()}`, files: [{ name: language === 'bun-js' ? 'main.js' : language === 'bun-ts' ? 'main.ts' : 'main.py', content }], tool_call_socket: pipes, run_timeout: 30000 };
      const now = Math.floor(Date.now() / 1000);
      const claims = { v: 1, exec_id: 'pipe-test-execution', tenant_id: 'canary', user_id: 'canary', session_key: 'canary:user:canary', input_files: [], read_sessions: [], output_session_id: body.session_id, max_upload_bytes: 52428800, max_output_files: 50, max_requests: 1000, iat: now, exp: now + 300, tool_call_socket: pipes, execute_body_sha256: crypto.createHash('sha256').update(canonical(body)).digest('base64url') };
      const payload = canonical(claims);
      body.execution_manifest = `${Buffer.from(payload).toString('base64url')}.${crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
      const response = await fetch('http://127.0.0.1:2000/api/v2/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.run.code, 0, JSON.stringify(result));
      return result;
    }
    const result = await execute(client, true);
    assert.equal(calls.length, 8);
    assert.deepEqual([...calls].sort((a, b) => a - b), [0,1,2,3,4,5,6,7]);
    assert(result.run.stdout.includes('PASS:'), JSON.stringify(result));
    console.log(result.run.stdout.trim());
    // Ordinary jobs still work and do not receive the tool-call descriptors.
    const plain = await execute("import os, asyncio; assert not os.path.exists('/proc/self/fd/3'); asyncio.run(asyncio.to_thread(lambda: 1)); print('PASS: ordinary asyncio execution without pipe capability')", false);
    console.log(plain.run.stdout.trim());
    for (const language of ['bun-js', 'bun-ts']) {
      const js = await execute("console.log('PASS: Bun ' + Bun.version)", false, language, '1.4.2');
      assert(js.run.stdout.includes('PASS: Bun 1.4.2'), JSON.stringify(js));
      console.log(language + ': ' + js.run.stdout.trim());
    }
  } finally {
    api.kill('SIGTERM');
    await once(api, 'exit');
    upstream.closeAllConnections(); upstream.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
