#!/usr/bin/env node
// Packaging regression: run in each guest rootfs. Uses the image's own broker,
// Node, bridge, NsJail and guard, with namespaces disabled for this smoke test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

if (process.argv[2] === '--client') {
  assert(fs.fstatSync(3).isFIFO());
  assert(fs.fstatSync(4).isFIFO());
  const frame = Buffer.from(JSON.stringify({ id: 1, headers: {
    'x-execution-id': 'image-smoke', 'x-callback-token': 'image-token', 'x-tool-call-id': 'image-call',
  }, body: '{"tool_name":"echo","input":{}}' }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(frame.length);
  const bytes = Buffer.concat([prefix, frame]);
  for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(3, bytes, offset, bytes.length - offset);
  function readExact(size) {
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const count = fs.readSync(4, bytes, offset, size - offset);
      assert(count > 0, 'broker response ended prematurely'); offset += count;
    }
    return bytes;
  }
  const reply = JSON.parse(readExact(readExact(4).readUInt32BE()).toString());
  assert.deepEqual(reply, { id: 1, status: 200, body: 'packaged runtime works' });
  console.log('PASS: image Node/broker/bridge/NsJail/guard pipe round trip');
} else {
  (async () => {
    const upstream = http.createServer(async (req, res) => {
      assert.equal(req.url, '/tool-call');
      assert.equal(req.headers['x-callback-token'], 'image-token');
      for await (const bytes of req) {}
      res.end('packaged runtime works');
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    let child;
    let timer;
    try {
      child = spawn('/usr/local/bin/tool-call-pipe-bridge', [
        '--broker', '/usr/local/bin/node', '/sandbox_api/.build/tool-call-pipe-broker.cjs',
        '/usr/sbin/nsjail', '--mode', 'e', '--disable_clone_newnet', '--disable_clone_newuser',
        '--disable_clone_newns', '--disable_clone_newpid', '--disable_clone_newipc',
        '--disable_clone_newuts', '--disable_clone_newcgroup', '--disable_proc', '--disable_rlimits',
        '--pass_fd', '3', '--pass_fd', '4', '--', '/usr/local/bin/spec-guard',
        '--tool-call-pipes', '/usr/local/bin/node', '/tests/pipe_runtime_image.cjs', '--client',
      ], { stdio: ['ignore', 'inherit', 'inherit'], env: {
        ...process.env, SANDBOX_FORWARD_TARGET: `http://127.0.0.1:${upstream.address().port}`,
      }});
      timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, `image pipe runtime failed (${signal})`);
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      upstream.closeAllConnections(); upstream.close();
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
