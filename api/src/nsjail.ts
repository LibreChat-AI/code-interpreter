import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { nanoid } from 'nanoid';
import { config } from './config';
import { logger } from './logger';
import { defaultNsJailSetupGate, type NsJailSetupGate } from './nsjail-setup-gate';
import { nsjailSetupGateWatchdogFires } from './metrics';
import { SANDBOX_INSIDE_GID, SANDBOX_INSIDE_UID, type SandboxJobIdentity } from './workspace-isolation';

export interface NsJailResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  output: string;
  memory: number | null;
  message: string | null;
  status: string | null;
  cpu_time: number | null;
  wall_time: number | null;
}

const SIGNALS: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL',
  5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2',
  13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 24: 'SIGXCPU',
  25: 'SIGXFSZ', 31: 'SIGSYS',
};

const TIME_LIMIT_RE = /time limit/i;
const OOM_RE = /cgroup.*oom|out of memory|mem_max/i;
const SIGNAL_RE = /exited with.*signal.*?(\d+)/;

/* New-mount-API syscall numbers are shared between x86_64 and arm64 (Linux
 * 5.2 onwards). Defining them explicitly avoids relying on the bundled Kafel
 * symbol table knowing the names — NsJail pins an older Kafel snapshot. */
const sharedSyscallDefines = [
  '#define io_uring_setup 425',
  '#define io_uring_enter 426',
  '#define io_uring_register 427',
  '#define clone3 435',
  '#define open_tree 428',
  '#define move_mount 429',
  '#define fsopen 430',
  '#define fsmount 432',
  '#define fspick 433',
  '#define mount_setattr 442',
  /* pidfd_* are Linux 5.1+/5.3+ — newer than Kafel's bundled symbol
   * table on the pinned NsJail snapshot, so define numerically. Same
   * number on x86_64 and arm64. */
  '#define pidfd_send_signal 424',
  '#define pidfd_open 434',
];

const syscallDefines = process.arch === 'arm64'
  ? [
      ...sharedSyscallDefines,
      '#define umount2 39',
      '#define seccomp 277',
      '#define kexec_file_load 294',
      '#define setns 268',
      '#define syslog 116',
      '#define settimeofday 170',
      '#define adjtimex 171',
      '#define clock_adjtime 266',
      /* ioperm, iopl, modify_ldt are x86-only; lookup_dcookie was deprecated
       * upstream and is not present on arm64 in recent kernels. */
    ]
  : [
      ...sharedSyscallDefines,
      '#define umount2 166',
      '#define seccomp 317',
      '#define kexec_file_load 320',
      '#define setns 308',
      '#define syslog 103',
      '#define settimeofday 164',
      '#define adjtimex 159',
      '#define clock_adjtime 305',
      '#define ioperm 173',
      '#define iopl 172',
      '#define modify_ldt 154',
      '#define lookup_dcookie 212',
    ];

const kexecSyscalls = '    kexec_load, kexec_file_load, bpf, perf_event_open,';

/* x86-only syscalls that must not appear in the arm64 policy or Kafel will
 * fail to parse (the symbol/define is absent). lookup_dcookie was deprecated
 * upstream and removed in recent kernels; keeping it on x86_64 is defense-
 * in-depth, dropped on arm64 where the syscall slot is unused. */
const archSpecificLowPrioritySyscalls = process.arch === 'arm64'
  ? ''
  : '    ioperm, iopl, modify_ldt, lookup_dcookie,';

