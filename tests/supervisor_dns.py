#!/usr/bin/env python3
"""Run with Docker --dns 127.0.0.1; no external DNS/network dependency."""
import json
import os
import socket
import struct
import subprocess
import threading

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(('127.0.0.1', 53))
queries = []
def serve():
    while True:
        packet, peer = server.recvfrom(4096)
        offset = 12
        labels = []
        while packet[offset]:
            length = packet[offset]
            labels.append(packet[offset + 1:offset + length + 1])
            offset += length + 1
        offset += 1
        kind, cls = struct.unpack('!HH', packet[offset:offset + 4])
        offset += 4
        queries.append((b'.'.join(labels), kind))
        address = socket.inet_pton(socket.AF_INET6 if kind == 28 else socket.AF_INET,
                                   '::1' if kind == 28 else '127.0.0.1')
        reply = packet[:2] + struct.pack('!HHHHH', 0x8180, 1, 1, 0, 0) + packet[12:offset]
        reply += b'\xc0\x0c' + struct.pack('!HHIH', kind, cls, 60, len(address)) + address
        server.sendto(reply, peer)
threading.Thread(target=serve, daemon=True).start()
program = """
const assert=require('node:assert/strict');
assert(process.env.RES_OPTIONS.includes('timeout:1'));
assert(process.env.RES_OPTIONS.includes('single-request'));
require('node:dns').lookup('supervisor-test.invalid.',{all:true},(error,addresses)=>{
  if(error) throw error;
  assert(addresses.length>0);
  assert(addresses.every(a=>a.address==='127.0.0.1'||a.address==='::1'));
  console.log('PASS: hostname resolution under supervisor filter');
});
"""
for runtime in ['/usr/local/bin/node', '/usr/local/bin/bun']:
    result = subprocess.run(['/usr/local/bin/sandbox-supervisor-policy', runtime, '-e', program],
                            env={**os.environ, 'RES_OPTIONS': 'timeout:1 attempts:1'},
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, (runtime, result.stdout, result.stderr)
    print(os.path.basename(runtime) + ': ' + result.stdout.strip())
assert queries and all(name == b'supervisor-test.invalid' for name, _ in queries), queries
