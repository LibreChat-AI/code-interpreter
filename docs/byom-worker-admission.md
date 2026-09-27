# BYOM worker admission

Workspace tool calls to a busy worker wait in a bounded FIFO shared through Redis.
The limit is 32 admitted requests per worker, including the active request. When
the limit is reached, the workspace endpoint returns HTTP 429 with
`WORKER_QUEUE_FULL`. A different worker has an independent admission queue.

The Code API workspace HTTP endpoint allows up to the smaller of `JOB_TIMEOUT`
and five minutes for admission while the caller stays connected. After admission
and worker validation, a separate execution deadline starts. Commands receive
their requested timeout (30 seconds by default, up to five minutes), capped by
the operator's `JOB_TIMEOUT`, plus five seconds to settle the result. Other
operations receive up to 30 seconds, also capped by `JOB_TIMEOUT`.
Disconnecting or cancelling removes a waiting request without cancelling the
active assignment. Expired entries are pruned; Redis key expiry also bounds
state left by a crashed API process. Reservations derive their TTL at acquisition
from the remaining absolute deadline or a fresh execution budget; enqueued
assignment records use the final execution deadline, not the elapsed queue budget.

After admission, the API revalidates the worker incarnation, identity, tenant
binding and workspace operation. A waiting request cannot migrate to a replacement
worker. Existing execution acknowledgement, fencing, settlement and quarantine
rules remain responsible for the active assignment.

This is compatible with existing workers: assignments retain the same absolute
deadline and server-relative timing fields. Store callers that omit the new
internal `executionTimeoutMs` argument retain their existing absolute-deadline behavior.
Existing workers still execute one assignment at a time. Parallel execution across
workspaces requires separate lease claims and isolated native sandbox contexts;
this admission change does not advertise that capability.

Clients and reverse proxies must allow queue time plus execution/settlement time
and five seconds for HTTP delivery. With the default five-minute `JOB_TIMEOUT`,
that is at least 335 seconds for non-command tools, 340 seconds for default
commands, and 610 seconds for five-minute commands. With a smaller `JOB_TIMEOUT`,
use `min(JOB_TIMEOUT, 300s)` for the queue, plus `min(JOB_TIMEOUT, 30s)` for other
operations or `min(JOB_TIMEOUT, requested command timeout) + 5s` for commands,
plus five seconds for delivery.

At the time of this change, LibreChat's `getWorkspaceToolTimeoutMs` still budgets
only 30 seconds for a single admission attempt (65/70/340 seconds in total).
Its `maxQueueWaitMs` is a retry horizon after a typed capacity rejection, **not**
a per-attempt HTTP timeout. Updating Code API alone therefore does not guarantee
the full wait. An earlier client, tool, or proxy timeout disconnects the request;
if work was already admitted, a mutation may have run and must not be blindly
retried. Match LibreChat's per-attempt timeout and each intermediary to the new
budget before relying on it. Existing workers do not need an update.

Focused regression coverage lives in `service/src/bridge/admission.test.ts`,
`service/src/bridge/worker-admission.test.ts`,
`service/src/bridge/concurrent-store.test.ts`, and
`service/src/workspace-tools/router.test.ts`.