const SECCOMP_POLICY = [
  ...syscallDefines,
  '#define AF_INET 2',
  '#define AF_INET6 10',
  '#define AF_NETLINK 16',
  '#define AF_KEY 15',
  '#define AF_RXRPC 33',
  '#define AF_ALG 38',
  '#define AF_VSOCK 40',
  '#define CLONE_NAMESPACE_FLAGS 0x7e020000',
  '#define KVM_IOCTL_MAGIC 0xAE00',
  'POLICY sandbox {',
  '  KILL {',
  '    ptrace, memfd_create, personality, userfaultfd,',
  kexecSyscalls,
  '    add_key, request_key, keyctl,',
  '    mount, umount2, pivot_root,',
  /* New mount API (Linux 5.2+) — orthogonal to mount(2) and not covered by
   * the line above. open_tree+mount_setattr+move_mount can replicate a
   * read-only bind-mount; fsopen/fsmount/fspick form the filesystem-context
   * flow. The runner needs these before NsJail starts, but sandboxed code does not. */
  '    move_mount, open_tree, mount_setattr, fsopen, fsmount, fspick,',
  '    swapon, swapoff, reboot,',
  '    init_module, finit_module, delete_module,',
  /* setns joins an existing namespace via fd. Unshare is already blocked
   * above; setns closes the other side of that surface. */
  '    unshare, setns, seccomp,',
  '    process_vm_readv, process_vm_writev,',
  '    acct, quotactl,',
  /* Defense-in-depth batch (kernel returns EPERM/ENOSYS without caps, but
   * an explicit KILL surfaces the intent and protects against future kernel
   * config drift). settimeofday/adjtimex/clock_adjtime: clock manipulation.
   * syslog: kernel ring buffer. ioperm/iopl/modify_ldt: x86 ring-0-adjacent
   * surfaces. lookup_dcookie: profiling, deprecated upstream. */
  '    settimeofday, adjtimex, clock_adjtime, syslog,',
  archSpecificLowPrioritySyscalls,
  /* AF_VSOCK reaches the host hypervisor on KVM-based runners (the runner
   * launcher uses krun -> libkrun; the guest sees virtio-vsock). Audit
   * showed a VSOCK socket() succeeded and connect() hung instead of
   * returning ENETUNREACH. KILL it explicitly so synthetic coverage sees
   * SIGSYS rather than an ordinary EPERM-style denial. */
  '    socket(domain) { domain == AF_VSOCK },',
  '    ioctl(fd, request) { (request & 0xFF00) == KVM_IOCTL_MAGIC }',
  '  },',
  '  ERRNO(38) {',
  '    clone3',
  '  },',
  '  ERRNO(1) {',
  '    io_uring_setup, io_uring_enter, io_uring_register, sched_setaffinity, vmsplice,',
  '    clone(flags) { (flags & CLONE_NAMESPACE_FLAGS) != 0 },',
  /* Block signals to PID 1 of the sandbox PID namespace (the NsJail
   * monitor). With clone_newpid the user can't reach other tenants — but
   * killing their own ns's PID 1 still races NsJail's cleanup ordering and
   * the supervisor shouldn't be reachable from inside the sandbox. Also
   * blocks process-group (pid==0) and "everything signalable" (pid==-1)
   * forms which would catch the monitor in their fan-out. ERRNO(1) (EPERM)
   * matches the kernel's standard "you may not signal init" behavior so
   * runtimes that probe with kill(pid, 0) get a familiar error instead
   * of a SIGSYS-killed process. */
  '    kill(pid) { pid == 0 || pid == 1 || pid == 0xFFFFFFFF },',
  '    tkill(tid) { tid == 1 },',
  '    tgkill(tgid, tid) { tgid == 1 || tid == 1 },',
  '    rt_sigqueueinfo(pid) { pid == 0 || pid == 1 || pid == 0xFFFFFFFF },',
  '    rt_tgsigqueueinfo(tgid, tid) { tgid == 1 || tid == 1 },',
  /* pidfd_open(pid==1) would hand out a pidfd to the monitor; block at
   * acquisition. pidfd_send_signal targets a pidfd (not a numeric pid)
   * so we can't filter by destination — but a pidfd to PID 1 can also be
   * obtained via openat("/proc/1", O_RDONLY) since Linux 5.4, so refuse
   * the syscall outright. Neither call is used by Python/Node/Bun
   * runtimes the sandbox supports. */
  '    pidfd_open(pid) { pid == 1 },',
  '    pidfd_send_signal,',
  /* Block direct network and kernel-control socket domains from sandboxed
   * code. AF_ALG covers the Linux kernel crypto API used by Copy Fail, and
   * AF_RXRPC covers the RxRPC family used by Dirty Frag. */
  '    socket(domain) { domain == AF_INET || domain == AF_INET6 || domain == AF_NETLINK || domain == AF_KEY || domain == AF_RXRPC || domain == AF_ALG }',
  '  }',
  '}',
  'USE sandbox DEFAULT ALLOW',
].filter(line => line !== '').join('\n');

