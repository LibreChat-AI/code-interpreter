import ctypes
import errno
import fcntl
import os
import resource
import signal
import socket
import struct
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
                  lambda: os.chmod('/jobs/other/secret', 0o777),
                  lambda: fcntl.fcntl(1, fcntl.F_SETOWN, os.getppid()),
                  lambda: fcntl.fcntl(1, 15, struct.pack("ii", 1, os.getppid())),
                  lambda: fcntl.fcntl(1, fcntl.F_SETSIG, 0),
                  lambda: fcntl.ioctl(1, 0x8901, struct.pack("i", os.getppid()))]:
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


# Harmless signal-zero probes distinguish filtering from ordinary permissions.
class Sigval(ctypes.Union):
    _fields_ = [("integer", ctypes.c_int), ("pointer", ctypes.c_void_p)]
libc = ctypes.CDLL(None, use_errno=True)
libc.sigqueue.argtypes = [ctypes.c_int, ctypes.c_int, Sigval]
assert libc.sigqueue(os.getppid(), 0, Sigval(integer=0)) == -1
assert ctypes.get_errno() == errno.EPERM
number = {"x86_64": 297, "aarch64": 240}[os.uname().machine]
info = (ctypes.c_int * 32)()
info[2] = -1  # SI_QUEUE, with signal zero: never delivers a signal.
assert libc.syscall(number, os.getppid(), os.getppid(), 0, ctypes.byref(info)) == -1
assert ctypes.get_errno() == errno.EPERM



try:
    fcntl.ioctl(1, 0, 0)
except PermissionError:
    pass
else:
    raise RuntimeError('Forbidden ioctl')



libc.mq_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
assert libc.mq_open(b"/extraction-negative-probe", os.O_RDONLY) == -1
assert ctypes.get_errno() == errno.EPERM
print("ISOLATED", flush=True)
