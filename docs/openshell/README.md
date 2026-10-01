# OpenShell backend evaluation

Status: Evaluation. No OpenShell backend is registered or enabled.

Goal: add an opt-in, operator-hosted OpenShell backend behind Code API's existing
execution contract. Keep LibreChat clients, the default HTTP/libkrun backend,
Lambda MicroVMs, and outbound BYOM workers unchanged.

## Baseline and upstream pin

-   Code API baseline: `836d001319015072f9493df5d7710fc371403962`.
-   OpenShell evaluation release: `v0.1.2`, commit
    `6648bd0c290efbc41ba131ee9831ee45cd431f94`.
-   Pin the CLI, gateway, supervisor, and compute driver to that release. Record
    image digests, effective policy, runtime/kernel, and resource limits with each
    live result. The probe checks the CLI version, not the gateway's version.
-   Revalidate this track against each proposed upgrade. Do not use rolling `dev`
    tags for acceptance results.

Upstream references at the evaluation commit:
[license](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/LICENSE),
[third-party notices](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/THIRD-PARTY-NOTICES),
[SDK](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/sdk/typescript/README.md),
[policy schema](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/docs/how-it-works/policies/schema.mdx).

## Integration boundary

Current flow:

```text
LibreChat -> Code API auth/authorization -> Redis job
  -> worker -> signed execute request -> SandboxBackend.execute
  -> runner -> Code API egress gateway -> artifacts/tools
  -> worker result finalization -> client
```

Proposed flow changes only the sandbox backend:

```text
worker -> OpenShell adapter -> private OpenShell gateway
  -> isolated workload + compatible Code API runner
  -> unchanged signed execute contract and Code API egress gateway
```

The backend seam is
[`SandboxBackend`](../../service/src/sandbox-backend/types.ts). Its existing
consumers already own deadlines, queue/backend fencing, artifact restoration,
and result mapping. OpenShell's lifecycle API is not a substitute for the
runner's `/api/v2/execute` protocol.

### Options

| Approach                                     | Trade-off                                                                                               | Decision                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Existing backends only                       | No new control plane; no OpenShell policy/lifecycle integration                                         | Keep as defaults and rollback targets                         |
| Adapter retaining the signed runner contract | Reuses Code API authorization, artifacts, tools, and finalization; runner compatibility is unproven     | Evaluate first                                                |
| Execute code directly with OpenShell exec    | Avoids nested NsJail; requires rebuilding file/tool delivery, manifest validation, and result semantics | Defer unless the runner approach cannot retain its guarantees |

Do not put the LibreChat application, the BYOM identity process, or Code API
control-plane credentials inside an agent workload. The gateway remains private;
Code API authenticates users and authorizes tenant/session access.

## Invariants and owners

| Invariant                                                                      | Owner                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Tenant/user/session authorization and quotas                                   | Code API                                                     |
| Signed body is immutable; `inputDelivery` storage IDs never reach the workload | Worker and adapter                                           |
| Only scoped egress grants authorize artifact and tool access                   | Code API egress gateway and runner                           |
| Queue wait, provisioning, and execution share the original job deadline        | Worker and adapter                                           |
| Abort cannot settle as success; remote execution must terminate                | Adapter and compute runtime                                  |
| Retried jobs cannot create duplicate active execution or repeat mutations      | Adapter, queue fencing, and runtime registry                 |
| Stateful workspace reuse waits for successful `sessionResultFinalizer`         | Worker and adapter                                           |
| Filesystem, process identity, network, and resource restrictions fail closed   | OpenShell policy and selected runtime, plus runner hardening |
| Cleanup is confirmed, not merely requested; orphans remain observable/reapable | Adapter and lifecycle reconciler                             |

OpenShell Docker/Podman policy rejects root workloads. The current runner
entrypoint performs mounts, ownership changes, cgroup setup, and an NsJail smoke
test. Compatibility is a blocker to resolve, not permission to run privileged,
disable manifests, relax Landlock, or bypass hardened startup. OpenShell policy
alone does not establish a separate-kernel tenant boundary.

## Work sequence

### 1. Lifecycle spike (this slice)

-   [x] Pin an upstream release and identify the existing backend seam.
-   [x] Add an explicit, dependency-free CLI probe with strict filesystem policy,
        no network allowances, no attached providers, resource limits, and cleanup.
-   [x] Test validation, cancellation, partial failure, redaction, and nonterminal
        cleanup without a live gateway.
-   [ ] Run the probe against an isolated operator-owned gateway. Record results.

This probe runs only a fixed shell/file round trip. It does **not** exercise Code
API, verify effective policy enforcement, or prove tenant isolation. A gateway
administrator's global policy can override the supplied sandbox policy.

### 2. Hardened runner compatibility