export { SIGNALS };

/* Base sandbox.cfg cached at module load. Per-job runs append a dynamic
 * /mnt/data mount block (see renderJobConfigOverlay) so the bind can carry
 * noexec/nosuid/nodev — flags NsJail's CLI -B form does not accept. */
let cachedBaseConfig: string | null = null;
function readBaseConfig(): string {
  if (cachedBaseConfig === null) {
    cachedBaseConfig = fs.readFileSync(config.nsjail_config, 'utf8');
  }
  return cachedBaseConfig;
}

/* Render a `mount {}` block that binds `submissionDir` at /mnt/data with
 * noexec/nosuid/nodev. The destination is fixed; the source path is the
 * per-job workspace. Path comes from createSandboxWorkspace and lives
 * under a known prefix (no user-controlled bytes), but we still escape
 * embedded backslashes and double-quotes defensively in case future
 * callers pass arbitrary paths in. The cfg syntax is C-like so only those
 * two characters need escaping inside a string literal. */
export function renderJobConfigOverlay(submissionDir: string): string {
  const escaped = submissionDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '',
    '# Per-job submission workspace bind. Dynamic because the source path',
    '# rotates every execution. noexec/nosuid/nodev block the audit pattern',
    '# of `chmod +x /mnt/data/x.sh && /mnt/data/x.sh` — neither user code',
    '# nor any helper can run a binary from the writable scratch dir.',
    'mount {',
    `    src: "${escaped}"`,
    '    dst: "/mnt/data"',
    '    is_bind: true',
    '    rw: true',
    '    noexec: true',
    '    nosuid: true',
    '    nodev: true',
    '}',
    '',
  ].join('\n');
}

interface ExecuteOptions {
  command: string[];
  envVars: Record<string, string>;
  submissionDir: string;
  pkgdir: string;
  timeout: number;
  memoryLimit: number;
  outputMaxSize: number;
  stdin?: string;
  extraPkgdirs?: string[];
  identity: SandboxJobIdentity;
  enableToolCallSocket?: boolean;
  suppressSuccessLogs?: boolean;
}

