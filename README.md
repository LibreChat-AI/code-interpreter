# Code Interpreter

Sandboxed code execution service for LibreChat, providing secure execution of user-submitted code with file storage and tool calling capabilities.

## Overview

Code Interpreter (internally `codeapi`, the prefix used by its env vars, images, and helm chart) is a multi-component service that enables LibreChat to safely execute user code in isolated sandboxes. It consists of five independently scalable components that communicate via Redis queues and S3-compatible storage.

## Components

- **API** - HTTP gateway that accepts code execution requests and returns results
- **Worker Sandbox** - Executes code in NsJail (or libkrun microVM) sandboxes with resource limits
- **File Server** - Manages file uploads/downloads via S3 (IRSA authentication)
- **Tool Call Server** - Handles programmatic tool calls from within sandbox sessions
- **Package Delivery** - Bakes Python, Node, and Bun into the default microVM
  block-root image; a package-init PVC mode remains available for direct NsJail
  development
- **Remote Code Bridge** - Lets an operator-owned VM connect outbound and serve
  as a fenced, stateful sandbox through the `@librechat/code` worker

## Architecture

1. LibreChat sends a code execution request to the **API**
2. API enqueues the job in Redis
3. **Worker Sandbox** picks up the job and executes code inside an isolated sandbox
4. Files are persisted/retrieved via the **File Server** (backed by S3)
5. Tool calls from within sandboxes are routed through the **Tool Call Server**

## Execution profiles

Code API can run two isolated deployments at the same time:

- `default`: the AWS-free HTTP/libkrun path, with stateless executions.
- `stateful`: the AWS Lambda MicroVM path, with runtime-session affinity.

Set `CODEAPI_EXECUTION_PROFILE` consistently on an API deployment and its
workers. The default profile keeps the existing `python-queue` and
`other-queue`; the stateful profile uses `stateful-python-queue` and
`stateful-other-queue`. This allows both deployments to share Redis without
cross-consuming jobs. The `remote-bridge` backend additionally uses
`remote-bridge-python-queue` and `remote-bridge-other-queue`, fencing attached
worker jobs from Lambda consumers during rolling deployments.

An existing Lambda MicroVM deployment upgraded from a pre-profile release may
leave `CODEAPI_EXECUTION_PROFILE` unset for its first binary rollout. An
affinity/strict deployment still identifies itself as `stateful`; a stateless
Lambda deployment identifies itself as `default`. Both temporarily keep the
legacy queue names so separately deployed APIs and workers remain compatible
with old binaries.
Move that deployment to the isolated stateful queues with a blue/green cutover:
start replacement API and worker pools with the profile explicitly set to
`stateful`, verify them together, switch the stateful endpoint, and drain the
legacy pool. For rollback, switch the endpoint back before stopping the
replacement pool. Do not run the inferred stateful compatibility mode beside a
default deployment on the same Redis because both use the legacy queues.

Trusted callers should send `X-CodeAPI-Expected-Profile: default|stateful` on
every Code API request. A request that reaches the wrong deployment fails
before enqueue with HTTP 409 and `error=execution_profile_mismatch`; every
response advertises the actual deployment in `X-CodeAPI-Execution-Profile`.
Omitting the expected-profile header remains supported for older clients, but
provides no wrong-endpoint protection. There is deliberately no silent
fallback between profiles and no automatic workspace or file migration.

## OpenShell evaluation

An opt-in OpenShell backend is under [evaluation](docs/openshell/README.md).
The initial track provides a pinned lifecycle probe and security/compatibility
gates. It does not add a backend or change execution routing.

## Sandbox Isolation

Two modes are supported:

- **NsJail mode** (`kvmEnabled: false`): Direct NsJail sandboxing with Linux namespaces and cgroups
- **MicroVM mode** (`kvmEnabled: true`): libkrun microVM with its own kernel, NsJail runs inside the guest

## Remote stateful environments

The `remote-bridge` backend keeps the Code API as the policy and queue boundary
while moving execution to a sandbox on an operator-selected VM. The worker only
makes outbound authenticated requests, so the VM does not need a public ingress
port. Assignments carry a deadline, a single-active-worker lock, a monotonically
increasing generation, and a one-time lease token to fence stale workers.

See [Remote Code Bridge](docs/remote-bridge/README.md) for deployment and threat
model details. The worker protocol and CLI live in the provider-neutral
[`@librechat/code`](packages/code/README.md) package.

## Security disclaimer

