# `@librechat/code`

Provider-neutral protocol and worker CLI for attaching a stateful, sandboxed
code environment to LibreChat Code API.

The CLI owns the runtime-supervisor seam. The bundled endpoint adapter connects
to an already-running loopback Code Interpreter sandbox; future adapters create
and isolate the runtime themselves. It connects outbound to Code API,
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

## Docker runtime supervisor (programmatic adapter)

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

LIBRECHAT_CODE_RUNTIME_SUPERVISOR=docker-macos-nsjail \
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

- `LIBRECHAT_CODE_SANDBOX_PROFILE`: capability label; defaults to `nsjail`.
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

After discarding or resetting that session's local runner, acknowledge recovery
with `librechat-code reset-workspace <runtime-session-id>`. The command uses the
configured worker credentials, registers a fresh incarnation, and only clears
the server fence when no assignment is active. Run it while the normal worker
process is stopped, then restart the normal worker after the command exits.
