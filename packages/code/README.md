# `@librechat/code`

Provider-neutral protocol and worker CLI for attaching a stateful, sandboxed
code environment to LibreChat Code API.

For a complete machine setup and operations guide, see the
[self-hosted worker runbook](../../docs/remote-bridge/worker-runbook.md).

The CLI owns the runtime-supervisor seam. Native workspace commands use
Anthropic's open-source Sandbox Runtime (SRT) on the worker machine. The
bundled endpoint adapter can also connect to an already-running loopback Code
Interpreter sandbox, while the optional Docker adapter provides a stronger
container/NsJail profile. The worker connects outbound to Code API,
long-polls for assignments, sends them to the local runtime, and returns fenced
results. The VM does not need an inbound public port.

## Inspect local projects

Before registering a directory containing several checkouts, inspect its Git
projects on the worker machine:

```bash
librechat-code projects --root /srv/projects
```

The command prints JSON with `projects`, `truncated`, and `incomplete`. Each
project contains a path relative to the requested directory, a path-derived ID,
and the current origin, branch, and HEAD. Origins are normalized to
`host[:port]/namespace/repository`, including nested namespaces; URL credentials,
query strings, and fragments are omitted. An unsupported configured origin is
redacted to null and marks the inventory incomplete.
A detached HEAD has a null branch; an unborn branch has a null HEAD. IDs stay
stable when branches change, but moving or renaming a directory changes its ID.
IDs are local to the supplied discovery root.

Discovery runs only when requested. Its default limits are three directory
levels, 10,000 entries, 256 projects, and a ten-second processing budget with
bounded Git subprocess output and timeouts.
The time budget starts before resolving the root and is checked between native
filesystem operations; it cannot interrupt a kernel call stalled on a filesystem.
Use a responsive local filesystem. Discovery skips hidden directories,
dependencies, symlinks, and children of an identified repository. Linked
worktrees and submodules using a `.git` file are skipped and set `incomplete`:
their shared Git metadata needs separate admission before independent execution.
An empty project list does not prevent registering a non-Git directory.

This is a local inventory command. It does not clone, register roots, pair a
worker, change the sandbox, or automatically select a conversation workspace.
For the existing picker and independent lease slots, explicitly register the
chosen non-overlapping project directories with `--workspace` or `--environment`.
Do not also register their parent directory. Treat the inventory as a snapshot;
normal workspace admission must validate any directory selected from it.

## Register selected projects

After pairing, use paths from `projects --root` to register individual checkouts:

```bash
librechat-code run --project-root /srv/projects \
  --project web --project services/api \
  --allow-workspace-writes --allow-workspace-commands
```

Only the explicitly listed checkouts become execution roots. The discovery
directory is not registered, and adding a new sibling repository does not grant
access to it. In LibreChat, select the project in the existing workspace picker;
the conversation stores that selection for subsequent tools and approval resumes.
An agent's default workspace and the user's recent selection work as before.

Project IDs are derived from the canonical discovery directory and relative
project path, not the branch or selection order. Keep both paths unchanged across
restarts to retain chat bindings. Moving a checkout changes its ID. These are
registration IDs, not the root-local IDs printed by the inventory command.

Up to 32 selected projects are supported. Each must be a standalone Git checkout;
linked worktrees, symlink traversal, overlapping roots, and duplicate selections
are rejected. Existing native sandbox, command/write permissions, lease-slot and
quarantine rules still apply. This mode cannot be combined with `--environment`,
`--worker-dir`, `--workspace`, default-workspace, or workspace ID/name settings.
Existing registrations are not migrated automatically; use a new conversation
when switching registration mode. Non-Git directories still use the existing
workspace flags. Named environment setup/actions still use `--environment`.

Selected projects require macOS or Linux (including WSL2). Each request opens
and verifies the admitted directory, then retains that descriptor through file
access, repository-instruction loading, command startup, and replay copying.
Renaming a project cannot redirect an in-flight request to a replacement checkout;
subsequent requests reject the changed identity. Restart with an explicitly
selected replacement to admit it. Descriptors close when requests settle, and
independent workspaces do not share a current directory or global execution lock.

This reuses the existing workspace protocol. Programmatic tool calling requires
a LibreChat version that preserves the selected workspace across initial
execution and replay, plus the worker's normal programmatic prerequisites.
Installation alone does not restart workers or change registration; update your
worker service arguments explicitly.

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

Credential and quarantine storage supports macOS and Linux (including WSL2).
On macOS, native descriptor-based ACL calls remove inherited ACLs from new
credential/state files before writing secrets and verify the result. Reads reject
ACL-exposed identities and GitHub App keys; ancestor checks reject ACL write
grants and inheritable allow entries before any child is created. Removing an
ACL after creation cannot revoke descriptors opened while the grant existed. Existing sharing ACLs on parent directories
are never silently removed. Default application-owned workspace directories have
their ACLs removed and modes restricted to `0700`.

macOS requires the packaged Koffi native dependency (prebuilt for Apple Silicon
and Intel); no Python interpreter or local compiler is needed with those builds.
If it cannot load or ACL inspection fails, storage fails closed before pairing.
Native Windows remains explicitly unsupported until DACL removal and verification
are implemented. Use WSL2 with storage on a native Linux filesystem, not a Windows
drive under `/mnt`. Linux retains ownership and POSIX mode/ACL-mask checks.

Every storage ancestor, including intermediate symlink entries and targets, must
be owned by this account or root and must not allow group/other writes unless
protected by the sticky bit. A private directory inside a shared writable parent
is insufficient: that parent can replace the directory. This also applies when
loading GitHub App keys or clearing quarantine state.

Use `--identity <path>` while pairing and
`LIBRECHAT_CODE_IDENTITY_FILE=<path>` while running to override the identity
file location.

