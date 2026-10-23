# 0014: Import chat uploads into attached workspaces

Status: Accepted

## Context

A LibreChat chat can run on a personal machine through the remote bridge. Files
the user uploads in that chat stay in Code API storage: only programmatic Bash
stages them, per run, in a private scratch directory. `write_file` accepts
1 MiB of UTF-8 text, so binaries such as archives, images, and PDFs cannot reach
the workspace at all.

## Decision

Add one additive workspace operation, `import_file`, under protocol version 1.

- **Request.** `{ path, source: { storage_session_id, id }, bytes, sha256,
  overwrite? }` plus the usual workspace selectors. `sha256` is lowercase hex.
- **Ownership.** Code API, not the caller, decides whether `source` may be read.
  It applies the `GET /download/:session_id/:fileId` rule for a user-kind
  object: the live `session:<id>` key must name the caller's storage key, and an
  upload record must exist for that key, session, and object.
- **Grant.** Code API asks the egress gateway for a grant whose only input is
  that object, with no upload capacity, two reads, and an expiry of the
  request's admission plus execution budget plus 30 seconds. The relayed
  request carries the grant and opaque handles in place of the raw ids. A
  caller-supplied `egressGrant` is rejected. Synchronous requests revoke the
  grant when they finish; durable requests let it expire.
- **Worker.** The worker streams the object from
  `LIBRECHAT_CODE_FILE_RELAY_UPSTREAM`, the route programmatic inputs already
  use, and holds no storage credential. It applies `write_file`'s path rules,
  refuses `.git` segments and their filesystem aliases, refuses symlinked
  parents, creates missing parents as 0755, enforces `bytes` while streaming
  into a same-directory temporary file, verifies size and SHA-256, syncs, and
  installs the file atomically with mode 0644. The size and hash are checked on
  the synced temporary file itself. A create links exclusively; an overwrite
  rechecks the inspected inode immediately before its rename, as `write_file`
  does.
- **Idempotency.** Identical existing bytes return `unchanged: true` and
  `bytesWritten: 0` without a transfer. Different bytes return `EDIT_CONFLICT`
  unless `overwrite: true`.
- **Limits.** Code API (`CODEAPI_BRIDGE_IMPORT_FILE_MAX_BYTES`) and the worker
  (`LIBRECHAT_CODE_IMPORT_FILE_MAX_BYTES`) each enforce a per-file ceiling,
  100 MiB by default, as `WRITE_LIMIT_EXCEEDED`. The worker also requires the
  file plus 64 MiB to fit in the target filesystem's free space.
- **Policy.** `import_file` is a file write. It shares the mutation guard with
  `write_file`, is never advertised for a read-only root, and a read-only root
  refuses it with `WRITE_DISABLED`.
- **Negotiation.** Code API lists `import_file` in
  `supportedWorkspaceToolOperations` only when `EGRESS_GATEWAY_URL` is set. A
  worker advertises it by default whenever writes are enabled, a relay
  upstream is configured, and the Code API listed it; operators opt out with
  `--no-workspace-imports` or `LIBRECHAT_CODE_ALLOW_WORKSPACE_IMPORTS=false`.
  LibreChat sends it only when advertised. LibreChat releases that predate
  LibreChat-AI/LibreChat#17376 reject a worker status listing an unknown
  operation, so LibreChat is updated first and the opt-out is the escape
  hatch for workers serving an older one.

## Consequences

Uploads land in the workspace without a model round trip, and older Code APIs,
workers, and LibreChat releases keep their current behavior. Deployments
without an egress gateway do not offer the operation. Parent directories are
created only beneath a descriptor-held root, as for `write_file`; a legacy
pathname-only root reports a missing parent instead.
