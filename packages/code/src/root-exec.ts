import koffi from 'koffi';

// Private exec trampoline. The parent supplies an already validated directory
// on fd 3. fchdir is process-local here and never changes the bridge's cwd.
const lib = koffi.load(null);
const fchdir = lib.func('int fchdir(int fd)');
const close = lib.func('int close(int fd)');
const execvp = lib.func('int execvp(const char *file, const char **argv)');
const fcntl = lib.func('int fcntl(int fd, int command, ...)');
const args = process.argv.slice(2);
if (args.length === 0 || fchdir(3) !== 0 || close(3) !== 0) process.exit(125);
// Node marks its standard streams close-on-exec during startup. Preserve only
// the three conventional streams; every internal descriptor stays closed.
for (const fd of [0, 1, 2]) {
    if (fcntl(fd, 2 /* F_SETFD */, 'int', 0) !== 0) process.exit(125);
}
execvp(args[0], [...args, null]);
process.exit(126);
