import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

let native: { createPipe(): [number, number] } | undefined;
function endpoints(): [number, number] {
  native ??= require(process.env.SANDBOX_PIPE_ADDON || path.resolve(__dirname, '..', '.build', 'anonymous-pipes.node'));
  return native!.createPipe();
}
function close(fd: number): void { try { fs.closeSync(fd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; } }
function readable(fd: number): Readable {
  if (typeof Bun === 'undefined') return new net.Socket({ fd, readable: true, writable: false });
  const stream = Readable.fromWeb(Bun.file(fd).stream() as never);
  stream.once('close', () => close(fd));
  return stream;
}
function writable(fd: number): Writable {
  if (typeof Bun === 'undefined') return new net.Socket({ fd, readable: false, writable: true });
  const sink = Bun.file(fd).writer();
  return new Writable({
    write(chunk, _encoding, callback) {
      try { sink.write(chunk); Promise.resolve(sink.flush()).then(() => callback(), callback); }
      catch (error) { callback(error as Error); }
    },
    final(callback) {
      try { Promise.resolve(sink.end()).then(() => callback(), callback); }
      catch (error) { callback(error as Error); }
    },
    destroy(error, callback) {
      // FileSink duplicates the supplied FD; end also releases that duplicate
      // on spawn failure/cancellation, when _final was never reached.
      try { void Promise.resolve(sink.end()).catch(() => {}); } catch {}
      close(fd); callback(error);
    },
  });
}
/** Linux child stdio uses pipe2 endpoints, never the runtime's socketpairs.
 * Non-Linux development keeps its native spawn implementation. */
export function spawnPipeProcess(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  if (process.platform !== 'linux') return spawn(command, args, options) as ChildProcessWithoutNullStreams;
  const requested = options.stdio ?? ['pipe', 'pipe', 'pipe'];
  const modes = typeof requested === 'string' ? [requested, requested, requested] : requested;
  if (!Array.isArray(modes) || modes.slice(3).some(mode => typeof mode !== 'number')) throw new Error('unsupported anonymous-pipe process stdio');
  const childFds: number[] = [];
  const parentFds: Array<[number, number]> = [];
  const streams: Array<Readable | Writable | null> = [null, null, null];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const stdio = Array.from({ length: Math.max(3, modes.length) }, (_, index) => index).map(index => {
      const mode = modes[index] ?? 'pipe';
      if (mode !== 'pipe') {
        if (mode !== 'ignore' && mode !== 'inherit' && typeof mode !== 'number') throw new Error('unsupported anonymous-pipe process stdio');
        return mode;
      }
      const [reader, writer] = endpoints();
      const parentFd = index === 0 ? writer : reader;
      const childFd = index === 0 ? reader : writer;
      childFds.push(childFd);
      parentFds.push([index, parentFd]);
      return childFd;
    });
    child = spawn(command, args, { ...options, stdio });
    for (const [index, fd] of parentFds) streams[index] = index === 0 ? writable(fd) : readable(fd);
    Object.defineProperties(child, {
      stdin: { value: streams[0] }, stdout: { value: streams[1] }, stderr: { value: streams[2] },
    });
    // Integer stdio descriptors are not owned by ChildProcess. Reproduce its
    // close-after-output semantics and release stdin when the child exits.
    const outputClosed = Promise.all(streams.slice(1).map(stream => stream
      ? new Promise<void>(resolve => stream.once('close', resolve)) : undefined));
    const emit = child.emit;
    child.emit = function (event: string | symbol, ...values: unknown[]): boolean {
      if (event === 'close') {
        void outputClosed.then(() => emit.call(this, event, ...values));
        return true;
      }
      return emit.call(this, event, ...values);
    };
    child.once('exit', () => {
      streams[0]?.destroy();
      // Like native spawn, drain output that has no consumer after exit.
      for (const stream of streams.slice(1)) {
        if (stream && stream.listenerCount('data') === 0 && stream.listenerCount('readable') === 0) (stream as Readable).resume();
      }
    });
    child.once('error', () => { for (const stream of streams) stream?.destroy(); });
    return child as ChildProcessWithoutNullStreams;
  } catch (error) {
    child?.kill('SIGKILL');
    for (const [index, fd] of parentFds) { if (streams[index]) streams[index]!.destroy(); else close(fd); }
    throw error;
  } finally { for (const fd of childFds) close(fd); }
}

export function toolCallPipes(): { child: [number, number]; reader: Readable; writer: Writable; closeChild(): void } {
  const [requestReader, requestWriter] = endpoints();
  let responseReader: number, responseWriter: number;
  try { [responseReader, responseWriter] = endpoints(); }
  catch (error) { close(requestReader); close(requestWriter); throw error; }
  let reader: Readable | undefined;
  let writer: Writable | undefined;
  try {
    reader = readable(requestReader);
    writer = writable(responseWriter);
    let childClosed = false;
    return { child: [requestWriter, responseReader], reader, writer,
      closeChild() { if (!childClosed) { childClosed = true; close(requestWriter); close(responseReader); } } };
  } catch (error) {
    if (reader) reader.destroy(); else close(requestReader);
    if (writer) writer.destroy(); else close(responseWriter);
    close(requestWriter); close(responseReader);
    throw error;
  }
}
