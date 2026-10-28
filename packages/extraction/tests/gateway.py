"""Probe the pre-runtime guard independently of the stronger worker filter."""
import ctypes
import errno
import socket
import os
import stat

libc = ctypes.CDLL(None, use_errno=True)
for fd in (0, 1, 2):
    assert not stat.S_ISSOCK(os.fstat(fd).st_mode)
for name, args in [
    ('socket', (socket.AF_UNIX, socket.SOCK_STREAM, 0)),
    ('socketpair', (socket.AF_UNIX, socket.SOCK_STREAM, 0, 0)),
    ('sendmsg', (-1, 0, 0)), ('recvmsg', (-1, 0, 0)),
    ('sendmmsg', (-1, 0, 0, 0)), ('recvmmsg', (-1, 0, 0, 0, 0)),
]:
    assert getattr(libc, name)(*args) == -1, name
    assert ctypes.get_errno() == errno.EPERM, (name, ctypes.get_errno())
with socket.socket(socket.AF_INET, socket.SOCK_STREAM):
    pass
print('Pre-runtime guard: AF_UNIX, socketpair and descriptor-message syscalls denied; IP available')