export async function execute(opts: ExecuteOptions, setupGate: NsJailSetupGate = defaultNsJailSetupGate): Promise<NsJailResult> {
  const {
    command,
    envVars,
    submissionDir,
    pkgdir,
    timeout,
    memoryLimit,
    outputMaxSize,
    stdin,
    extraPkgdirs,
    identity,
    enableToolCallSocket,
    suppressSuccessLogs,
  } = opts;
  const logId = nanoid();
  const logPath = `/tmp/nsjail-${logId}.log`;
  const cfgPath = `/tmp/nsjail-${logId}.cfg`;

  fs.writeFileSync(cfgPath, readBaseConfig() + renderJobConfigOverlay(submissionDir), { mode: 0o600 });

  const nsjailArgs = buildArgs({
    logPath,
    cfgPath,
    pkgdir,
    timeout,
    memoryLimit,
    envVars,
    command,
    extraPkgdirs,
    identity,
    enableToolCallSocket,
  });

  const startTime = Date.now();
  const hasStdin = stdin !== undefined && stdin.length > 0;

  let stdout = '';
  let stderr = '';
  let output = '';
  let killed = false;
  let killMessage: string | null = null;
  let killStatus: string | null = null;
  let stderrTruncated = false;

  function drainStream(
    child: ChildProcessWithoutNullStreams,
    stream: NodeJS.ReadableStream,
    target: 'stdout' | 'stderr',
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const decoder = new TextDecoder();
      stream.on('data', (data: Buffer | string) => {
        const buf = typeof data === 'string' ? Buffer.from(data) : data;
        const chunk = decoder.decode(buf, { stream: true });

        if (target === 'stdout') {
          if (stdout.length + chunk.length > outputMaxSize) {
            const remaining = outputMaxSize - stdout.length;
            if (remaining > 0) {
              stdout += chunk.slice(0, remaining);
              output += chunk.slice(0, remaining);
            }
            if (!killed) {
              killMessage = 'stdout length exceeded';
              killStatus = 'OL';
              killed = true;
              child.kill('SIGKILL');
            }
            return;
          }
          stdout += chunk;
          output += chunk;
        } else {
          /* stderr overflow must not kill the job: noisy-but-healthy
           * processes (e.g. libraries that dump stack traces per operation)
           * would lose their entire computation over diagnostics. Truncate
           * at the cap and keep draining so the pipe never back-pressures;
           * a marker is appended after exit so consumers see what happened.
           * stdout overflow still kills below — stdout is the product, and
           * a runaway producer should stop paying for compute. */
          if (stderrTruncated) {
            return;
          }
          if (stderr.length + chunk.length > outputMaxSize) {
            const remaining = outputMaxSize - stderr.length;
            if (remaining > 0) {
              stderr += chunk.slice(0, remaining);
              output += chunk.slice(0, remaining);
            }
            stderrTruncated = true;
            return;
          }
          stderr += chunk;
          output += chunk;
        }
      });
      /* Defensive: if the stream is already closed at attach time, late
       * listeners may not see the events. */
      const s = stream as NodeJS.ReadableStream & { destroyed?: boolean; readableEnded?: boolean };
      if (s.destroyed === true || s.readableEnded === true) {
        resolve();
        return;
      }
      /* Resolve on 'end' OR 'close'. Normal exits emit both; a spawn
       * failure (ENOENT/EACCES — the binary never started) emits only
       * 'close' under Bun's node:child_process compat — 'end' never
       * fires because no producer ever opened the write side. */
      let resolved = false;
      const done = (): void => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', reject);
    });
  }

  /* NsJail's mount-setup phase races on the host-shared `/tmp/nsjail.0.root`
   * directory when multiple jails launch concurrently in the same pod (root
   * runner -> orig_uid=0 in NsJail's per-uid setup dir name). The gate
   * serializes only spawn() -> "Executing" log marker, then releases so the
   * inner job runs in parallel with siblings.
   *
   * Switched from Bun.spawn() to node:child_process.spawn(): empirically
   * 15-25% faster under realistic load on the runner (8 in-flight, 2000
   * /bin/sh invocations with ~4 KiB stdout each + per-job cfg write/unlink:
   * 732 ms -> 585 ms, ~25% faster). Trivial /bin/sh "echo" peaks the gap
   * at 2.3x (715 ms vs 315 ms) because Bun.spawn's serialization overhead
   * dominates when there's no I/O; once pipes actually carry data the
   * gap narrows. Pipe FD lifecycle is equivalent — both methods steady
   * at baseline FD count across 2000+ spawns, sequential and concurrent. */
  let proc: ChildProcessWithoutNullStreams;
  let stdoutDrain: Promise<void> | undefined;
  let stderrDrain: Promise<void> | undefined;
  let markerSeen = false;
  let pollError: NodeJS.ErrnoException | undefined;
  /* Async spawn-failure state. ChildProcess emits 'error' (not throws)
   * for ENOENT/EACCES/EAGAIN; captured in the lambda below so the
   * function can short-circuit the drain wait and surface a controlled
   * `Failed to spawn nsjail: ...` to the caller, matching the
   * synchronous-failure path's contract. */
  let spawnError: NodeJS.ErrnoException | null = null;
  /* Aborts the setup-gate's marker-poll loop the instant the child
   * dies — without it, every async spawn failure pays the full
   * watchdogMs (default 1500ms) while holding the serialized gate,
   * stalling every queued job behind it (queue-wide latency amplification
   * on a misconfigured nsjail_path or fork-pressure burst). */
  const childDiedSignal = new AbortController();
  try {
    ({ value: proc, markerSeen, pollError } = await setupGate.runSetup(logPath, () => {
      const child = spawn(config.nsjail_path, nsjailArgs, {
        /* stdin always 'pipe' so we have a writable handle to .end() even
         * when no input is supplied. The child sees EOF on stdin
         * immediately, equivalent to the previous Bun.spawn 'ignore'. */
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      /* Attach the 'error' listener SYNCHRONOUSLY before any await. The
       * setup gate then polls the log file for ~tens of ms; during that
       * window, an async spawn failure (ENOENT for a missing nsjail
       * binary, EACCES for a non-executable path, EAGAIN for fork
       * pressure) emits on the ChildProcess instance and — without a
       * listener — kills the runner via uncaughtException. Also
       * triggers the abort signal so the gate releases on the very
       * next poll iteration instead of waiting the watchdog. */
      child.on('error', err => {
        const errno = err as NodeJS.ErrnoException;
        if (spawnError === null) spawnError = errno;
        logger.warn(
          { logId, err: { code: errno.code, message: errno.message } },
          'nsjail child process error',
        );
        childDiedSignal.abort();
      });
      /* Belt-and-braces: in some Node versions / posix_spawn paths, the
       * 'close' event fires for a failed spawn without a paired 'error'.
       * Aborting on close too guarantees the gate releases regardless
       * of which event sequence the runtime picks. */
      child.on('close', () => childDiedSignal.abort());
      stdoutDrain = drainStream(child, child.stdout, 'stdout');
      stderrDrain = drainStream(child, child.stderr, 'stderr');
      void stdoutDrain.catch(() => {});
      void stderrDrain.catch(() => {});
      /* Attach a stdin 'error' handler before the setup gate can wait. If
       * nsjail exits before the caller writes stdin, the stream may emit
       * EPIPE while the gate is still polling. */
      child.stdin.on('error', err => {
        const errno = err as NodeJS.ErrnoException;
        logger.warn(
          { logId, err: { code: errno.code, message: errno.message } },
          'nsjail stdin pipe error (child likely exited mid-write)',
        );
      });
      return child;
    }, childDiedSignal.signal));
  } catch (err) {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    throw new Error(`Failed to spawn nsjail: ${(err as Error).message}`);
  }
  /* Short-circuit BEFORE the drain wait AND BEFORE the watchdog-warn
   * branch when the child has already died. Throwing first surfaces the
   * actual cause (ENOENT etc) and suppresses the misleading "watchdog
   * fired" warning + metric increment. Cleanup mirrors the
   * synchronous-spawn-failure catch above. */
  if (spawnError) {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    const errno: NodeJS.ErrnoException = spawnError;
    throw new Error(`Failed to spawn nsjail: ${errno.code ?? 'UNKNOWN'}: ${errno.message}`);
  }
  if (!markerSeen) {
    /* The watchdog fired before NsJail logged its post-mount marker. The
     * child may still finish successfully — but if multiple jobs trip the
     * watchdog in a row we're back to overlapping setups, so the operator
     * needs to see this. `pollError`, when present, is the last reason the
     * log was unreadable (EACCES on a chmod race, EISDIR if the path got
     * replaced, EIO, ...) which is far more diagnostic than a bare timeout. */
    logger.warn(
      { logId, pollError: pollError && { code: pollError.code, message: pollError.message } },
      'nsjail setup gate watchdog fired before "Executing" marker',
    );
    nsjailSetupGateWatchdogFires.inc();
  }

  if (hasStdin) {
    proc.stdin.write(stdin!);
    proc.stdin.end();
  } else {
    /* Close stdin immediately so the child sees EOF — matches Bun.spawn's
     * `stdin: 'ignore'` semantics. Without this the child may block on
     * read(STDIN) under tools that probe stdin during init. */
    proc.stdin.end();
  }

  await Promise.all([
    stdoutDrain ?? drainStream(proc, proc.stdout, 'stdout'),
    stderrDrain ?? drainStream(proc, proc.stderr, 'stderr'),
  ]);

  if (spawnError) {
    /* Belt-and-braces: the pre-drain spawn-error short-circuit above
     * normally throws before we reach here, but the gate's abort race
     * could theoretically leave us in a state where spawnError fires
     * BETWEEN the pre-drain check and now. Same throw shape. */
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    const errno: NodeJS.ErrnoException = spawnError;
    throw new Error(`Failed to spawn nsjail: ${errno.code ?? 'UNKNOWN'}: ${errno.message}`);
  }

  /* Map signal name -> signum, derived once from the existing SIGNALS
   * lookup at the top of this file. Used to encode signal-killed exits
   * as 128+signum (matching Bun.spawn's exitCode convention), which the
   * downstream signal-decoding path already handles. */
  const SIGNAL_NUM_BY_NAME: Record<string, number> = Object.fromEntries(
    Object.entries(SIGNALS).map(([num, name]) => [name, Number(num)]),
  );

  /* Resolve the process's final exit code. Two concurrent failure modes
   * to handle:
   *
   * (1) Process has ALREADY exited by the time we get here. drainStream
   *     waits on stream 'close' events, which fire BEFORE proc 'close',
   *     but Node populates proc.exitCode / proc.signalCode synchronously
   *     when the underlying wait() returns — so on a signal kill
   *     (e.g. proc.kill('SIGKILL') from the output-overflow path),
   *     proc.signalCode is set before drainStream resolves. If we only
   *     check exitCode and attach proc.once('close'), the 'close' event
   *     may have already fired and our listener never runs — execute()
   *     hangs forever. The synchronous check below catches both
   *     exit-code and signal-kill cases.
   *
   * (2) Process is still running (typical happy path). Attach the
   *     'close' listener and decode the (code, signal) tuple. */
  const exitCode: number | null = await new Promise(resolve => {
    const decode = (code: number | null, signal: NodeJS.Signals | null): number | null => {
      if (code !== null) return code;
      if (signal != null) {
        const num = SIGNAL_NUM_BY_NAME[signal];
        return num !== undefined ? 128 + num : null;
      }
      return null;
    };
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(decode(proc.exitCode, proc.signalCode));
      return;
    }
    proc.once('close', (code, signal) => resolve(decode(code, signal)));
  });
  const wallTime = Date.now() - startTime;

  // Log memory metrics after each execution to track potential leaks.
  // Reads from /proc/self/cgroup to find the actual cgroup path, then reads
  // memory.current and memory.stat from that cgroup.
  // Distinguishes real usage (anon) from reclaimable kernel page cache (file).
  try {
    const cgroupLine = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
    // cgroup v2 format: "0::<path>"
    const cgroupPath = cgroupLine.split('\n').find(l => l.startsWith('0::'))?.split('::')[1] ?? '/';
    const cgroupFsPath = `/sys/fs/cgroup${cgroupPath}`;

    const memoryCurrent = fs.readFileSync(`${cgroupFsPath}/memory.current`, 'utf8').trim();
    const memoryStat = fs.readFileSync(`${cgroupFsPath}/memory.stat`, 'utf8');
    const parseStatValue = (key: string): number => {
      const match = memoryStat.match(new RegExp(`^${key}\\s+(\\d+)`, 'm'));
      return match ? parseInt(match[1], 10) : 0;
    };
    if (suppressSuccessLogs !== true) {
      logger.info({
        memoryMb: Math.round(parseInt(memoryCurrent, 10) / 1048576),
        anonMb: Math.round(parseStatValue('anon') / 1048576),
        fileCacheMb: Math.round(parseStatValue('file') / 1048576),
        shmemMb: Math.round(parseStatValue('shmem') / 1048576),
      }, 'Post-execution memory');
    }
  } catch { /* cgroup files may not be accessible in all environments */ }

  let logMessage: string | null = null;
  let logStatus: string | null = null;
  let signal: string | null = null;

  try {
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf8');

      if (exitCode === 255) {
        logger.error({ logContent }, 'nsjail exit 255');
      }

      for (const line of logContent.split('\n')) {
        if (TIME_LIMIT_RE.test(line)) {
          logMessage = 'Time limit exceeded';
          logStatus = 'TO';
        }
        if (OOM_RE.test(line)) {
          logMessage = 'Out of memory';
          logStatus = 'SG';
        }
        const sigMatch = line.match(SIGNAL_RE);
        if (sigMatch) {
          const sigNum = parseInt(sigMatch[1], 10);
          signal = SIGNALS[sigNum] ?? `SIG${sigNum}`;
        }
      }
    } else if (exitCode === 255) {
      logger.error({ logPath }, 'nsjail exit 255 - no log file found');
    }
  } catch { /* log file may not exist */ } finally {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  }

  let code: number | null = exitCode;
  if (code !== null && code > 128 && !signal) {
    signal = SIGNALS[code - 128] ?? null;
  }

  let finalMessage = killMessage ?? logMessage;
  const finalStatus = killStatus ?? logStatus;

  if (finalStatus && ['TO', 'OL', 'EL'].includes(finalStatus)) {
    signal = 'SIGKILL';
  }

  if (stderrTruncated) {
    finalMessage = finalMessage ?? `stderr truncated at ${outputMaxSize} bytes`;
  }

  /* Surface the reason in the streams themselves: most clients (and the
   * models consuming tool output) only ever see stdout/stderr, so a kill
   * or truncation without an in-band marker reads as a silent hang. */
  if (finalMessage) {
    const marker = `\n[sandbox] ${finalMessage}\n`;
    stderr += marker;
    output += marker;
  }

  return {
    stdout,
    stderr,
    code,
    signal,
    output,
    memory: null,
    message: finalMessage,
    status: finalStatus,
    cpu_time: null,
    wall_time: wallTime,
  };
}

