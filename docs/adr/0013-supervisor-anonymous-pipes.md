# 0013: Remove Unix sockets from runner supervisors

Status: Proposed

## Context

ADRs 0011 and 0012 deny sockets in untrusted jobs. The trusted API, broker,
relay, and NsJail monitor still process job-controlled data. Node/Bun's piped
subprocess stdio and NsJail's startup handshake create Unix socketpairs outside
the job filter. Supervisor hardening must replace those transports before it
can deny the same kernel entry points.

## Decision

Install an inherited seccomp filter before starting the API. Deny AF_UNIX
socket creation, every socketpair, sendmsg/sendmmsg (including inherited
sockets), and all io_uring entry points. Validate the native audit architecture
and reject x32 syscall encodings. TCP remains available for API requests,
hosted previews, and the broker's fixed upstream. This is a targeted deny filter,
not a complete supervisor syscall allowlist. Startup fails if installation fails. Force sequential resolver queries with
`RES_OPTIONS=single-request` (preserving existing options), so glibc DNS uses
sendto instead of its blocked sendmmsg batching.

A small N-API addon creates CLOEXEC anonymous pipes. Linux subprocess launches
pass integer pipe ends to Node/Bun rather than requesting runtime-created pipes.
The adapter preserves output draining, backpressure, child close ordering, and
cleanup on exit, failed spawn, and cancellation. macOS development retains native
spawn; Linux container tests on the Mac verify the real filter and pipe adapter.

The tool-call broker uses separate request/response pipes to its relay. The relay
retains bounded buffers, parent-death signals, and immediate termination when a
response reader disappears, even without a pending response. Buffered sources
are omitted from poll until drained so a closed writer cannot cause a CPU spin.
Untrusted jobs now
receive anonymous pipes for stdin/stdout/stderr as well as tool-call FDs 3/4.

Patch the pinned NsJail build to replace its supervisor/child handshake with
separate readiness and error pipes. Reject optional seccomp notification and
user-mode networking modes that require descriptor passing. Build without libnl:
network-isolated jobs do not need interface movement or traffic-rule programming,
and this avoids a gratuitous netlink enumeration during namespace setup.
Unsupported interface/traffic-rule requests fail closed.

Hosted-app egress uses the packaged iptables-legacy and ip6tables-legacy binaries,
whose transport does not require sendmsg. Both chains must install before any
app is admitted. IPv4/IPv6 legacy netfilter support is consequently required on
the runner kernel; missing support rejects hosted-app admission.

## Consequences and validation

All three runner image paths package the matching addon, policy binary, broker,
relay, and patched NsJail. Deploy rebuilt runner images and regenerate snapshots;
these internal processes and binaries are an atomic image upgrade. The external
service protocol and previously patched Python runtime are unchanged.

The filter also applies to hosted apps and their descendants. Runtimes and
third-party libraries that require Unix sockets/socketpairs remain unsupported.
The trusted API retains its existing privileges and other syscalls; reducing
those privileges requires another containment boundary. Kernel patching remains
necessary.

CI runs native filter, anonymous stdio, cleanup/backpressure, packaged broker,
and hosted-app egress/preview tests on amd64 and arm64. A local signed runner
canary additionally exercises normal namespaces with Python 3.14.4 asyncio,
spawn/fork multiprocessing, concurrent tool calls, and Bun 1.4.2 JS/TS execution.
