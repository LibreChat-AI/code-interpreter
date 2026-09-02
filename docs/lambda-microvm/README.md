# Stateful Code Sessions on AWS Lambda MicroVMs

This directory documents and provisions the **optional** AWS Lambda MicroVM
execution backend for the CodeAPI sandbox. It turns the semi-stateless Code
Interpreter into one that offers **perceived-indefinite stateful sessions**: a
warm per-session workspace plus checkpoint/restore across the VM's 8-hour
lifetime, without changing the default HTTP behavior.

- Config reference and knobs → below.
- One-command AWS prerequisites → [`terraform/`](./terraform).
- Image build helper → [`../../service/scripts/create-microvm-image.ts`](../../service/scripts/create-microvm-image.ts).

> This is a config-gated feature. With `CODEAPI_SANDBOX_BACKEND` unset, nothing
> here is active and the sandbox behaves exactly as before.

---

## The cross-repo picture

Stateful sessions span three repos. Each owns one layer, and they degrade
gracefully out of order (the wire fields are additive and ignored when absent).

| Repo | Provides | Key artifact |
|---|---|---|
| **code-interpreter** (this repo) | The Code API service + the Lambda MicroVM backend, the runner's persistent workspace, checkpoint/restore, and the session registry. Owns **all** AWS config. | `CODEAPI_SANDBOX_BACKEND=lambda-microvm` |
| **@librechat/agents** | The SDK surface: `toolExecution.sandbox.statefulSessions` and the `statefulSessions` tool-factory param. Stamps a per-conversation session hint on `/exec`. | `runtime_session_hint` on the wire |
| **LibreChat** | The `stateful_code_sessions` app capability + a per-agent Agent Builder toggle, wired into `createRun`. | endpoints.agents capability + agent toggle |

**Trust boundary:** LibreChat and the agents SDK never learn any AWS
configuration. They speak the same `/exec` HTTP protocol as always, plus one
optional `runtime_session_hint` field. Everything AWS — backend selection, the
image ARN, roles, connectors, the checkpoint bucket, credentials — lives only in
this service's environment. An operator can switch this service between `http`
and `lambda-microvm` (or run with no AWS at all) with zero changes upstream.

---

## How a request flows

```
agent tool call
      │  POST /exec  (+ optional runtime_session_hint)
      ▼
CodeAPI service ── derive runtime_session_id = hash(tenant, user, hint)
      │                       │
      │            Redis session registry (SET NX lock, generation fence)
      ▼                       │
SandboxBackend (lambda-microvm)
      │  find-or-launch ONE MicroVM per runtime_session_id
      ▼
RunMicrovm ─► warm VM ─► CreateMicrovmAuthToken ─► POST /api/v2/execute
      │                     (X-Runtime-Session-Id header = session mode on)
      ▼
runner reuses ONE /mnt/data workspace across calls
      │  post-exec, lock held: checkpoint /mnt/data ──► S3
      ▼
restore-on-relaunch: a replacement VM pulls the S3 checkpoint before first exec
```

Two independent planes: **presentation/orchestration** (the registry + backend,
which own identity and durability) and **compute** (the MicroVM, which is a cheap,
disposable, resumable cache). If the VM dies, its replacement resumes from the
last successfully committed checkpoint; work after a skipped or failed
checkpoint may need to be run again.

---

## Prerequisites

- An AWS account with **Lambda MicroVMs available** in your region (a new
  service; confirm regional availability first). No default region is assumed —
  every call passes one explicitly.
- **AWS CLI ≥ 2.35** if you want to poke the `aws lambda-microvms` CLI directly
  (older CLIs lack the commands). The scripted image build uses the JS SDK and
  doesn't need a recent CLI.
- Terraform ≥ 1.9 for the prerequisites module.
- Docker with `buildx` (arm64) to build the runner image.
- Redis (the CodeAPI service already depends on it) for the session registry.
- An S3-compatible store for checkpoints (real S3 in prod; MinIO for local dev).
- For the hardened path below, an internal egress-gateway deployment plus a VPC
  network connector/security group that permits the MicroVM to reach only that
  gateway.

---

## Hardened deployment runbook

### 1. Provision AWS prerequisites (Terraform)

