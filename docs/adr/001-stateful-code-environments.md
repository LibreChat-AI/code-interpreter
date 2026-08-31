# ADR 001: Stateful code environments use an outbound Code API bridge

- Status: Accepted for alpha
- Date: 2026-08-30

## Context

LibreChat needs coding agents to reuse a workspace across conversation turns
while allowing the environment owner to choose the VM. Internet-facing
LibreChat instances cannot safely require inbound access to that VM, forward
end-user tokens to it, or treat an MCP connection as a sandbox boundary.

The first alpha demonstrated a stable runtime-session ID, a single fenced
worker lease, and workspace persistence across turns. Its static shared worker
token was sufficient to prove execution flow but is not an acceptable hardened
enrollment mechanism.

## Decision

The product concept is a **stateful code environment**. Code API remains its
broker and policy boundary, and `remote-bridge` is a Code API sandbox backend.
The `@librechat/code` worker connects outbound from the chosen VM and forwards
assignments only to a loopback or private sandbox endpoint.

Hardened workers enroll through a one-time pairing code:

1. An administrator creates a code scoped to the configured worker ID.
2. The CLI generates an Ed25519 keypair locally and redeems the code with only
   its public key.
3. Code API returns a fifteen-minute credential bound to that public key.
4. Every worker request signs the method, path, body digest, timestamp, nonce,
   and credential.
5. Code API rejects stale timestamps and replayed nonces and supports rotation
   and immediate revocation.

Static bearer authentication remains a non-hardened compatibility mode.

## Ownership and state

The alpha environment is deployment/operator owned and configured with one
worker ID. A future LibreChat control plane may persist deployment-, tenant-,
or user-owned environment records and issue the same pairing operation through
RBAC-protected APIs without changing the worker execution protocol.

Workspace state belongs to the stable runtime session, not to a transient
assignment lease. For `remote-bridge`, that state currently survives turns on
the same worker and backing disk. It is not yet checkpointed or portable across
worker replacement; the UI and operator documentation must not imply otherwise.

## Security invariants

- The VM requires no inbound internet listener.
- Code API, not the worker, authenticates LibreChat users and normalizes work.
- A stolen short-lived credential is insufficient without the worker private
  key; a stolen private key is insufficient after credential expiry or
  revocation.
- Pairing codes and credentials are stored by digest where lookup permits.
- One configured worker has at most one active fenced assignment.
- Sandbox isolation and default-deny egress remain mandatory; pairing secures
  the transport identity but does not make the host a sandbox.
- A compromised worker can lie about advertised capabilities. Capability
  labels and policy digests are audit signals until enforcement is coupled to
  an attested sandbox or trusted host policy.

## Consequences

- `@librechat/code` owns the provider-neutral protocol, identity handling, and
  worker CLI; Code API owns enrollment, scheduling, and execution policy.
- LibreChat owns environment persistence, ownership, RBAC, and user experience.
- The Agents SDK keeps only its adapter until a second concrete consumer proves
  which coding-tool abstractions are genuinely provider neutral.
- MCP may expose environment operations later, but it is not the worker
  transport or isolation boundary.
- Multi-worker directories, checkpoint/restore, owner-scoped quotas, and
  enforced network capability profiles remain follow-up decisions.

## Alternatives rejected

- **Inbound SSH/HTTP to the VM:** expands attack surface and complicates NAT and
  firewall operation.
- **MCP as the worker protocol:** conflates tool discovery with leases,
  cancellation, fencing, and sandbox policy.
- **Put the runtime in the Agents SDK:** couples provider-neutral execution to
  one agent integration and makes non-agent consumers depend on agent internals.
- **Long-lived shared bearer token:** easy to bootstrap, but replayable and not
  bound to a worker-held key.