The identity file itself must not be a bind-mount target: saving a paired
credential atomically replaces that entry. Mount its containing directory
instead. Pairing preflight checks `/proc/self/mountinfo` before redeeming the
one-time code and fails closed if mount information cannot be verified (including
a mount table larger than 4 MiB). Existing identity reads remain supported.
The check describes the current mount namespace; administrators must keep mount
configuration stable during pairing.

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

The native SRT manager owns process-global policy, proxy, and cleanup state.
Only one sandbox instance may own a manager, and that instance accepts one
command at a time. Overlapping calls fail before a second command starts;
they are not queued inside the sandbox. `close()` waits for the active command
and initialization before resetting the manager and removing scratch. A failed
reset keeps ownership fenced until a later `close()` succeeds. Independent
native workspaces need separate worker processes, not multiple instances of
the default manager in one process. This lifecycle guard does not enable
parallel assignments on a single bridge worker.

The CLI hosts the native manager in a persistent, dedicated Node executor
process. It does not inherit the bridge credential, arbitrary host environment,
or Node loader/debugger options. Workspace policy and per-command masked
credentials travel over private parent/child IPC, never command-line arguments.
The bridge retains pairing and GitHub App identity management. Cancellation is
addressed to the active command; executor loss after dispatch is treated as an
uncertain mutation and is never automatically replayed. Restarting a worker
still requires its existing quarantine checks. Native platform limitations on
hard descendant teardown continue to apply.

Embedding applications can use `NativeProcessWorkspaceCommandSandbox` from
`@librechat/code` for separate native managers in one host application, with
`prepare()`, `execute()`, and `close()`. Each instance is serial and must be
closed by its owner. The bridge scheduler remains serial until negotiated
execution slots and workspace-scoped quarantine are supported end to end.

The bridge worker remains outside the sandbox so it can maintain its outbound
Code API connection. On macOS and Linux, each worker process creates an
owner-only scratch directory and grants SRT access to that exact directory
without opening the host temporary-directory root. Commands receive it through
`TMPDIR`, and orderly worker shutdown removes it. SRT's shared compatibility
scratch path is explicitly denied. Windows uses the restricted SRT account's
isolated profile and temporary directory instead. A workspace registration is
rejected if it sits inside SRT's shared scratch path or is broad enough to
contain worker scratch storage. Each command and its descendants run inside
SRT with:

- write access restricted to the one canonical registered workspace and the
  worker's private scratch directory;
- read access denied to the worker's home directory except for that workspace;
- paired identity and mutation-quarantine files explicitly denied;
- the registered workspace's own Git metadata denied writes — `.git/hooks`
  and `.git/config` always, plus `.git/config.worktree`, `.git/commondir`,
  and the equivalent files under `.git/modules/*` and `.git/worktrees/*`
  where they already exist — so a sandboxed command cannot plant a hook or a
  `filter`/`fsmonitor`/`diff` config entry that would run unsandboxed the
  next time Git runs in the checkout;
- `LIBRECHAT_CODE_*` and nonessential inherited environment variables removed;
- network egress denied by default, local binding denied, and Unix sockets
  denied; and
- bounded time and aggregate output, with best-effort process-group termination
  on cancellation, timeout, and completion.

Native command output keeps a prefix and rolling suffix for each stream, so late
summaries and errors survive truncation. Each stream stores at most
`maxOutputBytes` of copied raw bytes while the command runs, independent of output
volume or chunk count. When both streams are noisy they split the existing combined
response budget equally, with the odd byte reserved for stderr; a quiet stream gives
its unused allowance to the other based on rendered UTF-8 bytes, including replacement
characters for malformed input. Sandbox violation annotations enter the same
stderr window before rendering. UTF-8 boundaries and inline
`[... N bytes omitted ...]` markers count toward the combined byte limit. The count
reports omitted raw bytes for that stream, including annotation bytes. If a stream's
allowance cannot fit its marker, only the retained text and the existing `truncated`
flag are returned. Truncation does not stop execution. Exit codes, timeout/signal
fields, and cancellation errors keep their existing semantics, and no new request,
result, or capability keys are introduced.

The Git-metadata denies are applied to the registered root directly rather
than relying on SRT's Linux mandatory denies, which are derived from the
worker process's own current directory — the worker home, not the workspace —
and so never covered the registered root; macOS already enforced the
equivalent through global Seatbelt patterns, and this keeps the guarantee
identical on both platforms regardless of the worker's cwd. The set is
recomputed before every command, so a repository, submodule, or linked
worktree created on the host after the worker starts is covered from the next
command, and metadata the worker cannot inspect fails the command closed.
`.git/commondir` and `.git/config.worktree` are denied only where they already
exist, because Git reads them strictly and SRT would otherwise mask an absent
one with a stub Git cannot open, failing every Git command. Because the whole
workspace stays writable, a sandboxed command can still stage Git
configuration Git will honor later by other means — for example replacing
the entire `.git` directory, writing a new `commondir` that redirects the
common directory, creating a missing `config.worktree` in a repository that
already enables the `worktreeConfig` extension, or initializing a fresh
nested repository. Denying those safely would require
making the workspace's Git storage structurally read-only, which the
personal-machine SRT trust model does not; use the Docker/NsJail backend or a
dedicated VM boundary when a workspace command must be treated as adversarial.

SRT restrictions remain inherited by descendants. Windows additionally uses a
kill-on-close Job Object. Native macOS does not provide an equivalent hard
process-lifetime boundary: a deliberately daemonized descendant can outlive
the command while remaining confined to the approved workspace and network
policy. This matches the personal-machine SRT trust model; use the Docker/NsJail
backend or a dedicated VM boundary when hard teardown of adversarial process
trees is required.

