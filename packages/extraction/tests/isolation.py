import os
import resource
import signal
import socket
import sys

if sys.argv[1] == 'hang':
    # Exercise supervisor cancellation/deadline termination, not a cooperative parser.
    while True:
        pass

for path, mode in [('/jobs/other/secret', 'rb'), ('/jobs/other/secret', 'wb'),
                   ('/socket/secret', 'rb'), ('/proc/self/environ', 'rb'), ('/etc/passwd', 'rb')]:
    try:
        with open(path, mode) as file:
            if mode == 'rb':
                file.read()
    except PermissionError:
        pass
    else:
        raise RuntimeError('Cross-boundary file access')
for operation in [lambda: socket.socket(), lambda: socket.socket(socket.AF_UNIX),
                  lambda: os.fork(), lambda: os.kill(os.getppid(), 0),
                  lambda: os.chmod('/jobs/other/secret', 0o777)]:
    try:
        operation()
    except PermissionError:
        pass
    else:
        raise RuntimeError('Forbidden syscall')
assert 'EXTRACTION_SECRET_CANARY' not in os.environ
assert resource.getrlimit(resource.RLIMIT_AS) == (512 * 1024 * 1024,) * 2
assert resource.getrlimit(resource.RLIMIT_CPU) == (8, 8)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (4 * 1024 * 1024,) * 2
assert resource.getrlimit(resource.RLIMIT_NOFILE) == (64, 64)
print('ISOLATED', flush=True)
