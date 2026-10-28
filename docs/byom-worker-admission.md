# BYOM worker admission

Workspace tool calls to a busy worker wait in a bounded FIFO shared through Redis.
The limit is 32 admitted requests per worker, including the active request. When
the limit is reached, the workspace endpoint returns HTTP 429 with
`WORKER_QUEUE_FULL`. A different worker has an independent admission queue.

The Code API workspace HTTP endpoint allows 30 seconds for admission when the
request has no `X-LibreChat-Workspace-Queue-Wait-Ms` header. A caller can
advertise a positive integer allowance in milliseconds through that header,
up to five minutes and any configured server queue ceiling. An invalid or
out-of-range value is rejected before dispatch. This queue budget is
independent of `JOB_TIMEOUT`; a shorter client or proxy deadline still ends
the wait. After admission
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

Clients and reverse proxies must allow the admitted queue budget plus
execution/settlement time and five seconds for HTTP delivery. With the default
five-minute `JOB_TIMEOUT` and no queue header, that is at least 65 seconds for
non-command tools, 70 seconds for default commands, and 340 seconds for
five-minute commands. At the maximum advertised five-minute queue allowance,
those totals become 335, 340, and 610 seconds respectively. With a smaller
`JOB_TIMEOUT`, use the advertised allowance (or 30 seconds without a header),
bounded by the server queue ceiling, plus `min(JOB_TIMEOUT, 30s)` for other
operations or `min(JOB_TIMEOUT, requested command timeout) + 5s` for commands,
plus five seconds for delivery. The caller should advertise only the queue time
left after reserving execution, settlement, and delivery under its own HTTP
deadline; Code API does not receive that absolute deadline.

LibreChat's `maxQueueWaitMs` is a retry horizon after a typed capacity
rejection, **not** a per-attempt HTTP timeout. Without its opt-in
`maxRequestTimeoutMs`, LibreChat keeps a 30-second admission allowance per
attempt. Enabling a longer client budget requires LibreChat's header support on
every API replica and a timed canary through each intermediary; changing Code
API alone does not guarantee the full wait. An earlier client, tool, or proxy
timeout disconnects the request; if work was already admitted, a mutation may
have run and must not be blindly retried. Existing workers do not need an update.

Focused regression coverage lives in `service/src/bridge/admission.test.ts`,
`service/src/bridge/worker-admission.test.ts`,
`service/src/bridge/concurrent-store.test.ts`, and
`service/src/workspace-tools/router.test.ts`.