-   [ ] Identify the supported compute/runtime boundary and prove startup without
        weakening the existing security invariants.
-   [ ] Forward the private runner listener through authenticated OpenShell
        transport. Never expose its execute endpoint publicly.
-   [ ] Execute a real worker-built signed request unchanged. Test Python/Bash,
        input/output artifacts, tool-call replay, and error/result parity.
-   [ ] Reject tampered/expired manifests, unauthorized storage handles, access to
        supervisor/control-plane credentials, forbidden destinations, metadata
        endpoints, and cross-tenant workspace reuse.
-   [ ] Verify host/kernel filesystem protection and resource enforcement with
        negative tests, not only effective-policy inspection.

If nesting cannot work securely, stop and design the direct-exec replacement's
full authorization and delivery contract before implementation.

### 3. Opt-in adapter

-   [ ] Use the same-release SDK behind lazy backend loading. Verify package
        availability and locking; this release's TypeScript SDK uses GitHub Packages.
        The CLI is a spike dependency, not a per-job production transport.
-   [ ] Add an explicit backend config gate, isolated queues, and producer/consumer
        backend checks. Old consumers must never pick up OpenShell jobs, including
        legacy jobs without a backend marker.
-   [ ] Start stateless. Reject affinity/strict mode until tenant-bound session
        locks, fencing, finalization, and persistence are implemented and tested.
-   [ ] Cover enqueue-anchored deadlines, cancellation while provisioning/running,
        retry idempotency, gateway failure, ambiguous create responses, accepted/pending
        deletion, worker crashes, orphan reconciliation, and shutdown.
-   [ ] Keep auth tokens and provider credentials out of logs, argv, and workload
        environment. Do not silently fall back to a different backend.

### 4. Acceptance and rollout

-   [ ] Measure concurrency, queue/provision/execute/cleanup latency, resources,
        artifact throughput, and failure rates against the existing backend using the
        same workloads. Record measurements; define targets before promotion.
-   [ ] Exercise gateway restart, worker restart, disconnects, upgrades, cleanup
        backlogs, and quota pressure. Test database/runtime topology before claiming HA.
-   [ ] Pin deployment artifacts, collect required notices/SBOMs, and document
        private gateway authentication, backups, upgrades, and orphan operations.
-   [ ] Canary a separate endpoint and worker pool only after compatibility and
        security gates pass. Roll back routing, then drain the new queues. No automatic
        file/workspace migration or production-default change is part of this track.

## Run the lifecycle probe

Requirements: Node 20+, an OpenShell `0.1.2` CLI, a registered named evaluation
gateway using the matching release, and a digest-pinned shell/coreutils image
pullable by that gateway. Install and configure these separately on dedicated
infrastructure. This repository does not install or start a gateway.

```bash
node --test scripts/openshell/probe.test.mjs

node scripts/openshell/probe.mjs \
  --gateway codeapi-evaluation \
  --workspace default \
  --image 'REGISTRY/IMAGE@sha256:REPLACE_WITH_64_HEX_DIGEST'
```

The live command creates and deletes one uniquely named `codeapi-probe-*`
sandbox. It uses the bundled policy, one CPU, 256 MiB, manual approvals, no
credential auto-discovery, and a fixed ten-second exec timeout. Each CLI phase
has a 120-second timeout (`--timeout-ms`, maximum 300000); this is not the
production job deadline. SIGINT/SIGTERM abort work but allow an independent
bounded cleanup attempt. SIGKILL or host/process failure cannot run cleanup.

Only the pinned CLI's terminal `Deleted` or `already deleted` acknowledgement
confirms cleanup. Accepted/pending, unfamiliar, failed, and timed-out deletion
results fail the probe. CLI stdout/stderr are not emitted, except sanitized
phase/version/timing results. The live probe's overall success requires both
the file round trip and confirmed cleanup.

On failure, use the emitted sandbox name and the **same gateway/workspace** to
inspect and reconcile it. A timed-out create can finish after cleanup; even an
`already deleted` acknowledgement does not resolve that race. Review the
gateway's resources after any ambiguous create or process failure. Do not retry
blindly or interpret `cleanup=confirmed` on a failed run as an orphan-free
fleet. Automated reconciliation is an adapter acceptance gate.

## License implications

OpenShell is Apache-2.0 at the pinned commit. That permits commercial hosted use
and modification without a network-use source-disclosure obligation. It does
not grant NVIDIA trademark rights or a support/warranty commitment.

For distributed images or on-prem packages, include the license, preserve
applicable attribution/notices, mark modified upstream files, and audit bundled
runtime/SDK/image/model dependencies separately. This slice distributes no
OpenShell binaries or SDK and introduces no paid NVIDIA service dependency.
