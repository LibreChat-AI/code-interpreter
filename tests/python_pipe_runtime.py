"""Runtime transition checks also run under the installed seccomp filter."""
import asyncio
import os
import signal
import stat
import sys


def duplex_child(connection):
    try:
        assert stat.S_ISFIFO(os.fstat(connection.fileno()).st_mode)
        connection.send_bytes(connection.recv_bytes())
    finally:
        connection.close()


async def check_asyncio():
    loop = asyncio.get_running_loop()
    assert stat.S_ISFIFO(os.fstat(loop._ssock.fileno()).st_mode)
    assert stat.S_ISFIFO(os.fstat(loop._csock.fileno()).st_mode)
    assert not os.get_inheritable(loop._ssock.fileno())
    assert not os.get_inheritable(loop._csock.fileno())
    # Executor completion crosses from a worker thread into the event loop.
    values = await asyncio.wait_for(asyncio.gather(*[
        asyncio.to_thread(lambda n=n: n * n) for n in range(64)
    ]), 10)
    assert values == [n * n for n in range(64)]
    awakened = asyncio.Event()
    loop.add_signal_handler(signal.SIGUSR1, awakened.set)
    try:
        os.kill(os.getpid(), signal.SIGUSR1)
        await asyncio.wait_for(awakened.wait(), 2)
    finally:
        loop.remove_signal_handler(signal.SIGUSR1)
    process = await asyncio.create_subprocess_exec(
        sys.executable, '-c', 'print("child works")',
        stdout=asyncio.subprocess.PIPE)
    output, _ = await asyncio.wait_for(process.communicate(), 10)
    assert output == b'child works\n' and process.returncode == 0
    pending = asyncio.create_task(asyncio.sleep(30))
    pending.cancel()
    try:
        await pending
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError('cancellation lost')