interface BuildArgsOptions {
  logPath: string;
  /* Path to the rendered per-job NsJail config (base sandbox.cfg + the
   * dynamic /mnt/data mount block from renderJobConfigOverlay). Optional
   * for tests that don't materialize a per-job file; defaults to the base
   * config, in which case /mnt/data won't be mounted. */
  cfgPath?: string;
  pkgdir: string;
  timeout: number;
  memoryLimit: number;
  envVars: Record<string, string>;
  command: string[];
  extraPkgdirs?: string[];
  identity: SandboxJobIdentity;
  enableToolCallSocket?: boolean;
}

export function buildArgs(opts: BuildArgsOptions): string[] {
  const {
    logPath,
    cfgPath,
    pkgdir,
    timeout,
    memoryLimit,
    envVars,
    command,
    extraPkgdirs,
    identity,
    enableToolCallSocket,
  } = opts;

  const timeoutSecs = Math.max(1, Math.ceil(timeout / 1000));

  const args: string[] = [
    '--config', cfgPath ?? config.nsjail_config,
    '--log', logPath,
    '--seccomp_string', SECCOMP_POLICY,
    '--user', `${SANDBOX_INSIDE_UID}:${identity.uid}:1`,
    '--group', `${SANDBOX_INSIDE_GID}:${identity.gid}:1`,
    '-s', '/usr/bin:/bin',
    '-s', '/usr/lib:/lib',
    '-s', '/usr/lib64:/lib64',
    '-R', `${pkgdir}:${pkgdir}`,
  ];

  const bundleChecksum = path.join(config.packages_directory, '.bundle.sha256');
  if (fs.existsSync(bundleChecksum)) {
    args.push('-R', `${bundleChecksum}:${bundleChecksum}`);
  }

  if (config.use_cgroupv2) {
    args.push('--use_cgroupv2');
  }

  if (extraPkgdirs) {
    const packagesRoot = config.packages_directory;
    for (const dir of extraPkgdirs) {
      const relativeToPackages = path.relative(packagesRoot, dir);
      if (
        !path.isAbsolute(dir) ||
        relativeToPackages.startsWith('..') ||
        path.isAbsolute(relativeToPackages) ||
        dir.includes(':')
      ) {
        continue;
      }
      args.push('-R', `${dir}:${dir}`);
    }
  }

  args.push(
    '--time_limit', String(timeoutSecs),
    '--rlimit_as', String(config.rlimit_as),
    '--rlimit_fsize', String(config.rlimit_fsize),
    '--rlimit_nofile', String(config.max_open_files),
    '--rlimit_nproc', String(config.max_process_count),
    '--rlimit_core', '0',
    '--rlimit_cpu', String(timeoutSecs),
    '--rlimit_stack', 'soft',
    '--rlimit_memlock', '0',
  );

  if (config.use_cgroupv2 && memoryLimit > 0) {
    args.push('--cgroup_mem_max', String(memoryLimit));
  }

  if (config.allowed_local_network_port > 0 && enableToolCallSocket === true) {
    const socketPath = '/tmp/tcs.sock';
    args.push('-B', `${socketPath}:${socketPath}`);
  }

  for (const [key, value] of Object.entries(envVars)) {
    args.push('-E', `${key}=${value}`);
  }

  /* TOOL_CALL_SOCKET is intentionally NOT exported: the path is fixed at
   * /tmp/tcs.sock and the blocking-mode runtime preamble references it
   * as a literal.
   * Skipping the env entry shrinks the surface user code can introspect
   * (`os.environ`). The per-job /tmp/tcs.sock bind-mount above is what
   * actually makes the path connectable, and ordinary execute/replay jobs
   * do not receive that mount. */

  args.push('--');
  args.push('/usr/local/bin/spec-guard', ...command);

  return args;
}
