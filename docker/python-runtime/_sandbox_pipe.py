"""Pipe-only Linux runtime IPC; seccomp still enforces socket denial."""
import os


class WakeupPipe:
    def __init__(self, fd):
        self._fd = fd

    def __del__(self):
        self.close()

    def fileno(self):
        return self._fd

    def setblocking(self, blocking):
        os.set_blocking(self._fd, blocking)

    def recv(self, size):
        return os.read(self._fd, size)

    def send(self, data):
        return os.write(self._fd, data)

    def close(self):
        fd, self._fd = self._fd, -1
        if fd >= 0:
            os.close(fd)


def wakeup_pipe():
    reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    return WakeupPipe(reader), WakeupPipe(writer)
