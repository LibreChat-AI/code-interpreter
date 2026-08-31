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

Create a single-use pairing code with the administrator secret:

```bash
curl -fsS https://code.example.com/v1/bridge/pairings \
  -H "Authorization: Bearer $CODEAPI_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"workerId":"my-vm"}'
```

Redeem the returned code on the VM using
[`@librechat/code`](../../packages/code/README.md). The CLI generates its key
locally, proves possession on every request, and rotates its short-lived
credential before expiry. `CODEAPI_BRIDGE_AUTH_MODE=static` remains available
for non-hardened development compatibility only.

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
- Code API permits one active assignment per configured worker.
- Each assignment has an absolute deadline, generation, and random lease token.
- Settlements with the wrong worker, generation, token, or expired deadline are
  rejected.
- Request cancellation is polled by the worker and aborts the local sandbox
  request.
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

The next control-plane layer can add owner-scoped environment records and a
multi-worker directory without changing the execution protocol or moving code
tools into the Agents SDK.
