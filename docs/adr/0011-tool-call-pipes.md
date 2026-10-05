# 0011: Per-invocation anonymous pipes for blocking tool calls

Status: Accepted

## Context

Blocking Python tool calls used an HTTP listener at `/tmp/tcs.sock` mounted into
selected NsJail jobs. CVE-2026-80521 motivated descriptor-passing denials in
#309. Keeping socket creation enabled nevertheless exposes named endpoints
and socket families to untrusted code. The runner is snapshotted before work:
Node and its TLS state must continue to start after MicroVM restore.

The current stdio spawn APIs create socketpairs, not anonymous pipe endpoints.
The existing guard also intentionally removes unrelated inherited descriptors.
Python asyncio and duplex multiprocessing pipes use Unix stream socketpairs;
a blanket socketpair denial would break these ordinary workloads.

## Decision

Use one post-restore Node broker per authorized blocking invocation. Keep the
existing signed/body-bound `tool_call_socket` capability name on the wire, but
grant two pipe endpoints instead of a socket mount. Use length-prefixed JSON
frames with response IDs, a fixed upstream route, whitelisted claim headers,
and explicit size, rate, concurrency and deadline limits. Keep upstream
cryptographic/session/tool authorization authoritative.

A trusted C relay holds the spawn API's socket on its own side and passes real
anonymous pipe ends at FDs 3/4 into NsJail. The guard preserves them only under
an explicit option after validating FIFO type and write/read access; all
unrelated inherited descriptors are closed. API/broker parent death, channel failure and
job exit terminate the relay and its invocation and abort outstanding upstream
requests. The Python client clears descriptor inheritance and refuses calls
from forked children. stdout/stderr and user stdin remain separate.

Deny all socket creation. Permit only protocol-0 Unix stream socketpairs for
runtime IPC, retaining the sendmsg/sendmmsg/io_uring denials. This preserves
asyncio and ordinary multiprocessing without permitting named socket access
or descriptor passing. No legacy TCP/socket fallback is provided.

## Consequences

New service preambles and runner images require coordinated deployment;
blocking jobs must be drained or version-routed during upgrades and rollbacks.
Bash/replay mode has no pipe grant. Unix listeners/managers, non-stream pairs,
and descriptor-sharing APIs are unsupported. Each active invocation adds two
trusted processes outside its job cgroup; runner sizing must account for them.

A shared post-restore broker could reduce process overhead, but would require
an additional channel admission/multiplexing mechanism. Separate brokers keep
request state, failure and lifetime tied directly to one invocation. Named
FIFOs avoid inherited-FD changes but add filesystem names and open/unlink races;
anonymous pipes require neither path discovery nor shared listener state.

Native CI verifies both CPU architectures, actual FIFO descriptors, guard
cleanup, socket/send denials, runtime compatibility and concurrent generated
client calls through the compiled policy. Production guest/node patches and
full libkrun rollout remain operator checks.
