#!/usr/bin/env python3
"""Verify the native guard preserves only validated pipe capabilities."""
import fcntl
import os


def run_guard(pipes, preserve, reversed_ends=False):
    request = os.pipe()
    response = os.pipe()
    ordinary = os.open('/dev/null', os.O_RDWR)
    original = [request[0 if reversed_ends else 1] if pipes else ordinary,
                response[1 if reversed_ends else 0] if pipes else ordinary, ordinary]
    sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10) for fd in original]
    child = os.fork()
    if child == 0:
        for source, destination in zip(sources, [3, 4, 9]):
            os.dup2(source, destination, inheritable=True)
        code = '''
import os, stat
for fd in ([9] if PRESERVE else [3,4,9]):
    try:
        os.fstat(fd)
    except OSError:
        pass
    else:
        raise AssertionError("unrelated FD survived guard: " + str(fd))
if PRESERVE:
    assert stat.S_ISFIFO(os.fstat(3).st_mode)
    assert stat.S_ISFIFO(os.fstat(4).st_mode)
'''.replace('PRESERVE', repr(preserve))
        args = [os.environ.get('SPEC_GUARD_BINARY', '/usr/local/bin/spec-guard')]
        if preserve:
            args.append('--tool-call-pipes')
        os.execv(args[0], args + ['/usr/bin/python3', '-c', code])
    for fd in sources + list(request) + list(response) + [ordinary]:
        os.close(fd)
    _, status = os.waitpid(child, 0)
    return os.waitstatus_to_exitcode(status)


assert run_guard(True, True) == 0
assert run_guard(True, False) == 0
assert run_guard(False, True) == 1
assert run_guard(True, True, reversed_ends=True) == 1
print('PASS: guard preserves only explicit FIFO endpoints and rejects regular files')