`terraform.tfvars.example` targets the disposable AIML-dev stack and explicitly
enables destructive teardown. Remove its three `*_force_*` overrides before
applying it to a retained environment; the module defaults them to `false`.

```bash
cd docs/lambda-microvm/terraform
cp terraform.tfvars.example terraform.tfvars   # edit region, name_prefix, image_name
terraform init -lockfile=readonly && terraform apply
```

This creates the private runner ECR repository, checkpoint bucket (encrypted,
versioned, lifecycle-expired), artifact bucket, the **build role** (trust
includes `sts:TagSession`; permissions include scoped logs, artifact read, and
ECR pull), a **logging-only execution role**, the worker MicroVM/checkpoint
policies, and the build + runtime CloudWatch log groups. Set
`codeapi_worker_role_name` to attach both worker policies directly, or attach the
two output policy ARNs in the stack that owns the worker role. Capture the
outputs:

```bash
terraform output
# runner_ecr_repository_url, build_role_arn, execution_role_arn,
# worker_microvm_control_policy_arn, checkpoint_access_policy_arn, ...
```

The checked-in provider lock file makes `terraform init` reproducible.

### 2. Build + push the runner image, upload the code-artifact

```bash
cd ../../..                     # repo root
export AWS_PROFILE=... AWS_REGION=us-east-1
export ECR_URI=$(terraform -chdir=docs/lambda-microvm/terraform output -raw runner_ecr_repository_url)
export S3_URI=s3://$(terraform -chdir=docs/lambda-microvm/terraform output -raw artifact_bucket)/runner
export IMAGE_TAG=$(git rev-parse --short HEAD)
scripts/build-lambda-microvm-artifact.sh build push zip upload
# → uploads s3://<artifact-bucket>/runner/runner-<tag>.zip
```

The runner image target is `lambda-microvm-runner` in `api/Dockerfile`
(`FROM sandbox-build` + `/pkgs`, `PORT=8080`, `SANDBOX_SESSION_WORKSPACE_ENABLED=true`).
The managed ECR repository uses immutable tags. If a push already succeeded,
choose a fresh `IMAGE_TAG` (for example, append the CI run ID) instead of
rerunning a push to the same commit tag. The `push` stage captures the resulting
ECR digest and the `zip` stage writes `FROM <repository>@sha256:...`; it refuses
to produce a mutable tag-based artifact. The `upload` stage additionally
verifies the artifact's repository, tag, digest, and SHA-256 before writing to
S3. When running `zip` and `upload` in a separate clean workspace, pass the
digest explicitly in the same invocation:

```bash
IMAGE_DIGEST=sha256:<64-hex-digest> \
  scripts/build-lambda-microvm-artifact.sh zip upload
```

### 3. Generate the split execution-manifest keys

The worker signs each execution manifest; the runner only receives the public
verifier. Never bake the private key into the image.

```bash
MANIFEST_KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$MANIFEST_KEY_DIR"' EXIT
ORIGINAL_UMASK="$(umask)"
umask 077
openssl genpkey -algorithm ED25519 -out "$MANIFEST_KEY_DIR/private.pem"
export CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY=$(
  openssl pkey -in "$MANIFEST_KEY_DIR/private.pem" -outform DER | base64 | tr -d '\n'
)
export SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY=$(
  openssl pkey -in "$MANIFEST_KEY_DIR/private.pem" -pubout -outform DER | base64 | tr -d '\n'
)
rm -rf "$MANIFEST_KEY_DIR"
trap - EXIT
umask "$ORIGINAL_UMASK"
unset MANIFEST_KEY_DIR ORIGINAL_UMASK
```

Store the private value in the worker's secret manager. Put only the public
value into the runner image environment below, then unset the private shell
variable after the secret is stored. No private-key file is left in the checkout.

### 4. Create the MicroVM image (hookless)

This walkthrough uses the hardened egress path so output uploads and tool calls
cannot bypass policy. Deploy the `egress-gateway` target from
`service/Dockerfile` behind an internal URL before accepting traffic. Configure
that gateway workload (and no API/worker workload) with:

