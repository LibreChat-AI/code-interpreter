# Sandbox security maintenance

The default boundary is NsJail inside a libkrun guest. Direct NsJail mode
shares the host kernel and is for trusted development, not hostile workloads.

## Verify deployed patches

Repository dependencies do not establish production kernel patch status.
Inventory each runner node and deployed runner image:

- Host OS and running kernel release (`uname -r` on the node).
- Container runtime version and runner image digest.
- Installed `libkrun` and `libkrunfw` packages
  (`rpm -q libkrun libkrunfw` inside the runner image).
- Bundled guest kernel release, from an operator-controlled guest inspection.
- Guest-visible nested virtualization features and exposed virtual devices.

Match kernel packages against distro security advisories, including backports.
Patch both the host kernel and bundled guest kernel. Rebuild and replace runner
images after guest-kernel updates; reboot or use the vendor-supported livepatch
procedure for host fixes. A container rebuild does not update host KVM.

Priority 2026 checks:

| Boundary | Advisory |
|---|---|
| Guest kernel; host kernel in direct mode | Bad Epoll, CVE-2026-46242 |
| Guest and host kernels | GhostLock, CVE-2026-43499 |
| Guest kernel; host kernel in direct mode | AF_UNIX garbage collection, CVE-2026-80521 |
| x86 host KVM | CVE-2026-46113, CVE-2026-53359, CVE-2026-64561 |
| ARM host KVM, when virtual ITS is exposed | CVE-2026-46316 |

PI-futex filtering reduces the GhostLock surface but does not replace patches.
Do not disable ordinary futex or epoll operations: language runtimes use them.
Do not expose nested virtualization to untrusted guests. Confirm the installed
VMM's behavior rather than assuming current upstream defaults match its build.

The October 2026 Vercel KVM report has no disclosed root cause or affected-version
matrix at the time of this change. These controls are not a verified fix for it.

## Unix-socket descriptor passing

