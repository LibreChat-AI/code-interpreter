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
cross-consuming jobs.

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

## Sandbox Isolation

Two modes are supported:

- **NsJail mode** (`kvmEnabled: false`): Direct NsJail sandboxing with Linux namespaces and cgroups
- **MicroVM mode** (`kvmEnabled: true`): libkrun microVM with its own kernel, NsJail runs inside the guest

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

## Local Development

```bash
docker-compose up --build
```

The default KVM Compose path builds `sandbox-runner-baked`: the guest root and
`/pkgs` tree live in a read-only ext4 block image instead of a long-lived
virtio-fs mount. The first image build takes longer because it compiles the
language runtimes, but package-heavy workloads do not accumulate host file
descriptors in the launcher.

Setting `KVM_ENABLED=false` still selects the directory-root target and the
host package mount automatically for direct NsJail development.

## Optional Bash output filtering

Bash executions can opt into [RTK](https://github.com/rtk-ai/rtk) command
rewriting per request by setting `shell_output_filter` to `rtk`:

```json
{
  "lang": "bash",
  "code": "ls -la",
  "shell_output_filter": "rtk"
}
```

Omitting the field (or setting it to `raw`) preserves the original execution
path, which makes side-by-side evaluation straightforward. RTK `v0.45.0` is
source-pinned to its immutable release commit and preinstalled in the sandbox
image; it can also be invoked directly from Bash. Rewriting happens inside
NsJail and fails open to the original script when RTK does not support a
command or cannot run. Prometheus
metrics expose Bash execution counts, outcomes, and stdout/stderr byte sizes by
the `raw` or `rtk` filter without adding request-specific labels.

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
