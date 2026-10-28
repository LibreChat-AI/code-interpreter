#!/usr/bin/env python3
"""A closed request writer must not spin the trusted relay under backpressure."""
import os
import signal
import subprocess
import sys
import tempfile
import time

request_reader, request_writer = os.pipe()
response_reader, response_writer = os.pipe()
os.set_blocking(request_writer, False)
try:
    while True:
        os.write(request_writer, b'x' * 4096)
except BlockingIOError:
    pass  # The upstream deliberately does not drain requests.

with tempfile.TemporaryDirectory() as directory:
    marker = os.path.join(directory, 'ready')
    job = os.path.join(directory, 'job.py')
    with open(job, 'w') as output:
        output.write(f"import os,time; os.write(3,b'x'*4096); os.close(3); open({marker!r},'w').close(); time.sleep(30)")
    bootstrap = (f"import os; os.dup2({request_writer},3); os.dup2({response_reader},4); "
                 f"os.execv('/usr/local/bin/tool-call-pipe-bridge',"
                 f"['tool-call-pipe-bridge','--job-pipes',{sys.executable!r},{job!r}])")
    relay = subprocess.Popen([sys.executable, '-c', bootstrap],
                             pass_fds=[request_writer, response_reader])
    try:
        deadline = time.monotonic() + 5
        while not os.path.exists(marker) and time.monotonic() < deadline:
            assert relay.poll() is None
            time.sleep(0.01)
        assert os.path.exists(marker), 'job did not close its request writer'
        def cpu_seconds():
            with open(f'/proc/{relay.pid}/stat') as source:
                fields = source.read().rsplit(')', 1)[1].split()
            return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
        before = cpu_seconds()
        time.sleep(0.5)
        used = cpu_seconds() - before
        assert used < 0.1, f'relay spun on pipe HUP under backpressure: {used:.3f}s CPU'
        assert relay.poll() is None
        # Closing the broker response writer still terminates the invocation.
        os.close(response_writer)
        response_writer = -1
        assert relay.wait(timeout=2) == 137
        print('PASS: blocked relay stays idle after request EOF and terminates on broker EOF')
    finally:
        if relay.poll() is None:
            relay.send_signal(signal.SIGKILL)
            relay.wait(timeout=2)
for fd in [request_reader, request_writer, response_reader, response_writer]:
    if fd >= 0:
        os.close(fd)
