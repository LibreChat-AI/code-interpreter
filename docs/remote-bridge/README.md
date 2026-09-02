# Remote Code Bridge

Remote Code Bridge makes an operator-owned VM a stateful Code API execution
environment without exposing that VM to inbound internet traffic.

```text
LibreChat -> Code API -> Redis assignment
                         ^             |
                         | outbound    v
                    @librechat/code -> local sandbox
```

Code API remains the public authentication, policy, manifest, timeout, and
result-normalization boundary. The bridge worker has a separate operator
identity and never accepts end-user bearer tokens directly.

## Code API configuration

Run this as an isolated stateful Code API deployment:

```dotenv
CODEAPI_SANDBOX_BACKEND=remote-bridge
CODEAPI_EXECUTION_PROFILE=stateful
CODEAPI_RUNTIME_SESSION_MODE=affinity
CODEAPI_BRIDGE_WORKER_ID=my-vm
CODEAPI_BRIDGE_TOKEN=<strong-administrator-bootstrap-secret>
CODEAPI_BRIDGE_AUTH_MODE=paired
```

Use `strict` instead of `affinity` if every request must include a runtime
session hint. In hardened mode, startup requires the bridge token to be at least
32 bytes. `PTC_MODE=blocking` is rejected; replay mode is required because a
remote execution cannot retain an open Code API process across tool callbacks.

To attach multiple principal-owned workers to one Code API deployment, enable
dynamic routing. A compatibility default worker is optional in this mode:

```dotenv
CODEAPI_BRIDGE_DYNAMIC_WORKERS=true
CODEAPI_BRIDGE_AUTH_MODE=paired
# CODEAPI_BRIDGE_WORKER_ID=my-default-vm
```

Dynamic routing is accepted only with paired authentication. LibreChat signs
the selected worker into the short-lived Code API JWT as `code_worker_id`.
`X-LibreChat-Code-Worker-ID` remains the transport header, but Code API accepts
it only when it exactly matches that authenticated claim. The resolved worker
is persisted across the queue and programmatic replay boundaries, and Code API
requires both its stored tenant binding and registered worker credential before
creating a lease.

Create a single-use pairing code with the administrator secret:

```bash
curl -fsS https://code.example.com/v1/bridge/pairings \
  -H "Authorization: Bearer $CODEAPI_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"workerId":"my-vm"}'
```

With dynamic routing enabled, the trusted control plane must bind each pairing
to one tenant and generic principal. Code API treats the principal as lifecycle
and audit metadata; LibreChat remains responsible for resolving user, role, and
group membership before selecting the worker:

```bash
curl -fsS https://code.example.com/v1/bridge/pairings \
  -H "Authorization: Bearer $CODEAPI_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "workerId":"user-vm",
    "binding":{
      "tenantId":"tenant-1",
      "principal":{"type":"user","id":"user-1"}
    }
  }'
```

Principal types are `deployment`, `tenant`, `user`, `role`, and `group`.
Pairing and registration bodies from the VM cannot replace the server-issued
binding, and credential rotation preserves it.

Redeem the returned code on the VM using
[`@librechat/code`](../../packages/code/README.md). The CLI generates its key
locally, proves possession on every request, and rotates its short-lived
credential before expiry. `CODEAPI_BRIDGE_AUTH_MODE=static` remains available
for non-hardened development compatibility only.

To expose an existing checkout as a worker-local workspace, start the CLI with
an explicit directory and logical ID:

```bash
librechat-code run \
  --worker-dir /srv/checkouts/librechat \
  --workspace-id primary \
  --workspace-name LibreChat
```

The worker advertises only the workspace ID, optional display name, and
supported operations. Its host path is never registered with Code API. An
authenticated caller can execute the initial read-only operations through:

```bash
curl -fsS https://code.example.com/v1/workspace-tools/execute \
  -H "Authorization: Bearer $LIBRECHAT_JWT" \
  -H 'Content-Type: application/json' \
  --data '{
    "protocolVersion":1,
    "operation":"read_file",
    "workspaceId":"primary",
    "path":"README.md",
    "startLine":1,
    "maxLines":200
  }'
```

The endpoint uses the same authenticated principal-bound worker selection,
tenant fence, lease deadline, cancellation, and settlement lifecycle as remote
sandbox execution. Requests must name a workspace and operation advertised by
that worker. Results are validated against the originating request before they
leave Code API, and are bounded to 1 MiB/500 lines for reads or 200 matches for
searches. Absolute paths, traversal, backslashes, symlink escapes, unexpected
fields, and host roots are rejected.

