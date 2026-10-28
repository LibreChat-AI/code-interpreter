# Target-Lane Worktree Lifecycle Admission

Status: proposed. No scheduling or sandbox policy changes are enabled by this PR.

## Failure

A shell call to `git worktree add` currently uses the checkout isolation key.
`BridgeWorkspaceSlots.reserve` waits for every child lane; the worker's lane
family guard and native sandbox enforce the same exclusion. Repeated short
admission timeouts discard a waiting checkout request before lanes drain.
The reviewer in chat e2fedf18 (LibreChat PR #16722) could not create its lane.
Durable admission preserves FIFO, but does not remove the checkout-wide barrier.

## Decision

Add explicit `create_worktree` and `remove_worktree` workspace operations.
Never infer a weaker scope by parsing an arbitrary shell command.
Each lifecycle request reserves the target lane's ordinary isolation key,
including checkout exclusion and existing quarantine fencing. Sibling lanes
remain independent. Advertise support only when the service and worker agree.
Old clients keep using checkout-wide shell calls.

Git metadata mutation gets a separate worker-owned mutex, scoped to the common
Git directory and held only while changing a worktree registration. The target
reservation covers the whole operation. It is not the metadata mutex.

```text
create(name, frozenCommit)
  target-lane reservation
  validate root identity, target absence, commit and branch policy
  metadata mutex → git worktree add --no-checkout --detach → unlock
  target lane → git checkout frozenCommit → verify pointers and root identity
  publish ready result, then release reservation

remove(name)
  target-lane reservation, require no mutation quarantine
  verify pointers and identity, clean tracked/untracked state, no nested mounts
  metadata mutex → rename lane to private tombstone
    → git worktree remove original-path (now absent) → unlock
  delete tombstone outside mutex; keep branch and reachable objects
  persist outcome, then release reservation
```

A lifecycle journal outside untrusted roots records `reserved`, `registered`,
`ready`, `retiring`, `detached` and `removed`, with assignment owner and captured
identities. Worker recovery reconciles journal entries, never reruns uncertain
shell commands. Creation is not published until checkout completes. Failed
checkout retains the target fence until reconciled. Rename-before-detach must
roll back only while registration still points to the captured original target;
otherwise preserve the tombstone and require reconciliation. Never remove dirty
worktrees, force-remove, prune all registrations, or delete branches as recovery.

## Boundaries

- `service/src/bridge/slots.ts`: reserve the named target, not a new global slot
  limit. A waiting root still prevents newer sibling admissions. A metadata
  operation consumes an existing worker slot; fully occupied workers still wait.
- `packages/code/src/worker.ts`: treat lifecycle operations as mutations and
  derive target-lane guards before execution. Keep assignment/identity fencing.
- `packages/code/src/linked-worktrees.ts`: target ownership includes absent
  lanes during creation and excludes local retirement of that lane.
- `packages/code/src/linked-worktree-git-guard.ts`: ordinary lanes reject
  registration-changing `git worktree` commands. Do not grant write access to
  `.git/worktrees` or sibling checkouts to make shell operations work.
- Native sandbox: bulk checkout runs only in the target's admitted directory.
  Run no repo hooks or credential helpers in the trusted metadata phase.

## Alternatives

1. Longer checkout waits: smallest fix and required for old servers, but still
   drains all lanes and serializes bulk checkout/deletion.
2. Allow `git worktree` from arbitrary lane shells: rejected. A shell can remove
   a busy sibling or repair foreign metadata; mutexing Git does not confine it.
3. Explicit lifecycle operations: recommended. More protocol/recovery surface,
   but target ownership and metadata lifetime are independently testable.

## Compatibility and rollout

Deploy the worker journal/guard first, then service capability and matching
client tools. Never send target-scoped lifecycle work to an older worker.
Disable new submissions and drain lifecycle journals before rollback. Root
shell operations and destructive object maintenance remain checkout-exclusive.
Concurrent Git object/ref access still uses Git's own atomic locks; automatic
maintenance stays disabled in lanes.

A read-only GitHub compare tool supplies merge-base and ancestry for public
repos without any worker call. This helps review orient while admission is busy,
but does not substitute for reading the frozen source or running tests.

## Blocking verification

- A long sibling lane remains running while another target is created/removed.
- Same-target/root exclusion and older-root FIFO barriers in Redis and worker.
- Short mutex lifetime verified while bulk checkout/deletion is deliberately gated.
- Cancellation/restart at each journal transition and lost acknowledgements.
- Dirty/untracked, symlink substitution, nested mount, quarantine and foreign-root denial.
- Lane Git guard rejects add/remove/move/repair/prune, including global options.
- Old/new service, worker and client combinations fail closed.

`tests/worktree-metadata-phases.mjs` probes the local Git mechanism only. It does
not prove service scheduling, worker recovery, or live sandbox containment.
