# `@librechat/code`

Provider-neutral protocol and worker CLI for attaching a stateful, sandboxed
code environment to LibreChat Code API.

The CLI owns the runtime-supervisor seam. Native workspace commands use
Anthropic's open-source Sandbox Runtime (SRT) on the worker machine. The
bundled endpoint adapter can also connect to an already-running loopback Code
Interpreter sandbox, while the optional Docker adapter provides a stronger
container/NsJail profile. The worker connects outbound to Code API,
long-polls for assignments, sends them to the local runtime, and returns fenced
results. The VM does not need an inbound public port.

## Pair

Hardened deployments use a one-time code instead of copying a long-lived
worker secret onto the VM. After an administrator creates a code, run:

```bash
librechat-code pair https://code.example.com/v1 '<one-time-code>' \
  --worker-id my-vm
```

The CLI generates an Ed25519 key locally and writes its paired identity to
`~/.config/librechat/code/my-vm.json` with owner-only permissions. The private
key never leaves the VM. Worker requests carry an exact-request signature,
timestamp, and one-time nonce; the short-lived credential rotates
automatically.

Then start the worker without a shared secret:

```bash
LIBRECHAT_CODE_WORKER_ID=my-vm \
LIBRECHAT_CODE_SANDBOX_ENDPOINT=http://127.0.0.1:2000/api/v2 \
librechat-code run
```

Use `--identity <path>` while pairing and
`LIBRECHAT_CODE_IDENTITY_FILE=<path>` while running to override the identity
file location.

## Native BYOM sandbox (default)

The MVP command sandbox runs directly on the user's chosen laptop or VM. It
does not require Docker. Enable commands for an existing project or for a new
application-owned directory:

```bash
librechat-code run --worker-dir /path/to/project --allow-workspace-commands

# Git is optional; this creates and reuses an empty workspace.
librechat-code run --default-workspace --allow-workspace-commands
```

`native-srt` is the default command sandbox unless a Docker/NsJail runtime was
selected. It uses `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS,
bubblewrap plus seccomp on Linux, and the SRT restricted-account helper on
Windows. Startup fails before worker registration when the platform or its
dependencies are unavailable. There is no unsandboxed command fallback.

The bridge worker remains outside the sandbox so it can maintain its outbound
Code API connection. Each command and its descendants run inside SRT with:

- write access restricted to the one canonical registered workspace;
- read access denied to the worker's home directory except for that workspace;
- paired identity and mutation-quarantine files explicitly denied;
- `LIBRECHAT_CODE_*` and nonessential inherited environment variables removed;
- network egress denied by default, local binding denied, and Unix sockets
  denied; and
- bounded time and aggregate output, with best-effort process-group termination
  on cancellation, timeout, and completion.

SRT restrictions remain inherited by descendants. Windows additionally uses a
kill-on-close Job Object. Native macOS does not provide an equivalent hard
process-lifetime boundary: a deliberately daemonized descendant can outlive
the command while remaining confined to the approved workspace and network
policy. This matches the personal-machine SRT trust model; use the Docker/NsJail
backend or a dedicated VM boundary when hard teardown of adversarial process
trees is required.

Linux hosts need Bash at `/bin/bash`, `bubblewrap`, `socat`, and `ripgrep`; macOS uses system
facilities. Follow SRT's one-time restricted-account setup when using Windows.
An operator may allow explicit egress destinations with the comma-separated
`LIBRECHAT_CODE_COMMAND_ALLOWED_DOMAINS` setting. Treat that as a security
policy: an allowed destination can receive workspace data. The normalized
allowlist is included in the worker policy digest. Tool approval hooks remain
the user-facing allow/deny boundary for each invocation.

Select the backend explicitly when desired:

```bash
LIBRECHAT_CODE_COMMAND_SANDBOX=native-srt librechat-code run \
  --worker-dir /path/to/project --allow-workspace-commands