Linux hosts need `bubblewrap`, `socat`, and `ripgrep`; macOS uses system
facilities. Bash Programmatic Tool Calling additionally requires Bash 5.2 or
newer and `jq` on `PATH` on macOS, Linux, and WSL2. The worker resolves that
shell explicitly instead of assuming `/bin/bash`, which remains Bash 3.2 on
many macOS hosts. Follow SRT's one-time restricted-account setup when using Windows.
An operator may allow explicit egress destinations with the comma-separated
`LIBRECHAT_CODE_COMMAND_ALLOWED_DOMAINS` setting. Treat that as a security
policy: an allowed destination can receive workspace data. The normalized
allowlist is included in the worker policy digest. Tool approval hooks remain
the user-facing allow/deny boundary for each invocation.

When Code API negotiates `bash` programmatic execution for a selected
workspace, the same native SRT executor also supports replay-mode Programmatic
Tool Calling on macOS, Linux, and WSL2 workers. Native Windows does not
advertise this Bash capability. The repository remains the command working directory. Generated
PTC scripts, replay history, skill files, chat attachments, and returned
artifacts use an owner-only per-execution directory under the worker's private
SRT scratch root, exposed to code as `LIBRECHAT_CODE_DATA_DIR`. That directory
is removed after every iteration and is never placed in the repository.

Replay probes run against a disposable copy-on-write snapshot with network and
socket access denied, including under `trusted-vm`. External effects must not
repeat while discovering pending tools. Use registered tools for network-dependent
replay control flow; the final commit pass runs once under the configured policy.
Each probe's SRT proxy session is revoked before restoring the commit policy;
per-command network overrides alone do not restrict SRT's session-level proxies.
Probe failures do not quarantine the real workspace. Once the commit pass starts,
its fence remains until result restoration succeeds; uncertain finalization
quarantines only that workspace.

Reference inputs and artifact outputs travel only through the configured
`LIBRECHAT_CODE_FILE_RELAY_UPSTREAM`, using Code API's execution-scoped opaque
egress grant. The worker rejects redirects and bounds each transfer to 10 MiB,
each execution to 100 files and 100 MiB total, and transfer concurrency to four.
Caller inputs are limited to 98 files, reserving two for the script and replay
history. Code API reserves one third of the job budget for all transfer batches
and negotiates each transfer's deadline before signing the request.
Its parent process keeps a 64-entry/32-MiB LRU input cache keyed by a stable,
Code-API-authorized digest; sandboxed commands cannot read that cache. Requests
against one workspace remain serialized, while negotiated lease slots allow
different registered roots to execute concurrently.

The native sandbox preserves standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
and `NO_PROXY` names (including lowercase forms), plus Windows process and profile
variables on Windows. SRT remains responsible for the final sandbox environment
and can replace proxy values with its filtered proxy endpoints. This does not
expand the allowed domains or expose unrelated inherited credentials.

### GitHub authentication

The native BYOM worker can provide Git HTTPS authentication without exposing a
real token to the command sandbox. Prefer a GitHub App installed only on the
repositories the agent may access:

```bash
LIBRECHAT_CODE_GITHUB_APP_ID=12345 \
LIBRECHAT_CODE_GITHUB_PRIVATE_KEY_FILE=/secure/librechat-agent.pem \
librechat-code run --worker-dir /path/to/project --allow-workspace-commands
```

The private key must be an owner-only regular file outside the workspace. It is
read only by the trusted worker, which mints and refreshes short-lived
installation tokens. At startup, the worker binds each explicitly admitted
workspace root to its Git repository. Commands in those independent roots can
use simultaneous installations on personal accounts and organizations without
being restarted or reconfigured, while a command cannot gain access by changing
its workspace's remote URL. Tokens are scoped and cached per repository.

For trusted VMs that intentionally work in multiple Git checkouts beneath one
admitted root, opt in to `--github-repository-routing checkout` (or
`LIBRECHAT_CODE_GITHUB_REPOSITORY_ROUTING=checkout`) together with the
`trusted-vm` command policy. Each command then uses the repository identified
by its current checkout's local `origin` URL, including linked worktrees.
The command must set its working directory to that checkout; a shell `cd`
inside a command does not change which credential was selected before launch.
This does not widen the admitted filesystem roots, but a command able to alter
a checkout's remote can obtain a token for **any repository where the App is
installed**. Use this mode only where the machine operator trusts the VM and
the App's installation scope; the default `admitted` mode keeps the startup
binding. Checkout routing requires an App without a fixed installation ID.

On a trusted VM, `--github-token-scope installation` (or
`LIBRECHAT_CODE_GITHUB_TOKEN_SCOPE=installation`) mints one token for all
repositories GitHub grants to the resolved App installation. This lets a
command started in one checkout push to another repository in the same account
or organization, including through `cd` or `git -C`, and use organization
Projects. GitHub still enforces the installation's selected repositories and
permissions. Tokens are shared by installation, refreshed after two minutes,
and kept out of the sandbox's readable environment. The default remains
`repository`. A command crossing to another account or organization still
needs to start in a checkout belonging to that account or organization.

For compatibility with deployments that intentionally bind a worker to one
installation, set the optional legacy
`LIBRECHAT_CODE_GITHUB_INSTALLATION_ID` fallback.

App-authenticated commits use the GitHub App bot's canonical no-reply identity,
so GitHub links them to the bot profile and avatar. A personal access token is
supported as a fallback with
`LIBRECHAT_CODE_GITHUB_TOKEN`, but the GitHub App is the safer default because
its repository access and permissions can be narrowly installed and revoked.
Native Windows credential storage is unavailable until native DACL removal and
verification are implemented; use macOS, Linux, or WSL2. This also applies to GitHub App
private keys.

