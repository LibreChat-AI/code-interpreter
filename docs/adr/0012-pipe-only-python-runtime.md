# 0012: Deny socketpairs with pipe-only Python runtime IPC

Status: Proposed

## Context

ADR 0011 removed the named tool-call socket but retained Unix stream socketpairs
for Python runtime compatibility. Removing that exception reduces the kernel
surface available to untrusted code. A seccomp-only change breaks standard
asyncio initialization and duplex multiprocessing connections.

## Decision

Deny every socketpair in the job filter. Patch the packaged Linux Python stdlib
at build time, including the package-init and local package-builder paths:

- Replace asyncio's self-socket with nonblocking CLOEXEC anonymous pipe endpoints.
  Preserve thread wakeups, signal wakeup FDs, read callbacks and loop cleanup.
- Replace duplex multiprocessing connections with two anonymous pipes. Preserve
  Connection framing, readable fileno/poll, close/EOF, and both descriptor ends
  through the existing spawn reduction mechanism.
- Validate each stdlib edit before writing any edits. Unknown source layouts fail
  the package build. Mark successful installation so package init cannot reuse an
  unpatched package solely because its Python version matches.

The trusted broker/relay may continue using sockets outside the jail. Untrusted
code receives only anonymous pipe capabilities. No socketpair emulation is
installed globally: direct socket APIs remain denied by seccomp.

## Consequences

Rebuild Python packages and deploy them with the new runner policy. Existing
unpatched packages are incompatible with the policy; drain or version-route
jobs during replacement. Snapshot/baked runners need rebuilt runtime contents.
The marker is build bookkeeping, not an authorization boundary.

Other runtimes or third-party event loops that require socketpairs remain denied;
the patch only covers the standard Python runtime. Named listeners, forkserver,
managers and post-start descriptor sharing remain unsupported. Queues/pools
still require the jail to mount /dev/shm, independent of this change.

Native regression tests exercise the compiled policy on both CPU architectures,
thread completion, signals, cancellation, async subprocesses, duplex spawn/fork
IPC and EOF, queues/pools, and generated concurrent tool calls. A local signed
runner canary additionally checks packaged Python and ordinary asyncio jobs.