```

## Docker runtime supervisor (optional hardened adapter)

`DockerRuntimeSupervisor` is the first self-contained local OCI adapter. It
owns one named container per runtime session, does not publish the runner port,
starts the container with `--network none`, drops every Linux capability, and
sets `no-new-privileges`. The trusted worker invokes the runner only through
`docker exec` to `127.0.0.1` inside that container. The sandbox therefore has
neither an inbound host port nor network egress.

It requires a
runtime image that provides the Code Interpreter `/api/v2/health` and
`/api/v2/execute` endpoints and supports
`SANDBOX_SESSION_WORKSPACE_ENABLED=true`. The repository's
`local-oci-runtime` target supplies that API for the direct-NsJail macOS
profile. This adapter intentionally does not turn an arbitrary image into a
supported security boundary. Image-specific Linux capabilities must be
explicitly configured by the trusted launcher; the default grants none.

To enable it from the bundled CLI, the host must give the worker access to its
local Docker daemon and explicitly select a known runtime image:

```bash
LIBRECHAT_CODE_RUNTIME_SUPERVISOR=docker \
LIBRECHAT_CODE_RUNTIME_IMAGE=ghcr.io/librechat-ai/code-interpreter-runtime:tag \
LIBRECHAT_CODE_STATEFUL_WORKSPACE=true \
librechat-code run
```

The image reference above is illustrative until the corresponding published
runtime image ships. Docker mode never binds a runner port on the VM. Do not
mount the Docker socket into the sandbox; only the trusted worker may control
the daemon.

For local Docker Desktop development, build the direct-NsJail target and use
the same capability and seccomp policy as `docker-compose.mac.yml`:

```bash
docker build --target local-oci-runtime \
  -t librechat-code-runtime:local -f api/Dockerfile .

LIBRECHAT_CODE_RUNTIME_SUPERVISOR=docker-nsjail \
LIBRECHAT_CODE_RUNTIME_IMAGE=librechat-code-runtime:local \
LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE=./seccomp/nsjail.json \
LIBRECHAT_CODE_DOCKER_PACKAGES_PATH=./data/pkgs \
LIBRECHAT_CODE_STATEFUL_WORKSPACE=true \
librechat-code run
```

The packages directory must already be populated using the repository's
package-init workflow. The worker mounts it read-only into each runtime.
Changing the image, package path, capabilities, seccomp contents, or other
confinement settings discards any surviving session container; the current
assignment fails explicitly so the lost workspace is never
presented as continuous state. Likewise, Docker Desktop remounts a fresh tmpfs
when this container restarts, so the profile discards a stopped container and
reports state loss instead of restarting it. The next assignment starts a new
environment. Treat profile changes and Docker restarts as environment resets
and preserve any needed workspace contents first.

By-reference inputs and generated-file uploads remain disabled unless the
worker-managed file relay is configured. Build the worker image, then point the
relay at the deployment's public egress-gateway base URL:

```bash
docker build -t librechat-code-worker:local packages/code

LIBRECHAT_CODE_FILE_RELAY_IMAGE=librechat-code-worker:local \
LIBRECHAT_CODE_FILE_RELAY_UPSTREAM=https://code.example.com/egress \
LIBRECHAT_CODE_EXECUTION_MANIFEST_PUBLIC_KEY='<base64 Ed25519 public key>' \
librechat-code run
```

The URL is illustrative; it must be the externally reachable HTTPS base URL
for the same Code API deployment's egress-gateway routes. Plain HTTP is accepted
only for loopback and Docker Desktop development hosts. Enabling the relay also
requires signed execution manifests. The worker creates a labeled internal
Docker network for each worker identity, connects the runtime only to that
network, and starts a separate hardened relay container on a labeled,
worker-specific egress network. Reused networks are accepted only when their
internal flag and ownership labels match the required profile. The relay
publishes no host port, accepts only the file-object read, normalized list, and
generated-object write routes, requires both its worker-derived token and the
assignment's scoped egress grant, refuses redirects, and caps request headers,
transfer size, duration, and concurrency. Its upstream is fixed at startup.
Overlapping worker incarnations use separate relay containers; the newly
registered incarnation removes stale relays only after Code API fences the old
incarnation, and orderly shutdown removes its own relay. Relay-capable workers
remain unavailable for dispatch until they activate and health-check the relay,
then confirm readiness for the exact registration incarnation and generation.
Each registration heartbeat revalidates the relay before renewing its
shorter-lived readiness confirmation, so a stopped relay ages out without
creating an availability gap during healthy heartbeats.
Stopped staging containers are reclaimed on the next activation; running
staging containers are reclaimed only after a conservative grace period.

The trusted runner API can use this relay for file staging. User code still
runs in NsJail's separate network namespace with no interfaces, so it cannot
reach the relay or the public internet. Anyone with access to the Docker daemon
remains inside the trusted worker boundary and can inspect container
configuration and secrets.

Direct NsJail shares the Docker Desktop VM kernel and is suitable for local or
operator-trusted development. Use a separate VM or MicroVM boundary for
internet-facing execution of code from untrusted users.

## Static compatibility mode

Non-hardened development deployments may still run with a static token:

```bash
npm install -g @librechat/code