This service exists to run arbitrary, untrusted code — treat every
deployment decision accordingly.

In its full hardened configuration — MicroVM mode (`kvmEnabled: true`, so
sandboxed code runs under a separate guest kernel) with NsJail inside the
guest, seccomp filtering, the egress gateway in front of all
sandbox-originated traffic, network policies applied, signed execution
manifests, and `hardenedSandboxMode` left on — it is reasonably secure and
designed with defense in depth. NsJail-only mode shares the host kernel and
provides meaningfully weaker isolation: it is appropriate for local
development, not for executing untrusted code from people you don't trust.

No software is 100% secure. Sandbox escapes, kernel vulnerabilities, and
misconfiguration are all real risks for any code-execution system. Keep the
hardening defaults on, run the stack on isolated infrastructure with least
privilege, keep hosts patched, and deploy responsibly. If you believe you
have found a vulnerability, please report it privately rather than opening a
public issue (see [CONTRIBUTING](CONTRIBUTING.md)).

## Releases

Deployments should pin a [tagged release](https://github.com/LibreChat-AI/code-interpreter/releases)
rather than track `main`, which moves whenever an internal snapshot is merged:

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/LibreChat-AI/code-interpreter.git
```

Every release attaches `codeapi-<chart version>.tgz`, the packaged Helm chart
with its Redis and MinIO subcharts vendored:

```bash
helm install codeapi ./codeapi-0.3.1.tgz -f my-values.yaml
```

Versions are `vMAJOR.MINOR.PATCH`, with `-rcN` release candidates published as
pre-releases. See [docs/RELEASING.md](docs/RELEASING.md) for how releases are
cut.

## Prebuilt images

The [Images workflow](.github/workflows/images.yml) builds one `linux/amd64`
image per Compose build and publishes it to GHCR whenever a push to `main`
changes an image input:

| Image (`ghcr.io/librechat-ai/…`) | Dockerfile (target) | Compose service |
|---|---|---|
| `code-interpreter-api` | `service/Dockerfile` (`api`) | `api` |
| `code-interpreter-worker` | `service/Dockerfile` (`worker`) | `service-worker` |
| `code-interpreter-file-server` | `service/Dockerfile` (`production`) | `file_server` |
| `code-interpreter-egress-gateway` | `service/Dockerfile.egress-gateway` (`production`) | `egress_gateway` |
| `code-interpreter-tool-call-server` | `service/Dockerfile.tool-call-server` (`production`) | `tool_call_server` |
| `code-interpreter-sandbox-runner` | `api/Dockerfile` (`sandbox-runner-true`) | `sandbox-runner`, `KVM_ENABLED=true` (default) |
| `code-interpreter-sandbox-runner-direct` | `api/Dockerfile` (`sandbox-runner-false`) | `sandbox-runner`, `KVM_ENABLED=false` |

Tags:

- `sha-<full commit SHA>` for every commit on `main` that changes an image
  input. Commits that change none (docs, Helm, tests) get no tags, so take the
  SHA from a successful Images run or the package page.
- `main`, pointed at the newest commit on `main` that has all seven images.
  The seven tags move one after another, so pin `sha-` tags for deployments
  and treat `main` as a convenience.

There is no `latest`. `sha-` tags are written once: re-running the workflow
for a commit builds only the images whose tag is missing. For exact bytes,
replace a service's
`image:` below with `ghcr.io/librechat-ai/<image>@sha256:<digest>`; each image
has its own digest, listed in the summary of the run that pushed it.

Pulling a public package needs no login. A private package needs
`docker login ghcr.io` with a token that has `read:packages`; GHCR creates new
packages as private until an organization owner changes their visibility.

To switch a Compose host from building to pulling, save this override as
`docker-compose.images.yml` (`!reset` needs Docker Compose 2.24.4 or later):

```yaml
services:
  api:
    build: !reset null
    image: ghcr.io/librechat-ai/code-interpreter-api:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
  service-worker:
    build: !reset null
    image: ghcr.io/librechat-ai/code-interpreter-worker:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
  file_server:
    build: !reset null
    image: ghcr.io/librechat-ai/code-interpreter-file-server:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
  egress_gateway:
    build: !reset null
    image: ghcr.io/librechat-ai/code-interpreter-egress-gateway:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
  tool_call_server:
    build: !reset null
    image: ghcr.io/librechat-ai/code-interpreter-tool-call-server:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
  sandbox-runner:
    build: !reset null
    # With KVM_ENABLED=false use code-interpreter-sandbox-runner-direct, which
    # still reads runtime packages from SANDBOX_PACKAGES_PATH.
    image: ghcr.io/librechat-ai/code-interpreter-sandbox-runner:${CODEAPI_IMAGE_TAG:?set CODEAPI_IMAGE_TAG}
    pull_policy: missing
```

Then pin a built commit and start the stack, listing any host override after
it. Keep the checkout at the same commit as the images, so the Compose
configuration matches what the images expect. `docker-compose.mac.yml` runs
the unpublished `sandbox-build` target with its own entrypoint, so on macOS
leave `sandbox-runner` out of this override and keep building it:

```bash
export CODEAPI_IMAGE_TAG=sha-<commit>
docker compose -f docker-compose.yaml -f docker-compose.images.yml pull
docker compose -f docker-compose.yaml -f docker-compose.images.yml up -d
```

`pull_policy: missing` never re-pulls a tag the host already has, which suits
an immutable `sha-` tag. To track `main` instead, set `CODEAPI_IMAGE_TAG=main`
and run `pull` before every `up`.

## Local Development

Copy `.env.example` to `.env` and set `CODEAPI_BRIDGE_TOKEN` to a private value
of at least 32 bytes (generate one with `openssl rand -hex 32`). The API exposes
bridge routes when configured through the remote-bridge backend, paired auth,
dynamic workers, or a bridge token. Hardened deployments with none of these
configured leave bridge routes disabled and do not require a bridge token.
Enabled bridges still require this enrollment credential. Compose defaults to
`CODEAPI_BRIDGE_AUTH_MODE=paired` and `CODEAPI_BRIDGE_DYNAMIC_WORKERS=true`.
To restrict pairing to a fixed worker, set `CODEAPI_BRIDGE_DYNAMIC_WORKERS=false`
and `CODEAPI_BRIDGE_WORKER_ID` to its ID. Keep the token outside workspaces and
model-visible configuration.

```bash
docker-compose up --build
```

The default KVM Compose path builds `sandbox-runner-baked`: the guest root and
`/pkgs` tree live in a read-only ext4 block image instead of a long-lived
virtio-fs mount. The first image build takes longer because it compiles the
language runtimes, but package-heavy workloads do not accumulate host file
descriptors in the launcher.

KVM guests use the runner container's `/etc/resolv.conf`, including Docker's
embedded resolver or Kubernetes nameservers and search domains. The launcher
preserves service hostnames instead of pinning their startup IP addresses.
Both baked and directory rootfs images contain a resolver symlink whose target
is populated by a guest wrapper in private `/run` runtime storage before any
`LAUNCHER_EXEC` executable starts; the
read-only root disk does not need modification at boot. Rebuild the runner
image to pick up this layout change. A missing resolver handoff fails startup
rather than leaving the guest with an unrelated public DNS server.

The guest kernel keeps loopback traffic on its own loopback device instead of
proxying it through TSI, so it cannot reach a loopback resolver such as Docker's
embedded `127.0.0.11`. The launcher entrypoint relays the first loopback
nameserver (`127.0.0.0/8` or `::1`) over UDP and TCP port 53 from the runner's
own IPv4 address with `socat`, and forwards that address to the guest in its
place; further loopback nameservers are dropped, and startup fails if the relay
cannot listen. Relay children exit when idle, and the TCP relay caps its
concurrent children. Routable nameservers, including Kubernetes cluster DNS, are forwarded
unchanged.

libkrun delivers the guest environment on the kernel command line, which only
carries single-line printable ASCII and is capped at 2048 bytes by the guest
kernel. The launcher entrypoint therefore forwards only the `nameserver`,
`search`, `domain`, `options` and `sortlist` directives, joined by `|`, and the
guest wrapper expands them back into `/etc/resolv.conf` lines. The launcher
rejects any forwarded variable that would not survive that trip (control
characters, non-ASCII bytes, quoting the kernel would split, or an oversized
environment) with a named error instead of a libkrun panic and restart loop.

To validate a deployment, execute code that creates a file in `/mnt/data`,
confirm the response includes its file reference, and download it. Recreate the
egress gateway with a different container IP while leaving the runner alive,
then repeat after DNS caches expire. The file must still upload and download;
`artifact_delivery` must not report a failure. `tests/kvm_guest_dns.sh` checks
the resolver handoff and rootfs assembly without requiring KVM.

Setting `KVM_ENABLED=false` still selects the directory-root target and the
host package mount automatically for direct NsJail development.

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
