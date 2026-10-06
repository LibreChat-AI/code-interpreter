#!/usr/bin/env python3
"""Exercise the installed supervisor filter, including inherited Unix sockets."""
import ctypes
import errno
import os
import platform
import socket
import subprocess
import sys

POLICY = '/usr/local/bin/sandbox-supervisor-policy'
if len(sys.argv) > 1 and sys.argv[1] == '--filtered':
    def denied(action):
        try:
            action()
        except OSError as error:
            assert error.errno == errno.EPERM, error
        else:
            raise AssertionError('supervisor syscall allowed')
    denied(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
    denied(socket.socketpair)
    inherited = socket.socket(fileno=int(sys.argv[2]))
    denied(lambda: inherited.sendmsg([b'x'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, b'\0' * 4)]))
    libc = ctypes.CDLL(None, use_errno=True)
    calls = {'x86_64': [307, 425, 426, 427], 'aarch64': [269, 425, 426, 427]}[platform.machine()]
    for number in calls:  # sendmmsg and all io_uring entry points
        assert libc.syscall(number, -1, 0, 0, 0, 0, 0) == -1
        assert ctypes.get_errno() == errno.EPERM
    # TCP remains usable for the API listener and broker upstream.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0)); listener.listen()
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.connect(listener.getsockname())
    peer, _ = listener.accept()
    client.sendall(b'tcp'); assert peer.recv(3) == b'tcp'
    print('PASS: supervisor denies Unix sockets, inherited descriptor sends and io_uring; TCP works')
else:
    left, right = socket.socketpair()
    result = subprocess.run([POLICY, sys.executable, __file__, '--filtered', str(left.fileno())],
                            pass_fds=[left.fileno()], timeout=5)
    assert result.returncode == 0, result.returncode
    # The pipe-based NsJail handshake must handle child setup/exec failure,
    # as well as the successful normal path tested by the runner canary.
    command = [POLICY, '/nsjail/nsjail', '--mode', 'o', '--disable_clone_newnet',
               '--disable_clone_newuser', '--disable_clone_newns', '--disable_clone_newpid',
               '--disable_clone_newipc', '--disable_clone_newuts', '--disable_clone_newcgroup',
               '--disable_proc', '--disable_rlimits', '--', '/missing-codeapi-executable']
    result = subprocess.run(command, capture_output=True, timeout=5)
    assert result.returncode != 0
    assert b'Launching child process failed' in result.stderr, result.stderr
    print('PASS: anonymous NsJail startup handshake reports child exec failure')