LIBRECHAT_CODE_URL=https://code.example.com/v1 \
LIBRECHAT_CODE_WORKER_TOKEN='<strong random secret>' \
LIBRECHAT_CODE_WORKER_ID=my-vm \
LIBRECHAT_CODE_SANDBOX_ENDPOINT=http://127.0.0.1:2000/api/v2 \
librechat-code run
```

Optional environment variables:

- `LIBRECHAT_CODE_SANDBOX_PROFILE`: capability label; defaults to
  `anthropic-srt` for native workspace commands, `oci-docker` for Docker, and
  the existing `nsjail` label otherwise.
- `LIBRECHAT_CODE_RUNTIMES`: comma-separated capability labels.
- `LIBRECHAT_CODE_POLICY`: local policy description hashed into the worker's
  registration; defaults to `default-deny`.
- `LIBRECHAT_CODE_STATEFUL_WORKSPACE`: defaults to `false`. Set it to `true`
  only when the local runtime supervisor provides a distinct persistent runner
  for every runtime session. The bundled endpoint adapter requires the endpoint
  to contain a
  `{runtimeSessionId}` placeholder, for example
  `http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2`. The worker URL-
  encodes and substitutes the assigned session ID before execution. Hintless
  assignments use an ephemeral `assignment-<id>` session so affinity-mode
  stateless work never reaches a literal placeholder route.

A single built-in sandbox runner binds itself to one runtime session and must
not be advertised as stateful. Use the default stateless capability until a
session-routing supervisor is configured. The endpoint adapter is a
compatibility adapter: it validates and routes a session but cannot create,
discard, or attest the underlying sandbox on its own.

Static worker authentication is rejected when Code API hardened mode is
enabled. Expose only the sandbox loopback endpoint to the CLI, and enforce
VM/container egress policy independently of the bridge transport.

The worker retries result settlement through the assignment deadline. If a
stateful result remains ambiguous, it exits with a quarantine error instead of
accepting another assignment. Reset or discard that session's local runner
before restarting the worker; its workspace may contain mutations that Code
API did not commit.
Likewise, if a local `write_file` or `edit_file` completes but its fulfilled
settlement cannot be acknowledged, the worker exits before accepting more
workspace operations and writes a deployment/worker/workspace-scoped
quarantine marker that survives process restarts. The marker is armed before
each mutation with exclusive, incarnation-owned creation and removed only after
Code API accepts its settlement. Overlapping workers cannot replace or clear
one another's marker. The worker refuses to register writable workspace tools
while that marker exists. Inspect or restore the registered directory, then
explicitly clear the marker with
`librechat-code clear-workspace-quarantine --worker-dir <same-directory>`
before restarting it. Use `--default-workspace --workspace-id <id>` instead for
an application-owned default directory. `LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE`
may override the marker path for managed deployments.

## Local workspace tools (bridge preview)

`@librechat/code/workspace` provides the provider-neutral foundation for
coding-agent access to workspace directories on the worker machine. A workspace
may be an existing project, a Git repository, or a newly created empty
directory; Git is optional.
`LocalWorkspaceTools` registers opaque workspace IDs with optional display
names and exposes bounded `read_file`, literal `search_text`, and deterministic
`list_files` operations. Workspace mutation is disabled by default. Operators
can explicitly add confined `write_file` and exact-match `edit_file` operations
with `--allow-workspace-writes` or
`LIBRECHAT_CODE_ALLOW_WORKSPACE_WRITES=true`.
Only IDs, names, protocol version, and supported operations appear in worker
capabilities; absolute host paths remain local to the worker process.

The protocol also defines a bounded `execute_command` request and result for a
sandbox-backed executor. Commands are treated as workspace mutations and cannot
be advertised without durable quarantine storage. `LocalWorkspaceTools` never
runs them directly in the trusted worker process; the CLI does not advertise
command support until its selected SRT or Docker/NsJail sandbox has passed
startup checks.

`SandboxWorkspaceTools` is the composition boundary for that runtime. It adds
`execute_command` only to workspace IDs explicitly backed by a
`WorkspaceCommandSandbox`, delegates every file operation to the confined local
executor, and validates the sandbox's complete result before returning it. It
does not include a shell fallback. Invalid responses and unknown sandbox errors
are reported as potentially committed mutations so the worker's durable
quarantine remains armed. The concrete adapter must pass its platform and
identity checks before the CLI can enable this composition.

The built-in Docker/NsJail adapter can be enabled explicitly for one registered
directory:

```bash
LIBRECHAT_CODE_RUNTIME_SUPERVISOR=docker-nsjail \
LIBRECHAT_CODE_RUNTIME_IMAGE=librechat-code-runtime:local \
LIBRECHAT_CODE_DOCKER_SECCOMP_PROFILE=./seccomp/nsjail.json \
LIBRECHAT_CODE_DOCKER_PACKAGES_PATH=./data/pkgs \
LIBRECHAT_CODE_COMMAND_SANDBOX=runtime \
librechat-code run --worker-dir /path/to/workspace --allow-workspace-commands
```

`docker-macos-nsjail` remains accepted as a compatibility alias. The worker
bind-mounts only that canonical directory into an unexposed runtime
container and submits commands to a private, capability-authenticated runner
route. The runner maps the mounted directory owner into NsJail without chowning
the directory, disables network access by default, rejects an escaping `cwd`,
and bounds command, time, stdout, and stderr. The endpoint supervisor cannot be
used as the `runtime` command backend, but it can coexist with the default
native SRT command backend. This operator switch controls availability;
LibreChat tool approval hooks remain the user-facing allow/deny boundary for
each invocation.

Reads reject absolute paths, traversal, escaping symlinks, non-regular files,
and files larger than 1 MiB. The opened file is checked against its canonical
in-workspace inode before it is read. Text search uses `rg` only to enumerate a
bounded set of ignored-aware candidates with configuration and symlink following
disabled. It then opens and verifies each candidate through the same confined
1 MiB read boundary before matching locally. File listing invokes `rg` without
a shell, with configuration and symlink following disabled. Both operations
stop after bounded global result counts. The worker process still belongs inside
the trusted BYOM boundary and should receive filesystem access only to roots the
operator intentionally registers.

Writes are limited to 1 MiB of UTF-8 text and require an existing directory
inside the registered root. They reject traversal, symlink targets, and
non-regular files, and commit through an owner-only temporary file followed by
an atomic rename. The worker syncs the containing directory and verifies that
the installed inode still contains the requested bytes before reporting
success. Edits replace text only when the requested old text occurs exactly
once and reject if the file changes before commit. These operations do not
create directories or execute commands.

Register one directory already present on the worker machine with the
worker-directory option:

```bash
librechat-code run --worker-dir /path/to/workspace
```

To start without an existing project or Git repository, explicitly ask the
worker to create and reuse an application-owned workspace:

```bash
librechat-code run --default-workspace
```

The directory is created with owner-only permissions below
`~/.local/share/librechat/code/workspaces/`, using stable digests of the worker
and workspace IDs so distinct IDs cannot alias on case-insensitive filesystems.
The deployment and paired bridge identity are also part of the namespace, so
re-pairing or switching Code API deployments cannot expose the previous
identity's files. It persists across worker restarts. The current workspace
tools are read-only unless writes are explicitly enabled. The worker never
registers its process working directory implicitly, and `--default-workspace`
cannot be combined with `--worker-dir`.

The default public workspace ID is `primary` and the default display name is
the directory basename. Operators can use `--workspace-id` and
`--workspace-name`, or `LIBRECHAT_CODE_WORKER_DIR`,
`LIBRECHAT_CODE_WORKSPACE_ID`, and `LIBRECHAT_CODE_WORKSPACE_NAME`, to set them
explicitly. `rg` must be installed on the worker for `search_text` and
`list_files`. `LIBRECHAT_CODE_DEFAULT_WORKSPACE=true` is the environment
equivalent of `--default-workspace`.

The write flag is an operator capability boundary, not an approval bypass.
LibreChat should allow read, search, and list operations by default and route
write and edit operations through its configurable tool-approval hooks before
dispatch. A worker that was started without write capability rejects mutations
even if a remote caller tries to send one.

The worker advertises these capabilities only when a directory is configured
and executes matching assignments under the bridge's existing lease,
deadline, cancellation, credential-refresh, and settlement fencing. The
workspace itself remains on the worker. As with Cursor's self-hosted agents,
text and relative paths deliberately selected by `read_file`, `search_text`, or
`list_files` cross the outbound bridge so the remote agent/model can reason over
them. Host paths are never part of that payload. The Code API workspace-tool
endpoint is delivered as a dependent layer; deployments without it continue to
use sandbox assignments unchanged.

After discarding or resetting that session's local runner, acknowledge recovery
with `librechat-code reset-workspace <runtime-session-id>`. The command uses the
configured worker credentials, registers a fresh incarnation, and only clears
the server fence when no assignment is active. Run it while the normal worker
process is stopped, then restart the normal worker after the command exits.