Git receives authentication through process-scoped `GIT_CONFIG_*` variables.
When the GitHub CLI is installed, `gh api`, pull-request, issue, and workflow
commands receive the same installation scope through `GH_TOKEN` (or
`GH_ENTERPRISE_TOKEN` for GHES). The same isolated Git config supplies the
standard Git LFS filters; hosts using LFS must install `git-lfs`, and checkout
fails instead of silently leaving pointer files when it is unavailable.
SRT replaces each real credential with a sentinel inside the sandbox and
substitutes the real value in its host proxy only for the corresponding Git or
GitHub API host. TLS termination is enabled for that substitution. The worker
restores the parent environment immediately after constructing the sandbox
command; it never writes credentials into the repository, a remote URL, Git
config, or the GitHub CLI credential store.
GitHub's required domains are added to the command egress allowlist only when
authentication is configured. The worker identity, GitHub App key path, token
source variables, and mutation-quarantine record remain denied to sandboxed
commands.

For GitHub Enterprise Server, set `LIBRECHAT_CODE_GITHUB_HOST` to its hostname.
App authentication defaults to `https://<host>/api/v3`; GitHub.com continues to
use `https://api.github.com`. Set `LIBRECHAT_CODE_GITHUB_API_URL` to override
the HTTPS API base URL, including a custom port or path. Its hostname must
match the configured Git host (with `api.github.com` corresponding to
`github.com`), and it must not contain credentials, a query, or a fragment.
App token requests do not follow redirects. GitHub
authentication currently requires the `native-srt` command sandbox. Every
clone, commit, or push command still crosses LibreChat's tool-approval policy;
the credential boundary does not grant approval by itself.

Select the backend explicitly when desired:

```bash
LIBRECHAT_CODE_COMMAND_SANDBOX=native-srt librechat-code run \
  --worker-dir /path/to/project --allow-workspace-commands
```

### Trusted VM command policy

The native SRT backend can be made intentionally permissive when the selected
machine already supplies an administrator-approved outer security boundary.
The `trusted-vm` preset keeps SRT's direct filesystem rules, credential
masking, private scratch storage, cancellation, time limits, and output limits,
while allowing unmatched outbound destinations, local port binding, and Unix
sockets:

```bash
librechat-code run \
  --worker-dir /home/ubuntu/src \
  --allow-workspace-writes \
  --allow-workspace-commands \
  --command-policy-preset trusted-vm
```

`LIBRECHAT_CODE_COMMAND_POLICY_PRESET=trusted-vm` is the environment equivalent.
The default is `restricted`, which preserves the default-deny network policy.
The preset configures `native-srt`; it is not an unsandboxed host-shell
backend. It is rejected unless native workspace commands are enabled. Its
normalized effective controls are included in the worker policy digest, and
the worker advertises `anthropic-srt:trusted-vm` unless an operator supplied a
custom sandbox profile label.

Treat this preset as delegation to the machine's outer security controls. Any
outbound destination can receive workspace data, local listeners can accept
connections reachable under host policy, and Unix socket access may expose
powerful host services such as a container daemon. A socket that grants host
privilege can bypass SRT's filesystem rules and reach worker or GitHub identity
material; the outer VM boundary must prevent that path or explicitly accept
that trust. Register only the intended source root. Worker identity,
mutation-quarantine state, and configured GitHub App key files must remain
outside it.

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
`write_file` preserves its overwrite behavior by default; callers can set
`overwrite: false` to require an atomic create that returns `EDIT_CONFLICT` if
the target already exists. Code API dispatches that mode only after the worker
and server negotiate `create` in `writeFileModes`.
`edit_file` accepts either the legacy `oldText`/`newText` pair or an ordered
`edits` array; every exact replacement is validated before the updated file is
installed as one atomic mutation. Code API dispatches the batch form only after
the worker and server negotiate `batch` in `editFileModes`.
Revision-fenced edits likewise require the negotiated
`expected_base_sha256` entry in `editFileFeatures`.

Edits apply in order, each to the text the earlier ones produced. When any edit
fails, the worker still checks the rest and rejects the whole batch with one
`EDIT_CONFLICT` whose message lists every failing edit by position. Large
batch messages shorten reasons and source excerpts to stay within the bound,
but never omit failing edit positions. A missing edit names the nearest
candidate line and flags elided (`...`) or line-numbered `oldText`, a
whitespace-only difference, or CRLF line endings.
An ambiguous edit gives its match count and line numbers. Overlapping
occurrences count as separate locations. Detailed source-line excerpts require
`read_file` or `preview_edit` on the same workspace; edit-only workers return a
generic failure and its error code without revealing file contents. A preview
itself exposes the resulting file text, so it is read-capable.

Two optional features change matching, each negotiated in `editFileFeatures`
before Code API dispatches it:

- `tolerant_match`: a request-level `matching: 'tolerant'` falls back from an
  exact match to, in order, `line-trimmed` (ignores trailing whitespace and
  CRLF), `indentation-flexible` (a uniformly shifted block, with `newText`
  moved to the file's indentation) and `whitespace-normalized` (any whitespace
  run between complete whitespace-delimited tokens, never a prefix or suffix
  of another token). Without `replaceAll`, a match must still be unique;
  replacements use the matched line's ending even in mixed-ending files. The
  whitespace-normalized tier peels the complete shared newline-and-indentation
  wrapper from `newText` even when CRLF/LF or nearby spaces differ, without
  removing intentional extra line breaks or duplicating the source line ending.
  Boundary whitespace claimed by `oldText`, including the number of line breaks,
  must exist beside the matched tokens in the source; an attempt to remove it
  with a token-only fallback fails rather than silently preserving it. Exact and
  line-window matches can still replace terminators.
  Excessively repetitive indentation candidates fail closed with a request
  for more context rather than scanning every long window. Dense files reuse a
  compact newline index for matching and diagnostics; overlapping exact matches
  are counted without restarting a scan at each offset.
- `replace_all`: a batch edit's `replaceAll: true` replaces every
  non-overlapping match instead of requiring exactly one, and still fails when
  nothing matches.