The NsJail policy returns EPERM for `sendmsg` and `sendmmsg` to prevent
`SCM_RIGHTS` descriptor passing into the AF_UNIX garbage collector affected by
[CVE-2026-80521](https://www.cve.org/CVERecord?id=CVE-2026-80521).
Seccomp cannot inspect ancillary data behind a userspace pointer, so both calls
are denied even for messages without descriptors and for inherited sockets.
Keep `io_uring_setup`, `io_uring_enter`, and `io_uring_register` denied: ring
operations can submit sends without passing through these syscall filters.

The job policy denies every `socket()` family (VSOCK retains its KILL action).
It allows only AF_UNIX SOCK_STREAM `socketpair` with protocol 0, including
CLOEXEC/NONBLOCK flags. Python asyncio and duplex multiprocessing pipes need
these anonymous socketpairs. Ordinary fork/spawn queues and pools are covered
by native tests. Named Unix listeners, `multiprocessing.Manager`, datagram or
seqpacket pairs, and descriptor-sharing APIs are unsupported. The send and
io_uring denials still prevent SCM_RIGHTS descriptor graphs on allowed pairs.

This mitigation is separate from PI-futex filtering. Verify vendor patches for
the deployed guest and node kernels; a policy update does not establish patch
status. Rebuild and replace sandbox runner images to deploy the policy change.

## Tool-call pipe transport

Authorized blocking Python invocations receive two anonymous pipe endpoints:
FD 3 writes requests and FD 4 reads responses. No tool-call socket path is
mounted in the jail. The signed, body-bound `tool_call_socket` boolean remains
the wire capability name for compatibility with manifest verification; it now
grants pipes. Ordinary executions, compile steps, and replay/Bash tool calls
receive no endpoints. The Python client makes both ends non-inheritable before
user code runs and refuses tool calls from forked children.

A Node broker starts per invocation after MicroVM restore and forwards only
POST `/tool-call` to the configured `SANDBOX_FORWARD_TARGET`. It forwards only
the three PTC claim headers; upstream session/token/tool authorization remains
in force. It never follows redirects. Each channel bounds frames and upstream
responses to 1 MiB, active upstream requests to 16, admission to a 64-request
burst refilling at 20 requests/second, partial-frame and response-drain stalls
to 5 seconds, and upstream requests to the job timeout (5–600 seconds).
Malformed framing closes the invocation; disconnect/exit aborts upstream work.
The Python client correlates concurrent responses by frame ID.

Node/Bun extra stdio descriptors are socketpairs. A small trusted C relay
converts the broker's channel into real anonymous pipes before execing NsJail.
NsJail explicitly passes only FDs 3/4; `spec-guard --tool-call-pipes` checks their
FIFO type and access direction, retains those two ends, and closes unrelated
FDs. Its ordinary mode still closes every descriptor above 2. API/broker/relay
parent-death handling kills the invocation if either supervisor disappears.
Each invocation adds a Node broker and C relay outside the job cgroup; size
runner CPU/memory and PID limits for the configured simultaneous-job count.

The amd64/arm64 `NsJail IPC Filter` CI jobs compile the policy with pinned Kafel,
exercise socket/send denials plus asyncio/multiprocessing, check guard FD
cleanup, and run the actual broker/relay/NsJail/guard/generated Python client
with concurrent replies. These checks do not boot libkrun or establish deployed
kernel patch status.

### Local Mac/Docker canary

`tests/tool_call_runner.cjs` exercises signed API authorization, the normal
NsJail mount/user/PID/network/IPC/UTS/cgroup namespaces, the generated Python
client, concurrent tool calls, descriptor cleanup, spawn/fork pipe IPC, ordinary
Python jobs and basic Bun JavaScript/TypeScript execution. Spawned workers can
import the preamble but cannot issue tool calls. Python 3.14's default forkserver
requires a named Unix listener and is denied; select an explicit spawn or fork
context. Semaphore-based pools/queues require `/dev/shm`, which the default jail
does not mount. The namespace-disabled native policy tests cover those APIs
when shared memory exists, not their availability in the default jail.

With runtime packages built by `build-packages.sh` (or a compatible `/pkgs`
tree containing Python 3.14.4 and Bun 1.4.2), run from the repository root:

```sh
bun service/scripts/dump-pipe-preamble.ts > /tmp/codeapi-pipe-client.py
docker build -f api/Dockerfile --target sandbox-build -t codeapi-pipe-canary .
docker run --rm --init \
  --cap-add SYS_ADMIN --cap-add SYS_CHROOT --cap-add SETUID \
  --cap-add SETGID --cap-add NET_ADMIN \
  --security-opt seccomp=./seccomp/nsjail.json \
  --mount "type=bind,source=$PWD/data/pkgs,target=/pkgs,readonly" \
  --mount "type=bind,source=/tmp/codeapi-pipe-client.py,target=/client.py,readonly" \
  --mount "type=bind,source=$PWD/tests,target=/tests,readonly" \
  --entrypoint /usr/local/bin/node \
  codeapi-pipe-canary /tests/tool_call_runner.cjs /client.py
```

The canary disables resource cgroup enforcement as the Mac compose override
does, while retaining the cgroup namespace and all remaining NsJail isolation.
It exercises Docker's Linux VM, not a libkrun guest. It does not establish
production kernel patch status or third-party language-package compatibility.

### Coordinated rollout

Deploy the service's new blocking preamble together with rebuilt runner images
containing the broker, relay and updated guard/policy. Drain old blocking jobs
and route new blocking requests only to matching images during rollout. Old
socket preambles fail on pipe-only runners; new pipe preambles fail immediately
on old runners. There is no TCP or Unix-socket fallback. Replay mode is unchanged.
Rollback must restore both service and runner versions; retain #309's send and
io_uring denials. See [ADR 0011](adr/0011-tool-call-pipes.md) for the design.

## Preserve host-side confinement

- Run sandbox runners on isolated nodes, separate from credential-bearing
  control-plane workloads, with least-privilege node IAM.
- Keep hardened startup, signed manifests, egress controls, network policies,
  and disabled runner service-account token mounting.
- The launcher refuses to boot if its host-side seccomp filter cannot install.
- Internal authenticated HTTP requests reject redirects. Configure their final
  endpoints directly; do not depend on HTTP-to-HTTPS redirects.

## Dependency checks

Run `bun audit --cwd api` and `bun audit --cwd service` against the lockfiles.
Distinguish development dependencies from production paths and establish the
advisory's prerequisites before claiming an application exploit. Do not force
incompatible transitive major upgrades solely to obtain a clean audit.

Remaining service audit findings at this change:

- `stream-json` (GHSA-528h-pc64-c93x): MinIO 8 uses its JSON-lines parser,
  not the affected path filters. Keep MinIO's supported major dependency;
  reassess if notifications or path filters become reachable.
- `braces` (GHSA-vfj7-8cjw-p6xm): development-only dependency with no published
  fix. Do not feed untrusted patterns to build tooling; track an upstream fix.
