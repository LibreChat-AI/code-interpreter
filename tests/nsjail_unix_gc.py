#!/usr/bin/env python3
"""Exercise the rendered policy with the pinned Kafel on Linux.

Usage: python3 tests/nsjail_unix_gc.py POLICY /nsjail/kafel/libkafel.so
Run in the nsjail-builder image. No exploit or cyclic descriptor graph is used.
The filter stays installed until this test process and its children exit.
"""
import array
import ctypes as c
import errno
import http.client
import multiprocessing as mp
import os
import socket
import struct
import sys
import tempfile
import threading


class SockFilter(c.Structure):
    _fields_ = [("code", c.c_ushort), ("jt", c.c_ubyte),
                ("jf", c.c_ubyte), ("k", c.c_uint)]


class SockFprog(c.Structure):
    _fields_ = [("len", c.c_ushort), ("filter", c.POINTER(SockFilter))]


class Iovec(c.Structure):
    _fields_ = [("base", c.c_void_p), ("length", c.c_size_t)]


class Msghdr(c.Structure):
    _fields_ = [("name", c.c_void_p), ("namelen", c.c_uint),
                ("iov", c.POINTER(Iovec)), ("iovlen", c.c_size_t),
                ("control", c.c_void_p), ("controllen", c.c_size_t),
                ("flags", c.c_int)]


class Mmsghdr(c.Structure):
    _fields_ = [("header", Msghdr), ("length", c.c_uint)]


def expect_eperm(call):
    try:
        call()
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError("descriptor-passing send was allowed")


def square(value):
    return value * value


def queue_child(queue):
    queue.put("queue works")


def test_sends(libc, pair):
    left, right = pair
    # A regular-file descriptor avoids creating any socket reference cycle,
    # even if a regressed policy allows the send and the assertion fails.
    descriptor = os.open("/dev/null", os.O_RDONLY)
    rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
               array.array("i", [descriptor]))]
    expect_eperm(lambda: left.sendmsg([b"x"], rights))
    expect_eperm(lambda: left.sendmsg([b"x"]))
    # Valid batch: seccomp must deny even messages without ancillary data.
    data = c.create_string_buffer(b"x")
    iov = Iovec(c.cast(data, c.c_void_p), 1)
    message = Mmsghdr()
    message.header.iov = c.pointer(iov)
    message.header.iovlen = 1
    c.set_errno(0)
    assert libc.sendmmsg(left.fileno(), c.byref(message), 1, 0) == -1
    assert c.get_errno() == errno.EPERM
    control = c.create_string_buffer(socket.CMSG_SPACE(c.sizeof(c.c_int)))
    header = struct.pack("@Nii", socket.CMSG_LEN(c.sizeof(c.c_int)),
                         socket.SOL_SOCKET, socket.SCM_RIGHTS)
    control[:len(header)] = header
    offset = socket.CMSG_LEN(0)
    control[offset:offset + c.sizeof(c.c_int)] = struct.pack("@i", descriptor)
    message.header.control = c.cast(control, c.c_void_p)
    message.header.controllen = socket.CMSG_SPACE(c.sizeof(c.c_int))
    assert libc.sendmmsg(left.fileno(), c.byref(message), 1, 0) == -1
    assert c.get_errno() == errno.EPERM
    os.close(descriptor)
    left.sendall(b"ordinary IPC")
    assert right.recv(12) == b"ordinary IPC"
    left.close()
    right.close()


def test_unix_http():
    with tempfile.TemporaryDirectory() as directory:
        pathname = os.path.join(directory, "tcs.sock")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(pathname)
            listener.listen(1)
            listener.settimeout(5)
            errors = []

            def serve():
                try:
                    with listener.accept()[0] as peer:
                        peer.settimeout(5)
                        request = b""
                        while b"\r\n\r\n" not in request:
                            chunk = peer.recv(4096)
                            assert chunk, "client disconnected before HTTP headers"
                            request += chunk
                        assert request.startswith(b"POST /tool-call HTTP/1.1")
                        peer.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n"
                                     b"Connection: close\r\n\r\n{\"ok\":true}")
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=serve)
            thread.start()
            connection = http.client.HTTPConnection("localhost", timeout=5)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(5)
            connection.sock.connect(pathname)
            try:
                connection.request("POST", "/tool-call", body=b"{}")
                response = connection.getresponse()
                assert response.status == 200
                assert response.read() == b'{"ok":true}'
            finally:
                connection.close()
                thread.join(5)
            assert not thread.is_alive()
            assert not errors, errors


def main():
    # Open before installation to verify the rule also covers inherited FDs.
    inherited = socket.socketpair()
    libc = c.CDLL(None, use_errno=True)
    libc.sendmmsg.argtypes = [c.c_int, c.POINTER(Mmsghdr), c.c_uint, c.c_int]
    kafel = c.CDLL(sys.argv[2])
    kafel.kafel_compile_string.argtypes = [c.c_char_p, c.POINTER(SockFprog)]
    program = SockFprog()
    with open(sys.argv[1], "rb") as source:
        assert kafel.kafel_compile_string(source.read(), c.byref(program)) == 0
    # PR_SET_NO_NEW_PRIVS, followed by PR_SET_SECCOMP / SECCOMP_MODE_FILTER.
    assert libc.prctl(38, 1, 0, 0, 0) == 0
    assert libc.prctl(22, 2, c.byref(program), 0, 0) == 0, c.get_errno()
    # These numbers are shared on x86_64 and arm64. No ring may bypass sends.
    for syscall in (425, 426, 427):
        assert libc.syscall(syscall, 0, 0, 0, 0, 0, 0) == -1
        assert c.get_errno() == errno.EPERM
    test_sends(libc, inherited)
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        test_sends(libc, socket.socketpair(socket.AF_UNIX, kind))
    test_unix_http()
    for method in ("fork", "spawn"):
        context = mp.get_context(method)
        queue = context.Queue()
        process = context.Process(target=queue_child, args=(queue,))
        process.start()
        assert queue.get(timeout=10) == "queue works"
        process.join(10)
        assert process.exitcode == 0
        queue.close()
        queue.join_thread()
        with context.Pool(2) as pool:
            assert pool.map(square, [2, 3, 4]) == [4, 9, 16]
    print("PASS: descriptor sends denied; Unix IPC, HTTP, queues and pools work")


if __name__ == "__main__":
    main()