A request that sets `matching` or any `replaceAll` receives `matches`, one
`{ strategy, occurrences }` entry per edit. Requests that set neither receive
exactly the legacy result.
Only IDs, names, protocol version, supported operations, and negotiated write
modes appear in worker capabilities; absolute host paths remain local to the
worker process.

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
stop after bounded global result counts. A truncated `list_files` result includes
`nextAfterPath`; pass that value back as `afterPath` with the same workspace and
path to continue deterministically beyond the 500-file protocol ceiling.
Continuation is advertised and negotiated as the `after_path` list-file feature,
so mixed Code API and worker versions keep the legacy bounded response shape
during rolling upgrades. The worker process still belongs inside the trusted
BYOM boundary and should receive filesystem access only to roots the operator
intentionally registers.

Writes are limited to 1 MiB of UTF-8 text and require an existing directory
inside the registered root. They reject traversal, symlink targets, and
non-regular files, and commit through an owner-only temporary file followed by
an atomic rename. The worker syncs the containing directory and verifies that
the installed inode still contains the requested bytes before reporting
success. Edits replace text only when the requested old text occurs exactly
once (unless negotiated `replaceAll` selects every non-overlapping match) and
reject if the file changes before commit. Intermediate replacements are bounded
before construction, including `replaceAll`; these operations do not create
directories or execute commands.

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

### Opt-in concurrent native workspaces

Code API defaults to **one execution slot**. To allow independent native roots
to execute concurrently, configure `CODEAPI_BRIDGE_MAX_WORKSPACE_LEASE_SLOTS=2`
on every Code API replica and start an updated worker with:

```sh
librechat-code run \
  --worker-dir /projects/first \
  --workspace second=/projects/second \
  --workspace-lease-slots 2 \
  --allow-workspace-writes \
  --allow-workspace-commands
```

Slots are per machine, not a fleet-wide execution limit. A busy machine does not
consume another machine's slots. Requests for the same root remain serialized,
including commands started through background tools. Independent checkouts can
use different slots; selecting subdirectories beneath one registered parent root
does not create separate scheduling boundaries.

To bind each conversation to an isolated checkout of the selected Git
repository, configure worker-owned conversation worktrees:

```sh
librechat-code run \
  --worker-dir /projects/LibreChat \
  --workspace-lease-slots 4 \
  --conversation-worktree-root /var/lib/librechat-code/worktrees \
  --conversation-worktree-max 64 \
  --conversation-worktree-clone-timeout-ms 300000 \
  --allow-workspace-writes \
  --allow-workspace-commands
```

`LIBRECHAT_CODE_CONVERSATION_WORKTREE_ROOT` and
`LIBRECHAT_CODE_CONVERSATION_WORKTREE_MAX` are the environment equivalents;
`LIBRECHAT_CODE_CONVERSATION_WORKTREE_CLONE_TIMEOUT_MS` controls the bounded
clone budget (five minutes by default, from 30 seconds through 30 minutes).
The storage root must be owner-controlled, must not overlap a registered
workspace, and every registered source must be a Git repository. The worker
creates a deterministic branch in an isolated local checkout for the opaque
conversation identity supplied by LibreChat. Each checkout owns its writable
Git metadata and object storage, without alternates or hardlinks to the source.
Provisioning pins the source Git-directory and object-store identities. It copies
Git data through no-follow, descriptor-relative reads into private staging before
running Git; source hooks and config includes are not used. The clone budget
also bounds this snapshot. Local hardlinks only connect private staging to its
new checkout, never to the source; staging is removed before setup. Source
alternates admitted at worker startup are materialized into independent objects.
Git metadata replacement requires operator recovery, not automatic re-admission.
Host paths remain private. The configured count
is a hard per-machine quota, provisioning is serialized, and operations for one
conversation remain serialized while different conversations may occupy
different lease slots. Recognizable abandoned checkouts without a lifecycle
record are discarded before admission. New provisioning reserves its record
before starting Git or setup; a worker crash leaves that checkout reserved for
operator recovery because child processes might still be running.
Reservations count even when a crash happens before a checkout directory exists.

Cancellation also covers waiting for the provisioning lock, cloning, and setup.
The worker waits for setup cleanup before releasing the assignment. If cleanup
cannot be confirmed, the checkout stays reserved and fails closed on restart.
A completed checkout with a changed source identity or invalid completion record
is preserved for operator recovery, including any uncommitted work. After stopping
the worker and confirming no executor still uses the checkout, an operator can
archive the affected checkout and its adjacent `.complete` record before retrying.
Also archive any adjacent `.source` staging directory. Pre-release version-1
completion records are deliberately preserved but not admitted by this version;
they do not contain the required source Git identity binding.

By default, GitHub App routing is inherited from the operator-admitted source
repository; commands cannot select a different installation by rewriting a
worktree remote. On trusted VMs, the opt-in checkout routing mode above instead
uses the current worktree's local `origin` URL, within the admitted root.
Legacy requests without a conversation identity continue to use the selected
source root. Older Code API deployments do not negotiate the capability, so the
worker omits it until every request path understands the isolation boundary.

#### Linked worktree lanes

Agents that keep one checkout and give each task its own linked worktree
(`git worktree add .worktrees/<task>`) can run those tasks concurrently:

```sh
librechat-code run \
  --worker-dir /projects/LibreChat \
  --workspace-lease-slots 4 \
  --linked-worktree-lanes \
  --allow-workspace-writes \
  --allow-workspace-commands
```

`LIBRECHAT_CODE_LINKED_WORKTREE_LANES=true` is the environment equivalent. The
worker then advertises `workspaceScopes: ['git_linked_worktree']` for each
registered root, and a request that names `worktree: <name>` runs in its own
lane at `<root>/.worktrees/<name>`, with `cwd` and file paths relative to that
worktree. Sibling lanes run concurrently up to the negotiated slot count. A
lane and its checkout never run at the same time: requests without a
`worktree`, including `git worktree add` or `remove` run at the root, wait for
every lane beneath the checkout, and a waiting root request holds back newer
lanes so it cannot be starved.

