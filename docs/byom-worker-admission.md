# BYOM worker admission

Workspace tool calls to a busy worker wait in a bounded FIFO shared through Redis.
The limit is 32 admitted requests per worker, including the active request. When
the limit is reached, the workspace endpoint returns HTTP 429 with
`WORKER_QUEUE_FULL`. A different worker has an independent admission queue.

The workspace HTTP endpoint allows at most 30 seconds for admission. After
admission and worker validation, a separate execution deadline starts. Commands
receive their requested timeout (30 seconds by default, up to five minutes),
capped by the operator's `JOB_TIMEOUT`, plus five seconds to settle the result.
Read/search/list operations receive up to 30 seconds, also capped by `JOB_TIMEOUT`.
Disconnecting or cancelling removes the waiting
request without cancelling the active assignment. Expired entries are pruned;
Redis key expiry also bounds state left by a crashed API process.

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

LibreChat must allow queue time plus execution/settlement time and five seconds
for HTTP delivery: 65 seconds for reads, 70 seconds for default commands, and
340 seconds for five-minute commands. Either side can be upgraded first. Older
clients still cancel at their earlier deadline; newer clients preserve errors from
older servers without retrying mutations. Both updates are needed for the full
waiting budget. Any reverse proxy request timeout must accommodate these totals.
The worker package does not need an update for the deadline change.

Focused regression coverage lives in `service/src/bridge/admission.test.ts` and
`service/src/bridge/worker-admission.test.ts`.