```bash
CODEAPI_HARDENED_SANDBOX_MODE=true
CODEAPI_EGRESS_GRANT_SECRET=<gateway-only-secret-at-least-32-bytes>
CODEAPI_INTERNAL_SERVICE_TOKEN=<shared-strong-internal-token>
EGRESS_GATEWAY_FILE_SERVER_URL=http://file-server.internal:3000
EGRESS_GATEWAY_TOOL_CALL_SERVER_URL=http://tool-call-server.internal:3033
EGRESS_GATEWAY_PORT=3190
CODEAPI_EGRESS_LEDGER_REQUIRED=true
REDIS_HOST=<shared-redis-host>
# REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD / TLS settings as required
```

The gateway URL must be reachable by both the worker and the MicroVM VPC
connector. Its security group should accept the MicroVM connector on only the
gateway port. The gateway's file/tool upstreams stay private.

```bash
cd service
export EGRESS_GATEWAY_URL=https://egress.internal
export MICROVM_IMAGE_ENV_JSON="$(
  bun -e 'process.stdout.write(JSON.stringify({
    CODEAPI_HARDENED_SANDBOX_MODE: "true",
    EGRESS_GATEWAY_URL: process.env.EGRESS_GATEWAY_URL,
    SANDBOX_CHECKPOINT_MAX_BYTES: "536870912",
    SANDBOX_ALLOWED_LOCAL_NETWORK_PORT: "3033",
    SANDBOX_FORWARD_TARGET: process.env.EGRESS_GATEWAY_URL,
    SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: process.env.SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY,
    SANDBOX_REQUIRE_EGRESS_MANIFEST: "true"
  }))'
)"
AWS_PROFILE=... bun scripts/create-microvm-image.ts \
  --name codeapi-session \
  --artifact s3://<artifact-bucket>/runner/runner-<tag>.zip \
  --build-role $(terraform -chdir=../docs/lambda-microvm/terraform output -raw build_role_arn) \
  --region us-east-1 \
  --env-json "$MICROVM_IMAGE_ENV_JSON"
# Optional for a fully repeatable build:
#   --base-version <immutable-managed-base-version>
# → prints the exact LAMBDA_MICROVM_IMAGE_ARN and LAMBDA_MICROVM_IMAGE_VERSION
```

