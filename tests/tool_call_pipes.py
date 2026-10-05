#!/usr/bin/env python3
"""End-to-end broker -> anonymous pipes -> NsJail -> guard -> Python client.

Runs in the native nsjail-ipc-test image with Docker's outer filter disabled.
Arguments: rendered policy, built Node broker, generated Python preamble.
"""
import ctypes
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time


class Upstream(http.server.BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.path == '/tool-call'
        assert self.headers['X-Execution-ID'] == 'pipe-test-execution'
        assert self.headers['X-Callback-Token'] == 'pipe-test-token'
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        value = data['input']['n']
        self.calls.append(value)
        time.sleep((8 - value) * 0.01)  # Responses arrive out of order.
        body = json.dumps({'success': True, 'result': value}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    policy, broker, preamble = sys.argv[1:]
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with tempfile.TemporaryDirectory() as directory:
        program = os.path.join(directory, 'client.py')
        with open(preamble) as source:
            client = source.read()
        client += '''
import errno
import socket
import subprocess
assert _stat.S_ISFIFO(os.fstat(3).st_mode)
assert _stat.S_ISFIFO(os.fstat(4).st_mode)
try:
    os.fstat(9)
except OSError:
    pass
else:
    raise AssertionError("unrelated inherited descriptor survived spec-guard")
for domain in (socket.AF_UNIX, socket.AF_INET, socket.AF_INET6):
    try:
        socket.socket(domain, socket.SOCK_STREAM)
    except OSError as error:
        assert error.errno == errno.EPERM
    else:
        raise AssertionError("socket creation was allowed")
async def check():
    results = await asyncio.gather(*[_execute_tool_internal_async("echo", {"n": n}) for n in range(8)])
    assert results == list(range(8)), results
asyncio.run(check())
# The capability must not leak through ordinary subprocess exec.
assert subprocess.check_output([sys.executable, "-c", "import os; print(os.path.exists('/proc/self/fd/3'))"]).strip() == b'False'
print("PASS: real pipes, restricted filter, guard cleanup and concurrent Python tool calls")
'''
        with open(program, 'w') as output:
            output.write(client)
        env = {**os.environ, 'SANDBOX_FORWARD_TARGET': f'http://127.0.0.1:{server.server_port}',
               'TCS_PIPE_BRIDGE': '/usr/local/bin/tool-call-pipe-bridge'}
        command = ['/usr/local/bin/tool-call-pipe-bridge', '--broker', '/usr/local/bin/node', broker, '/nsjail/nsjail', '--mode', 'e',
                   '--disable_clone_newnet', '--disable_clone_newuser', '--disable_clone_newns',
                   '--disable_clone_newpid', '--disable_clone_newipc', '--disable_clone_newuts',
                   '--disable_clone_newcgroup', '--disable_proc', '--disable_rlimits',
                   '--pass_fd', '3', '--pass_fd', '4',
                   '--seccomp_policy', policy, '--', '/usr/local/bin/spec-guard',
                   '--tool-call-pipes', '/usr/bin/python3', program]
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        assert sorted(Upstream.calls) == list(range(8)), Upstream.calls
        print(result.stdout.strip())
    # Losing the response reader must terminate even with no buffered reply.
    with tempfile.TemporaryDirectory() as directory:
        closer = os.path.join(directory, 'close-response.py')
        with open(closer, 'w') as output:
            output.write("import os,time; os.close(4); time.sleep(30)")
        interrupted = subprocess.run(command[:-1] + [closer], env=env,
                                     capture_output=True, text=True, timeout=2)
        assert interrupted.returncode == 137, (interrupted.returncode, interrupted.stdout, interrupted.stderr)
    print('PASS: closing the response reader promptly terminates the invocation')
    # A guest that drains rejection replies must still lose the capability
    # once malformed-claim frames exhaust the broker's admission budget.
    with tempfile.TemporaryDirectory() as directory:
        flooder = os.path.join(directory, 'rejected-frames.py')
        with open(flooder, 'w') as output:
            output.write("""import json,os,struct,threading,time
threading.Thread(target=lambda: [os.read(4, 4096) for _ in range(1000)], daemon=True).start()
frames = []
for id in range(1, 258):
    frame = json.dumps({'id': id, 'headers': {}, 'body': ''}).encode()
    frames.append(struct.pack('!I', len(frame)) + frame)
data = b''.join(frames)
while data:
    data = data[os.write(3, data):]
time.sleep(30)
""")
        interrupted = subprocess.run(command[:-1] + [flooder], env=env,
                                     capture_output=True, text=True, timeout=2)
        assert interrupted.returncode == 137, (interrupted.returncode, interrupted.stdout, interrupted.stderr)
    print('PASS: drained rejection-frame flood promptly terminates the invocation')
    # A killed API/controller must not orphan its broker, relay or job. Become a
    # subreaper so this test can reap both adopted descendants in Docker.
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    with tempfile.TemporaryDirectory() as directory:
        marker = os.path.join(directory, 'job.pid')
        sleeper = os.path.join(directory, 'sleep.py')
        with open(sleeper, 'w') as output:
            output.write(f"import os,time; open({marker!r},'w').write(str(os.getpid())); time.sleep(300)")
        command[-1] = sleeper
        controller = os.path.join(directory, 'controller.js')
        broker_marker = os.path.join(directory, 'broker.pid')
        with open(controller, 'w') as output:
            output.write("import {spawn} from 'node:child_process'; import fs from 'node:fs';"
                         + f"const args={json.dumps(command)};"
                         + "const child=spawn(args[0], args.slice(1), {stdio:['pipe','inherit','inherit']}); child.stdin.end();"
                         + f"fs.writeFileSync({json.dumps(broker_marker)},String(child.pid));"
                         + "setInterval(()=>{},1000);")
        running = subprocess.Popen(['/usr/local/bin/bun', controller], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not os.path.exists(marker) and time.monotonic() < deadline:
                time.sleep(0.01)
            assert os.path.exists(marker), 'job did not start'
            with open(marker) as source:
                job_pid = int(source.read())
            with open(f'/proc/{job_pid}/status') as source:
                relay_pid = next(int(line.split()[1]) for line in source if line.startswith('PPid:'))
            with open(broker_marker) as source:
                broker_pid = int(source.read())
            running.kill()
            running.communicate(timeout=5)
            for pid in [job_pid, relay_pid, broker_pid]:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    reaped, status = os.waitpid(pid, os.WNOHANG)
                    if reaped:
                        assert os.waitstatus_to_exitcode(status) == -9
                        break
                    time.sleep(0.01)
                else:
                    os.kill(pid, 9)
                    raise AssertionError('orphan survived broker death')
        finally:
            if running.poll() is None:
                running.kill()
                running.communicate(timeout=5)
    print('PASS: API death kills and reaps broker, relay and invocation')
    server.shutdown()
    server.server_close()


if __name__ == '__main__':
    main()