Before admission the worker verifies, without running Git, that the directory
is a real linked worktree of that checkout: no symlinks on the path, a `.git`
file pointing at `<root>/.git/worktrees/<name>`, and metadata whose `commondir`
and `gitdir` point back. Shared Git storage paths granted for writes must be
real directories, not symlinks into sibling metadata; optional log and LFS
paths may be absent. A lane's sandbox can write only its worktree, the
shared object and ref storage (`.git/objects`, `.git/refs`, `.git/logs/refs`,
`.git/lfs`) and its own `.git/worktrees/<name>` metadata. Everything else in
`.git` stays read-only: configuration, hooks and `info`, the checkout's own
`HEAD`, index and merge or rebase state, and sibling metadata. Automatic `gc`
and maintenance are disabled, and `git gc` itself cannot run in a lane (it
needs to write `.git/gc.pid` and `packed-refs`). A lane's `PATH` starts with
a read-only Git wrapper that refuses `prune`, `gc`, `repack`, `prune-packed`,
`maintenance`, `multi-pack-index`, `for-each-repo` and `git lfs prune`,
including after Git options such as `-C` or `-c`. `for-each-repo` is refused
entirely because Git dispatches its child commands without re-entering the
wrapper. It rejects `git lfs fetch` or `pull` with
`--prune`/`-p`, and `git fetch` or `pull` with `--auto-maintenance`/`--auto-gc`.
It enforces `maintenance.auto=false`, `gc.auto=0` and `help.autocorrect=0`
after caller-supplied Git options, preventing those overrides from restoring
automatic maintenance or correcting a misspelled command to `prune`.
It also refuses **all configured Git aliases**,
including harmless ones: aliases can hide destructive maintenance through
local config, `-c`, `--config-env`, includes or shell commands. Call the
underlying Git command instead, or run the alias from the checkout. Git's
safe pathspec options (`--literal-pathspecs`, `--glob-pathspecs`,
`--noglob-pathspecs`, `--icase-pathspecs`) remain usable in lanes. Run storage
maintenance from the checkout.

This is a guardrail against accidental commands, **not** a filesystem
boundary: invoking Git by an absolute path, resetting `PATH`, or using a
script that does either bypasses it. Such commands can still delete a sibling
lane's unpublished objects. Do not enable concurrent lanes for agents or
scripts that deliberately bypass the wrapper. The guard requires `/bin/bash`
and a trusted system Git executable; without either, lane commands are not
admitted. Deleting a branch or tag also needs the checkout, because Git locks
`packed-refs` for every ref deletion. Each lane has its own durable quarantine
guard. A lane cannot start while its checkout is quarantined, and a checkout
cannot start while any lane beneath it is.

Lanes require native-srt commands and at least two lease slots, and cannot yet
be combined with conversation worktrees. Code API must advertise
`supportedWorkspaceScopes`; older deployments do not, and the worker omits the
scope for them. Deploy consumers that read worker status (such as LibreChat)
with support for `workspaceScopes` before enabling lanes on a worker.

On an updated Code API, admission waits up to 30 seconds without the
`X-LibreChat-Workspace-Queue-Wait-Ms` request header. A caller may advertise a
positive integer millisecond allowance up to five minutes, capped by any server
queue ceiling. This allowance is separate from the `JOB_TIMEOUT` execution
budget and cannot outlast a shorter client or proxy timeout. A
`WORKSPACE_QUEUE_TIMEOUT` response (HTTP 503,
`Retry-After: 1`) means the operation was not assigned or started; wait for
capacity before submitting it again. This is distinct from `ASSIGNMENT_EXPIRED`
or a transport timeout after dispatch, where execution may have occurred and
mutations must not be blindly retried. No automatic retry is added by this policy.
Align the client's per-attempt timeout and every proxy with the queue **plus**
execution, settlement, and delivery budget before relying on a longer wait.
LibreChat keeps the 30-second admission allowance unless its longer total HTTP
budget is explicitly enabled and the live ingress path is verified. See the
[BYOM worker admission guide](../../docs/byom-worker-admission.md) for the
timeout calculations.

Keep the existing URL, pairing/identity, and network policy configuration.
The primary root keeps its configured workspace ID (default `primary`). Repeat
`--workspace id=path` to add named roots, up to the protocol's 32-root limit.
Roots must already exist and must not overlap or alias one another. Commands
retain the selected root's sandbox boundary, not a shared parent-directory grant.
The `LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE` single-file override is rejected
when multiple roots are configured; unset it to use separate root-derived markers.

`LIBRECHAT_CODE_WORKSPACE_LEASE_SLOTS` is the equivalent worker setting. Both
ceilings must be integers from 1 to 8; the lower ceiling wins. An older Code API
without the negotiation receipt keeps the worker on the serial protocol. Deploy
the updated API to all replicas before enabling slots on workers. A capacity
change while work is active fails closed; stop and drain the worker before
changing it.

Different roots can run concurrently; requests targeting the **same root remain
serialized**, even across chats or agents. This is root-level exclusion, not
file-level locking. Assign separate project/worktree roots for independent work.
The admission queue remains bounded at 32 requests per worker. An idle SRT process
cache is bounded by the local slot setting and evicts only idle executors. Runtime
sandbox assignments continue through the exclusive legacy lane; this does not
enable concurrent Docker/NsJail sessions or bypass any approval/network policy.

An uncertain mutation or executor failure leaves an assignment-owned local guard
and a server-side fence for that root. Healthy roots can continue. The worker
does not replay the failed command. A guard-cleanup failure after settlement fences
the root independently without replacing the committed result. Expiring ownership
receipts exclude command payloads; explicit reset invalidates old fence requests.
The server releases a root only after result finalization **and** explicit local
cleanup confirmation. Local guard cleanup has a five-second bound; an expired
receipt never implies a clean root. Control receipt delivery retries three times.
If delivery remains unavailable, the root remains fenced while every advertised
lane keeps polling. Capacity becomes reusable when its owned reservation is
released or expires; inspect/reset the affected root before using it again.
Reset-only registration stays unready and cannot attract new assignments.
To recover a quarantined native root:

1. Stop the worker and inspect or restore the affected directory.
2. Run `librechat-code clear-workspace-quarantine --worker-dir /projects/second --workspace-id second` using the same deployment/identity configuration.
3. Run the normal worker command with all its root/slot options plus `--reset-workspace-quarantine second`. This verifies the local guard is cleared, resets the server fence, then exits.
4. Restart the normal worker command without the reset option.

A linked-worktree lane keeps its own guard and fence. Inspect or restore
`<root>/.worktrees/<name>`, clear its guard with
`--worker-dir <root>/.worktrees/<name>`, then add
`--reset-workspace-worktree <name>` to the reset command in step 3.

The workspace selector in LibreChat must preserve these registered IDs. Adding
roots here does not grant a principal access or change an agent's selected root.
# Named project environments

An operator can keep a project definition outside the coding workspace and start
the worker with `librechat-code run --environment /operator/app.yaml
--allow-workspace-commands --allow-workspace-writes`. Existing pairing settings
still identify the machine and its principal. Repeat `--environment` for independent,
non-overlapping roots (up to 32). Do not combine definitions with workspace directory,
ID, or name flags or environment variables.

```yaml
name: app-dev
root: /projects/app
repo: example/app
ref: main
setup:
  command: npm ci
  timeoutMs: 300000
actions:
  - name: typecheck
    command: npm run typecheck
    timeoutMs: 120000
```

The root must already exist; relative roots resolve from the YAML file's directory.
Repository and ref are descriptive metadata, not a clone or checkout instruction.
No Git repository is required. Definitions are loaded once at startup, hashed into
the worker's policy identity, and protected from sandbox writes. All definition
files must be outside every registered root. Unknown fields are rejected.
On Linux, startup also verifies the mount namespace so bind mounts cannot expose
definitions or their controlling paths through a workspace. The mount table is
bounded to 4 MiB, with at most 256 exposed mount boundaries; stacked and hidden
mount mappings are considered conservatively. Operators must keep mount topology stable while the
worker runs. This inspection happens at startup, not on the command hot path.

Setup is an operator-authorized startup command under the configured native sandbox
policy. It requires commands to be enabled, runs once per worker startup before
registration by default, and must be idempotent for restarts. Its timeout is bounded to five
minutes and captured output to 8 KiB. Setup failure prevents registration. A nonzero
exit, timeout, crash or uncertain termination retains the workspace quarantine marker;
inspect the workspace before running `librechat-code clear-workspace-quarantine
--worker-dir <environment-root> --workspace-id <environment-name>` with the same
deployment and identity configuration. Only use the separate
`--reset-workspace-quarantine <environment-name>` run option afterward if a server
fence also needs clearing. Only successful setup automatically clears its marker.

## Reusing a prepared checkout

Opt in to checkout-local preparation reuse when setup is an installation rather
than work that must run on every startup:

```yaml
setup:
  command: npm ci
  timeoutMs: 300000
  reuse:
    inputs:
      - package.json
      - package-lock.json
      - packages/api/package.json
      - packages/data-provider/package.json
    checkCommand: test -f node_modules/.package-lock.json && test -x node_modules/.bin/tsc
    checkTimeoutMs: 10000
```

Declare **all** relevant manifests, installation configuration and lifecycle-script
inputs. There is no globbing or automatic monorepo discovery. Inputs must be
existing root-confined regular files: at most 32, 8 MiB per file and 32 MiB total.
Include an operator-maintained toolchain/version file if installation uses tools
other than the worker's Node runtime. Lockfile equality alone does not prove that
arbitrary postinstall scripts are reusable.

The worker fingerprints declared file bytes, the setup recipe, checkout inode,
Node version/ABI, platform/architecture and native command policy. A matching
worker-owned receipt runs the readiness check instead of setup. A nonzero check
reruns setup; a timed-out, signalled or aborted check fails without starting a
replacement command. After successful setup, the check must pass and inputs must
remain unchanged before the worker publishes a receipt. Receipts are bounded,
owner-only files alongside the identity, outside all registered roots and denied
to native commands. Deleting one causes setup to run again; it never clears a
quarantine. Checks are operator commands under the same sandbox and mutation guard
as setup, not unsandboxed host scripts. Keep them cheap and non-mutating.

Existing definitions without `reuse` retain the startup behavior. Fresh conversation
instances use the same preparation contract, with independent checkout receipts.
This does not attach another checkout's `node_modules`, provision linked lanes on
command admission, or recheck existing instances on every command. It does not
deduplicate installed dependencies between worktrees unless snapshots below are
configured, or enforce disk quotas.

Shared tool cache grants below do not attach another checkout's installed dependency
tree. Keep monorepo links and mutable outputs checkout-local. Do not broaden the
sandbox root or symlink another branch's full installation. Shared download caches
alone do not reduce installed `node_modules` copies.

## Copy-on-write installed dependencies

For matching fresh checkouts on the **same clone-capable filesystem**, add a
private snapshot store to the readiness contract:

```yaml
setup:
  command: npm ci
  timeoutMs: 300000
  reuse:
    inputs: [package.json, package-lock.json]
    checkCommand: test -x node_modules/.bin/tsc
    snapshot:
      store: /srv/lia-state/dependency-snapshots
      paths: [node_modules]
      maxBytes: 4294967296
      maxFiles: 200000
```

Create the external store as the worker account with mode `0700`. It must not
overlap any source root, definition, credential or shared tool cache. Commands
cannot read or write it. Use a separate store per project/trust domain. The
portable key includes project identity, declared input bytes, recipe, policy,
Node ABI and platform, but not the checkout inode. Kernel locks serialize setup
for one key; different keys remain independent. Incomplete clones are never
published. Cancellation is checked during bounded traversal.

