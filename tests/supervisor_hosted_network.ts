// Run as root with NET_ADMIN in the packaged guest, under supervisor-policy.
import { installHostedAppNetworkGuard } from '/work/api/src/hosted-app';
import { spawnPipeProcess } from '/work/api/src/pipe-process';
import { once } from 'node:events';
import * as net from 'node:net';
import assert from 'node:assert/strict';

const uid = 200123;
await installHostedAppNetworkGuard(uid);
const upstream = net.createServer();
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const port = (upstream.address() as net.AddressInfo).port;
const child = spawnPipeProcess(process.execPath, ['-e', `
import net from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
process.setgid(${uid}); process.setuid(${uid});
const outbound = net.connect(${port}, '127.0.0.1');
await assert.rejects(once(outbound, 'connect'));
outbound.destroy();
const server = net.createServer(client => client.end('preview reply'));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
console.log(server.address().port);
await once(server, 'connection'); server.close();
`]);
child.stdin.end();
child.stderr.pipe(process.stderr);
const closed = once(child, 'close');
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [bytes] = await once(child.stdout, 'data');
  const preview = net.connect(Number(bytes.toString().trim()), '127.0.0.1');
  let reply = '';
  for await (const chunk of preview) reply += chunk.toString();
  assert.equal(reply, 'preview reply');
  assert.equal((await closed)[0], 0);
  console.log('PASS: hosted-app egress is blocked and inbound preview replies work under supervisor policy');
} finally {
  clearTimeout(timer); child.kill('SIGKILL'); upstream.close();
}
