"""Apply checked stdlib edits to the interpreter running this installer."""
from pathlib import Path
import shutil
import sysconfig

root = Path(sysconfig.get_path('stdlib'))
source = Path(__file__).resolve().parent
edits = [
    ('asyncio/selector_events.py',
     '        self._ssock, self._csock = socket.socketpair()',
     '        from _sandbox_pipe import wakeup_pipe\n        self._ssock, self._csock = wakeup_pipe()'),
    ('multiprocessing/connection.py',
     '''        if duplex:
            s1, s2 = socket.socketpair()
            s1.setblocking(True)
            s2.setblocking(True)
            c1 = Connection(s1.detach())
            c2 = Connection(s2.detach())''',
     '''        if duplex:
            from _sandbox_multiprocessing import duplex_pipe
            return duplex_pipe()'''),
]
prepared = []
for name, old, new in edits:
    path = root / name
    text = path.read_text()
    if text.count(new) == 1:
        continue
    if text.count(old) != 1:
        raise RuntimeError(f'unsupported Python runtime layout: {path}')
    prepared.append((path, text.replace(old, new)))
for name in ('_sandbox_pipe.py', '_sandbox_multiprocessing.py'):
    shutil.copyfile(source / name, root / name)
    for cached in (root / '__pycache__').glob(Path(name).stem + '.*.pyc'):
        cached.unlink()
for path, text in prepared:
    path.write_text(text)
    # Avoid reusing timestamp-based bytecode after editing installed sources.
    for cached in (path.parent / '__pycache__').glob(path.stem + '.*.pyc'):
        cached.unlink()
(root / '.sandbox-pipe-runtime-v1').write_text('1\n')