Matching snapshots restore only when **every** declared `node_modules` directory
is missing. The sandboxed readiness check must pass before accepting the restore.
Existing directories are never replaced by restoration; ordinary setup handles
repair. Include nested workspace installations explicitly. Relative checkout-local
package links are preserved; absolute/escaping links, hard-linked files, links into
Git/worktree control paths and special files are rejected. Hardlink-based package
manager layouts need a different adapter; this snapshot mode targets npm copies.
Changing one restored installation cannot modify the snapshot or another checkout.

This requires APFS clones or Linux reflinks (for example a suitably configured
XFS/Btrfs volume). The worker verifies cloning before installation and rejects
unsupported filesystems instead of silently making full copies or writable hard
links. Ordinary ext4 workers should leave snapshots disabled and can still use
checkout-local preparation receipts and shared downloads. This is **not** Python
virtualenv relocation, automatic preparation of manually created linked lanes,
or a hard quota on arbitrary commands. Validate all install/postinstall inputs
and path-independent artifacts before opting in.

## Shared tool and download resources

Explicit operator-managed stores can live outside the checkouts:

```yaml
resources:
  - kind: npm-cache
    path: /srv/lia-resources/npm
    access: read-write
  - kind: uv-cache
    path: /srv/lia-resources/uv
    access: read-write
  - kind: playwright-browsers
    path: /srv/lia-resources/playwright
    access: read-only
```

Create each directory as the worker service account with mode `0700`, then populate
browser binaries using the matching Playwright version and `PLAYWRIGHT_BROWSERS_PATH`
outside the coding session. Roots must exist and may not be symlinks or overlap any
registered workspace or worker control state. Linux mount-alias checks cover both
directions. Keep the mount namespace stable while the worker runs.

The worker grants only these paths and injects `npm_config_cache`, `UV_CACHE_DIR`
and `PLAYWRIGHT_BROWSERS_PATH` from the loaded definition, including in linked lanes
and fresh conversation worktrees. An undeclared process environment variable never
grants filesystem access. Each store root is inode-bound and revalidated before
commands. Read-only stores stay read-only, and speculative programmatic probes
cannot write any shared store.

Sharing is explicit within one worker's trust domain. Do not share mutable caches
between unrelated principals, store credentials in them, or treat their contents
as trusted worker code. Separate package caches from browsers and mutable browser
profiles, Redis data, build output and test state. Stores currently have no automatic
eviction. The snapshot lifecycle below does not delete these mutable stores. This shares downloads
and browser binaries, not installed `node_modules` trees.
No setup output is sent to the model.

## Storage admission and snapshot lifecycle

Use an explicit free-space floor before managed setup or restoration:

```yaml
storage:
  minFreeBytes: 5368709120       # 5 GiB left for the worker and other activity
  setupReserveBytes: 2147483648 # estimated installation headroom
```

This works without dependency snapshots. Absent `storage`, preparation retains
today's behavior. A ready checkout can still pass its readiness check when disk
is low. When installation is needed, low space rejects it **before** starting the
setup command, with a specific remediation message. These are soft admission
checks, not allocated reservations: concurrent processes and arbitrary shell
writes can still consume space after admission. Put worker identity/quarantine
state on a separate small volume and use filesystem/project quotas for hard
containment. This option neither clears quarantine nor deletes source to recover.

The private snapshot store can bound reproducible dependency versions:

```yaml
setup:
  # command and reuse inputs/readiness omitted here; retain the full contract above
  reuse:
    snapshot:
      store: /srv/lia-state/dependency-snapshots
      paths: [node_modules]
      lifecycle:
        maxStoreBytes: 21474836480
        maxEntries: 8
        retentionMs: 432000000
        scanLimit: 4096
```

Cleanup runs during managed preparation and publication. Oldest inactive snapshots
are reclaimed by last-use age and logical payload/count budgets. Per-key kernel
locks protect installs, restores and publishers; maintenance never waits on or
deletes an active key. A short store-wide lock makes budget checks and publication
atomic, without serializing installations for different keys. Abandoned staging
directories require a worker ownership manifest and a free key lock before removal.
Unknown/unmarked entries are reported and preserved. Lock files are kept to avoid
splitting lock ownership. Scan limits fail closed instead of crawling unbounded data.

The byte budget counts snapshot file lengths, not deduplicated physical blocks,
metadata overhead or working checkout copies. An otherwise valid prepared checkout
does not fail when the cache cannot fit another entry: publication is skipped with
a worker diagnostic, and later low-space admission still applies.

Preview or explicitly apply maintenance without restarting the worker:

```sh
librechat-code prune-environment-storage --environment /etc/librechat-code/app.yaml
librechat-code prune-environment-storage --environment /etc/librechat-code/app.yaml --apply
```

Pass all relevant definitions with repeated `--environment` flags so their roots
participate in isolation checks. Preview is the default and the JSON identifies
`dryRun`, proposed removals, active keys, unknown data and retained logical usage.
The command is host-operator-only, not an agent workspace action. It does not touch
source worktrees (including dirty or unpushed branches), `.verification`, build
outputs, arbitrary installations or mutable npm/uv caches. Source worktree archival
requires the separate worktree ownership/binding lifecycle, not an mtime heuristic.

Named actions are fixed commands without model-supplied substitution. The bridge
advertises only their names and the definition fingerprint, never their shell source
or host root. A command request can select `environmentAction: { name, fingerprint }`;
the worker resolves the command from its loaded definition and rejects stale revisions,
unknown names, other roots, or a changed working directory. Actions use ordinary
command authorization, queueing, cancellation and quarantine. They never override
deployment approval rules or expand the pairing's principal scope.

Rollout: update Code API and the LibreChat environment-descriptor consumer before
enabling this opt-in flag on a worker. Older validators reject the additional metadata.
Existing workers without `--environment` continue to use their existing registration.
