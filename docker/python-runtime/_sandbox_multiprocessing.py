"""Duplex multiprocessing connections backed by two anonymous pipes."""
import os
from multiprocessing.connection import Connection
from multiprocessing.context import reduction


class DuplexConnection(Connection):
    def __init__(self, reader, writer):
        super().__init__(reader)
        self._writer = writer

    def _send(self, data):
        remaining = memoryview(data)
        while remaining:
            written = os.write(self._writer, remaining)
            remaining = remaining[written:]

    def _close(self):
        try:
            os.close(self._handle)
        finally:
            os.close(self._writer)


def rebuild(reader, writer):
    return DuplexConnection(reader.detach(), writer.detach())


def reduce_connection(connection):
    connection._check_closed()
    return rebuild, (reduction.DupFd(connection.fileno()),
                     reduction.DupFd(connection._writer))


reduction.register(DuplexConnection, reduce_connection)


def duplex_pipe():
    first_reader, first_writer = os.pipe()
    try:
        second_reader, second_writer = os.pipe()
    except BaseException:
        os.close(first_reader)
        os.close(first_writer)
        raise
    return (DuplexConnection(first_reader, second_writer),
            DuplexConnection(second_reader, first_writer))