The helper builds hookless with `additionalOsCapabilities:["ALL"]` and
`SANDBOX_USE_CGROUPV2=false` baked in — the working config (see
[Runbook gotchas](#runbook-gotchas)). **Runner env is baked at image-build
time** (RunMicrovm does not inject it later), so pass your deployment's
egress / manifest config via `--env-json` (or `MICROVM_IMAGE_ENV_JSON`) —
for hardened mode that means `CODEAPI_HARDENED_SANDBOX_MODE`,
`EGRESS_GATEWAY_URL`,
`SANDBOX_CHECKPOINT_MAX_BYTES`, `SANDBOX_ALLOWED_LOCAL_NETWORK_PORT`,
`SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY`, `SANDBOX_REQUIRE_EGRESS_MANIFEST`, and
a `SANDBOX_FORWARD_TARGET` whose host and port match the gateway URL. Never bake
`CODEAPI_INTERNAL_SERVICE_TOKEN`,
`CODEAPI_EGRESS_GRANT_SECRET`, a private manifest key, or direct file/tool
service URLs into the runner. The worker fetches by-reference input objects and
pushes an authenticated cache batch into the runner; the runner does not receive
raw file-server object IDs or need `FILE_SERVER_URL` for inputs. To ship new
runner code later, re-run
`build … push zip upload`, call the helper with `--update`, and deploy the newly
printed pinned version before replacing workers.

`--base-version` (or `MICROVM_BASE_IMAGE_VERSION`) pins the AWS-managed
`--base-image` version as well as the CodeAPI artifact. If omitted, the helper
prints that it used the managed base's latest version; record that fact for a
dev experiment, but pin an immutable base version for reproducible release
builds.

### 5. Configure the CodeAPI service

```bash
CODEAPI_SANDBOX_BACKEND=lambda-microvm
CODEAPI_EXECUTION_PROFILE=stateful
CODEAPI_RUNTIME_SESSION_MODE=affinity          # warm sessions + checkpoints
LAMBDA_MICROVM_IMAGE_ARN=<from step 4>
LAMBDA_MICROVM_IMAGE_VERSION=<exact version from step 4>  # required for affinity/strict
LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<terraform execution_role_arn>
LAMBDA_MICROVM_LOG_GROUP=<terraform runtime_log_group>   # both this AND the role are needed for VM stdout
LAMBDA_MICROVM_REGION=us-east-1
LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS=arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS
LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS=<vpc-egress-connector-arn>

# set on BOTH API and worker; use the same URL/token as the gateway deployment
CODEAPI_HARDENED_SANDBOX_MODE=true
EGRESS_GATEWAY_URL=https://egress.internal
CODEAPI_INTERNAL_SERVICE_TOKEN=<shared-strong-internal-token>

# worker only: source for authorized by-reference input objects. The worker
# pushes bytes into the runner cache; never bake this URL into the runner image.
FILE_SERVER_URL=http://file-server.internal:3000

# checkpoints (S3-compatible, same client as file-server)
CODEAPI_CHECKPOINT_BUCKET=<terraform checkpoint_bucket>
CODEAPI_CHECKPOINT_MAX_BYTES=536870912
MINIO_ENDPOINT=https://s3.us-east-1.amazonaws.com
# MINIO_PORT=443         # optional explicit override; otherwise the URL scheme supplies 443
MINIO_REGION=us-east-1
# ECS task role, EC2 instance profile, and IRSA/web identity are loaded
# automatically. Only non-role/local deployments need a complete static pair:
# MINIO_ACCESS_KEY=...
# MINIO_SECRET_KEY=...

# worker-only signer; do not bake this into the runner image
CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY=<base64 PKCS#8 DER from step 3>
```

Do not set `CODEAPI_EGRESS_GRANT_SECRET` on the API or worker; the hardened
startup checks reject it there. The worker authenticates to the gateway with
`CODEAPI_INTERNAL_SERVICE_TOKEN`, the gateway mints the per-execution grant, and
the runner receives only that short-lived grant plus the signed manifest.
Terraform emits the worker IAM policies but intentionally does not create your
VPC connector, gateway load balancer, or security groups; those must be owned by
the deployment's network stack.

`PTC_MODE` must be `replay` (the default) or unset — see
[Programmatic Tool Calling](#programmatic-tool-calling-ptc).

### 6. Verify

Enable the capability + per-agent toggle in LibreChat and run a two-message
conversation: write `42` to `/mnt/data/answer.txt`, then read it back in a
follow-up message. With the session backend it reads `42`; with the toggle off,
the follow-up sees no file. (The LibreChat PR documents the full acceptance test
and the no-infra wiring smoke.)

---

## Configuration reference

Worker/service names appear in `service/src/config.ts`; runner-image names
appear in `api/src/config.ts`.

### Backend selection

| Env | Default | Meaning |
|---|---|---|
| `CODEAPI_SANDBOX_BACKEND` | `http` | `http` (byte-identical to today) or `lambda-microvm`. |
| `CODEAPI_EXECUTION_PROFILE` | inferred | `default` for the HTTP/stateless deployment or `stateful` for the Lambda affinity/strict deployment. An explicit `stateful` value selects isolated BullMQ queues. Inferred affinity/strict and legacy Lambda/stateless deployments keep the legacy queues only for a pre-profile binary rollout and must not share Redis with the default deployment. |
| `CODEAPI_RUNTIME_SESSION_MODE` | `stateless` | `stateless` \| `affinity` \| `strict`. `affinity` and `strict` require the `lambda-microvm` backend. See [Operating modes](#operating-modes). |
| `CODEAPI_RUNTIME_SESSION_LOCK_WAIT_MS` | `15000` | How long a stateful execution waits for the session lock before returning `RUNTIME_SESSION_BUSY` (HTTP 409). |

### MicroVM launch

| Env | Default | Meaning |
|---|---|---|
| `LAMBDA_MICROVM_IMAGE_ARN` | — (required) | The image created in step 4. |
| `LAMBDA_MICROVM_IMAGE_VERSION` | latest in stateless mode; required in affinity/strict | Exact image version. Stateful startup rejects an unpinned version so a rolling image update cannot silently mix workspace sessions across revisions. |
| `LAMBDA_MICROVM_EXECUTION_ROLE_ARN` | — | Logging-only role. Required (with the log group below) for runtime VM stdout to reach CloudWatch. |
| `LAMBDA_MICROVM_LOG_GROUP` | — | CloudWatch log group sent on `RunMicrovm`. Needed alongside the execution role or stdout goes nowhere. |
| `LAMBDA_MICROVM_REGION` | SDK default | Region for the lambda-microvms client. |
| `LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS` | — | Comma-separated. Inbound HTTPS to the VM. |
| `LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS` | — | Comma-separated. Outbound from the VM. Required in hardened mode. |
| `LAMBDA_MICROVM_PORT` | `8080` | Runner port. |
| `LAMBDA_MICROVM_MAX_DURATION_SECONDS` | `28800` | Hard lifetime ceiling (≤ 8h). |
| `LAMBDA_MICROVM_IDLE_SECONDS` | `1800` | idlePolicy: auto-suspend after this idle. |
| `LAMBDA_MICROVM_SUSPEND_SECONDS` | `1800` | idlePolicy: auto-terminate after this suspended. |
| `LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS` | `300` | Requested AWS proxy-token lifetime. Tokens are minted afresh for each probe, push, checkpoint, restore, or execute request; the multi-probe launch-readiness loop refreshes its token near expiry. |
| `LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS` | `60000` | Budget for RunMicrovm → RUNNING. |
| `LAMBDA_MICROVM_HEALTH_TIMEOUT_MS` | `5000` | Health check budget. |
| `LAMBDA_MICROVM_LAUNCH_TPS` | `4` | Client-side launch throttle (headroom under AWS's 5 TPS cap). Suspend/resume are driven by the configured AWS idle policy, not worker control-plane calls. |
| `LAMBDA_MICROVM_TOKEN_TPS` | `8` | Shared worker throttle for fresh `CreateMicrovmAuthToken` calls. |
| `LAMBDA_MICROVM_ALLOW_SHELL` | `false` | Must stay false in prod (shell auth token → IAM-deny). |

### Hardened egress split

| Env | Placement | Meaning |
|---|---|---|
| `CODEAPI_HARDENED_SANDBOX_MODE=true` | API, worker, gateway, runner image | Enables each process's fail-closed startup checks. Because runner env is immutable, it must be present during image creation. |
| `EGRESS_GATEWAY_URL` | API, worker, runner image | Bare gateway origin (no path/query). Worker creates and restores grants; runner routes file/tool egress through it. |
| `CODEAPI_INTERNAL_SERVICE_TOKEN` | API, worker, gateway, file server, tool-call server; **never runner** | Authenticates internal control/upstream calls. Use one strong secret value across these workloads. |
| `CODEAPI_EGRESS_GRANT_SECRET` | Gateway only | Seals per-execution grants. Hardened API/worker startup rejects this secret. |
| `EGRESS_GATEWAY_FILE_SERVER_URL` / `_TOOL_CALL_SERVER_URL` | Gateway only | Private upstream origins. Do not expose them to the runner. |
| `FILE_SERVER_URL` | Worker only | Direct source used to fetch authorized by-reference inputs before pushing them into the runner cache. Do not bake it into the runner. |
| `CODEAPI_EGRESS_LEDGER_REQUIRED=true` / `REDIS_*` | Gateway | Makes grant replay/revocation state fail closed in Redis. |
| `SANDBOX_ALLOWED_LOCAL_NETWORK_PORT` / `SANDBOX_FORWARD_TARGET` | Runner image | Configures the narrow tool-call socket proxy; it does not start or expose the socket by itself. The target host/port must match `EGRESS_GATEWAY_URL`. |
| `CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY` | Worker only | Signs the manifest after the gateway returns the scoped grant. |
| `SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY` / `SANDBOX_REQUIRE_EGRESS_MANIFEST=true` | Runner image | Verifies and requires the signed per-execution manifest. |

The Unix socket is mounted only for an execution whose body-bound, signed
manifest carries `tool_call_socket=true`; the service's matching request flag is
validated against that scope. Ordinary execution and replay PTC leave the claim
false. This per-execution capability is internal control-plane data, not an
operator environment switch.

### Checkpoints (affinity/strict only)

| Env | Default | Meaning |
|---|---|---|
| `CODEAPI_SESSION_CHECKPOINTS` | `true` | `false` disables checkpoint/restore. Warm reuse still works, but a VM replacement starts clean and only receives the inputs declared by that request. |
| `CODEAPI_CHECKPOINT_BUCKET` | `MINIO_BUCKET` | Checkpoint bucket. |
| `CODEAPI_CHECKPOINT_PREFIX` | `rtsx-checkpoints/` | Key prefix. Immutable objects are `<prefix><runtime_session_id>/<20-digit-sequence>.tar.gz`; a sibling `.committed` marker makes a fenced upload eligible for Redis-loss recovery. |
| `CODEAPI_CHECKPOINT_MAX_BYTES` | `536870912` | Max checkpoint size (512 MiB). |
| `SANDBOX_CHECKPOINT_MAX_BYTES` | `536870912` | Runner-side ceiling for streamed checkpoint restores. Bake it into the MicroVM image and keep it equal to worker `CODEAPI_CHECKPOINT_MAX_BYTES`. |
| `CODEAPI_CHECKPOINT_TIMEOUT_MS` | `60000` | Checkpoint transfer budget. |
| `MINIO_ENDPOINT` / `_PORT` / `_USE_SSL` / `_REGION` | — | S3-compatible endpoint configuration. Absolute URLs use their scheme-default port; `MINIO_PORT` explicitly overrides it. Bare MinIO-style endpoints default to port 9000 and use `_USE_SSL` to select the scheme. Point at real S3 in prod. |
| `MINIO_ACCESS_KEY` / `_SECRET_KEY` / `_SESSION_TOKEN` | workload IAM provider | Optional complete static credential set for local/non-role deployments. ECS, EC2, and web-identity/IRSA credentials are loaded automatically when the pair is absent. |

The worker rejects oversized checkpoint objects before transfer and the runner
independently bounds the streamed restore body. Keep
`CODEAPI_CHECKPOINT_MAX_BYTES` and `SANDBOX_CHECKPOINT_MAX_BYTES` aligned; a
smaller runner limit makes otherwise valid worker checkpoints unrestorable,
while a larger runner limit weakens the receiver-side fail-closed ceiling.

---

## Operating modes

`CODEAPI_RUNTIME_SESSION_MODE` picks the tradeoff:

- **`stateless`** — no registry. One VM per execution: run → execute →
  terminate. MicroVM isolation per call, but no warm sessions and no
  checkpoints. Correct and simple; the safest first AWS step.
- **`affinity`** — find-or-launch one warm VM per `runtime_session_id`. Lock
  contention past `LOCK_WAIT_MS` returns HTTP 409; it never executes cold and
  silently loses session workspace state. Requests without a session hint still
  use the stateless path.
- **`strict`** — same serialized stateful behavior, but requests without a
  session hint are rejected instead of degrading to stateless.

The API records its effective mode on each queued execution so workers do not
reinterpret session semantics from their own environment during a rollout.
When upgrading from a version that predates that queue field, replace and drain
workers before enabling `affinity` or `strict` on API pods. Updated workers can
infer legacy jobs from whether they carry a session id; old workers cannot
honor the new producer-owned marker. Keep API and worker mode configuration
aligned after the rollout.

---

## Alternative AWS methods

You do not have to adopt the whole stack at once. The knobs compose:

**No AWS at all.** Leave `CODEAPI_SANDBOX_BACKEND` unset (`http`). Today's
behavior, no MicroVMs, no changes needed anywhere.

**MicroVM isolation without sessions.** `lambda-microvm` + `stateless`, with
`CODEAPI_EXECUTION_PROFILE` unset for compatibility. Every execution gets a
fresh, strongly-isolated Firecracker VM. No registry, no checkpoints, no
session workspace. This legacy profile uses the shared queue names and must
not share Redis with a separate default deployment.

**Base container image and snapshot boundary.** The default runner uses a stock
`oven/bun` base and is **hookless** — session mode arrives per request via the
`X-Runtime-Session-Id` header, so no lifecycle hooks are needed. Lambda image
creation snapshots running processes, memory, and file descriptors. The
Node-based tool-call proxy is therefore not started by the entrypoint; it starts
and becomes ready lazily only after a post-restore, authenticated execution is
explicitly authorized for the tool-call socket. This keeps Node's embedded
OpenSSL process state out of the image snapshot.

If a future change must run an OpenSSL-using process before the snapshot, use
AWS's snapshot-safe OpenSSL libraries or rebase the
`lambda-microvm-runner` target on the snapshot-compatible Lambda base container
image (`public.ecr.aws/lambda/microvms:al2023-minimal`). That base also contains
the hook-routing components required for build/runtime lifecycle hooks. See
[AWS's snapshot guidance](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html)
and [Runbook gotchas](#runbook-gotchas).

**Checkpoint store.** The checkpoint client is MinIO-compatible. For local dev,
point `MINIO_*` at a local MinIO. For prod, point it at real S3 (endpoint
`https://s3.<region>.amazonaws.com`; its scheme supplies port 443 unless
`MINIO_PORT` explicitly overrides it) and attach
`checkpoint_access_policy_arn` to the workload role. The client loads ECS task
role, EC2 instance-profile, and web-identity/IRSA credentials; a complete static
`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` pair remains available for local or
non-role deployments.

**Egress posture.** For dev, the Lambda-managed `INTERNET_EGRESS` connector gives
default public egress, but do not combine it with a runner that has
`CODEAPI_HARDENED_SANDBOX_MODE=true`. Hardened prod requires the complete split
configuration in steps 4–5: hardened runner image, manifest verifier, matching
local forward target, hardened API/worker, separately deployed gateway with its
grant secret and Redis ledger, shared internal-service token, and a VPC
connector/SG locked to only that gateway. Startup then requires
`LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS`. MicroVMs default to public egress, so
this gate is deliberate.

**Throughput / quota.** `RunMicrovm` is capped account-wide (~5 TPS default), so
stateless cold throughput is ~4 exec/s fleet-wide until you request a quota
raise. Warm sessions (affinity) amortize this away for repeat calls in a
conversation. Treat a fresh account as canary-only.

---

## Programmatic Tool Calling (PTC)

- **Replay PTC works** and is the only supported PTC mode on this backend
  (startup rejects `PTC_MODE=blocking`). Replay externalizes continuation state
  in Redis, so each round is an independent `/exec` that can land on a fresh
  one-shot VM and stay correct.
- **Blocking PTC is rejected** — it needs a live tool-call socket held open
  through the auth proxy mid-execution, which fights the short VM lifecycle.
- **Replay PTC never requests the socket.** Its payload and signed manifest keep
  `tool_call_socket=false`, so the post-restore Node proxy remains stopped.
- **PTC does not yet get warm sessions.** `/exec/programmatic` doesn't derive a
  `runtime_session_id`, so PTC rounds always take the stateless path even when
  the conversation's `execute_code` has a warm VM. Each replay round therefore
  costs a VM launch. Binding PTC into the session VM is a planned follow-up (the
  hint is already on the wire).

---

## Runbook gotchas

Each of these cost a silent or blind failure during bring-up:

- **Build role trust** must include `sts:TagSession` alongside `sts:AssumeRole`,
  and permissions must include log group/stream writes, `s3:GetObject`, and ECR
  pull for a private base — missing any yields a `CREATE_FAILED` build with an
  **empty** `stateReason`. (The Terraform module gets this right.)
- **Build logs** live at `/aws/lambda-microvms/<image-name>` (hyphen), **not** the
  AWS docs' `/aws/lambda/microvms/<name>` (slash) — the docs are wrong; verified
  empirically, the slash path does not exist in a live account. Do not "correct"
  the Terraform log group or IAM policy to the docs' path or you lose the build
  logs.
- **Runtime VM stdout** needs BOTH a `cloudWatch` logging config on RunMicrovm
  AND an `executionRoleArn`, or it goes nowhere. Set
  `LAMBDA_MICROVM_EXECUTION_ROLE_ARN`.
- **nsjail inside the guest** needs `additionalOsCapabilities:["ALL"]` (for the
  `/proc` mount, else EPERM) and `SANDBOX_USE_CGROUPV2=false` (the app container
  can't read the cgroup v2 subtree). Both are baked into the image helper. Under
  ALL caps nsjail runs `no_pivotroot` — weaker in-guest isolation, acceptable
  because the MicroVM is the real trust boundary (one VM per session).
- **NOFILE**: the AL2023 guest hard-caps `RLIMIT_NOFILE` at 1024, below the
  runner's default; the entrypoint raises the hard limit to 65536. Docker masks
  this locally.
- **Hooks never route on a stock container image.** Enabling any runtime hook
  forces the `/ready` build hook, which never reaches a stock container's
  listener, so the build fails at the ready timeout. Stay hookless (the default)
  unless you rebase on the Lambda base container image.
- **Do not start the Node tool-call proxy in the entrypoint.** Lambda image
  creation snapshots live process memory. The runner intentionally starts Node
  only after restore and only for a body-bound, manifest-authorized
  `tool_call_socket` execution, avoiding cloned OpenSSL process state. Audit any
  new pre-snapshot OpenSSL consumer against AWS's snapshot guidance or use the
  snapshot-safe base/libraries.

---

## Rolling out a new runner image

Image updates create a new immutable version. Build and upload a unique
`IMAGE_TAG`, call the helper with `--update`, then deploy both values it prints:

```bash
cd service
AWS_PROFILE=... bun scripts/create-microvm-image.ts \
  --update \
  --name codeapi-session \
  --artifact s3://<artifact-bucket>/runner/runner-<new-tag>.zip \
  --build-role <build-role-arn> \
  --region "$AWS_REGION" \
  --env-json '<same verified runner environment>'
```

This release has a pre-release checkpoint compatibility boundary: the
runner-owned sidecar is now `codeapi.session-meta.v2`, which stores stable
input-cache digests instead of the v1 masked object handles. Before deploying
this branch to AIML-dev, drain and terminate every v1 warm session, then discard
or recycle its checkpoints and registry records. Do not run old and new runner
image versions concurrently; a rolling mixed-image deployment is unsupported
across this boundary.

For later schema-compatible rollouts, update
`LAMBDA_MICROVM_IMAGE_VERSION` before replacing workers. The registry's launch
fingerprint includes the resolved image version and launch/security settings,
so a worker will not reuse a warm VM created under an older configuration.
Retain the prior image version until its MicroVMs have drained or been
terminated.

---

## Teardown

```bash
# Terminate only VMs launched from THIS image, then delete the image.
# The server-side image filter and AWS CLI auto-pagination keep this scoped in a
# shared account.
export AWS_PROFILE=...
export AWS_REGION=us-east-1
export IMAGE_ARN="arn:aws:lambda:us-east-1:<acct>:microvm-image:codeapi-session"

for microvm_id in $(aws lambda-microvms list-microvms \
  --image-identifier "$IMAGE_ARN" \
  --region "$AWS_REGION" \
  --query "items[?state!='TERMINATED' && state!='TERMINATING'].microvmId" \
  --output text); do
  aws lambda-microvms terminate-microvm \
    --microvm-identifier "$microvm_id" \
    --region "$AWS_REGION"
done

# Wait at most 10 minutes. JSON output applies the JMESPath query once to the
# complete auto-paginated response; text output would return one count per page.
attempt=0
while :; do
  remaining=$(aws lambda-microvms list-microvms \
    --image-identifier "$IMAGE_ARN" \
    --region "$AWS_REGION" \
    --query "length(items[?state!='TERMINATED'])" \
    --output json)
  [ "$remaining" = "0" ] && break
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "Timed out waiting for $remaining MicroVM(s) to terminate" >&2
    exit 1
  fi
  sleep 5
done

aws lambda-microvms delete-microvm-image \
  --image-identifier "$IMAGE_ARN" \
  --region "$AWS_REGION"

# then the prerequisites
terraform -chdir=docs/lambda-microvm/terraform destroy
```

MicroVM images are billed as stored snapshots; running VMs bill while RUNNING and
suspended VMs bill at a reduced rate, so terminate stray VMs before deleting the
image.