The workspace root can be an existing project, a Git repository, or an empty
directory; Git is not required. This boundary keeps that directory local to the
operator's machine, but the selected file contents, search matches, and later
tool results necessarily cross the outbound bridge to Code API and the model.
Treat them as explicit tool outputs, apply the same retention and audit policy
as chat content, and do not register a directory containing secrets. The
default operations are read-only; future mutation and shell operations must be
gated by LibreChat's tool-approval hooks in addition to worker capability
checks.

Stateful deployments must also set `LIBRECHAT_CODE_STATEFUL_WORKSPACE=true`
and route the CLI's `{runtimeSessionId}` endpoint template to an isolated,
persistent local runner per session. A single sandbox endpoint is stateless and
is rejected for runtime-session assignments.

## LibreChat configuration

Expose the Code API deployment as an environment under the Agents endpoint:

```yaml
endpoints:
    agents:
        statefulCodeSessions:
            environments:
                - id: my-vm
                  name: My VM
                  type: attached
                  baseURL: https://code.example.com/v1
                  default: true
```

Agents may select this environment with `code_environment_id: my-vm`.
LibreChat derives a stable per-conversation runtime session ID, so commands in
later turns reuse the same workspace. Attached environments deliberately skip
background prewarming: the single worker lease is reserved for explicit user
execution.

## Lifecycle and fencing

- Registration is ephemeral in Redis and must be refreshed by the worker.
- Pairing codes are stored hashed, expire after ten minutes, and are consumed
  atomically on their first redemption attempt.
- Worker credentials expire after fifteen minutes and are bound to an Ed25519
  public key. Exact-request signatures include the HTTP method, path, body
  digest, timestamp, nonce, and credential.
- Accepted proof nonces cannot be replayed, credentials rotate before expiry,
  and an administrator can revoke the active worker identity immediately.
- Assignment leases bind to a stable paired identity rather than an individual
  short-lived credential. Rotation preserves that identity; pairing again
  replaces it and fences work queued for the previous owner.
- Remote bridge deployments use backend-specific BullMQ queues and serialize
  the expected backend on every new job, preventing Lambda or HTTP consumers
  from accepting attached-worker executions.
- Code API permits one active assignment per worker.
- Dynamic workers are fenced to their server-issued tenant before assignment.
- Each assignment has an absolute deadline, generation, and random lease token.
- Settlements with the wrong worker, generation, token, or expired deadline are
  rejected.
- Assignments are queued for the exact registered worker incarnation, so an
  outstanding poll from a replaced process cannot consume replacement work.
- Assignment records and the worker lock live through the full configured job
  deadline plus cleanup grace.
- Ambiguous settlement delivery is retried through the assignment deadline. If
  a stateful settlement remains ambiguous, the CLI exits and the affected local
  session runner must be reset or discarded before restart.
- Enqueueing stateful work atomically creates a durable in-flight workspace
  marker. A definite rejection or successful result finalization clears it;
  worker or VM loss leaves it in place so later reuse fails closed. Settlement
  receipts outlive assignment cleanup briefly so retries are idempotent and
  cannot recreate a cleared marker.
- To recover a fenced session, stop the normal worker process and discard/reset
  that session's local sandbox workspace. While it remains stopped, run
  `librechat-code reset-workspace <runtime-session-id>` with the same worker
  configuration; the command temporarily registers its own incarnation and
  exits. Start the normal worker only after the reset command succeeds. Code API
  refuses the acknowledgement while work is active or when it is not made by
  the currently registered incarnation.
- Request cancellation is polled by the worker and aborts the local sandbox
  request.
- A leased assignment remains in a Redis-backed delivery claim until the worker
  explicitly acknowledges it; reconnecting before acknowledgement redelivers
  the same fenced assignment instead of losing it after an HTTP disconnect.
- The sandbox receives the stable runtime session ID separately from the lease;
  workspace state belongs to that session, not to a transient assignment.

## Security boundaries

The bridge removes inbound VM exposure; it does not replace sandbox isolation.
For internet-facing LibreChat deployments, use the hardened microVM/NsJail
stack, default-deny sandbox egress, signed execution manifests, least-privilege
host credentials, resource limits, and host/network monitoring. Bind the local
sandbox endpoint to loopback or a private container network. Rotate a leaked
administrator token immediately. Pairing secures worker transport identity; it
cannot attest that a compromised VM truthfully reports or enforces its sandbox
capabilities.

LibreChat's owner-scoped environment registry can issue these principal-bound
pairings without changing the worker execution protocol or moving code tools
into the Agents SDK.
