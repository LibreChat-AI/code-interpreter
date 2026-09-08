# BYOM worker admission

Workspace tool calls to a busy worker wait in a bounded FIFO shared through Redis.
The limit is 32 admitted requests per worker, including the active request. When
the limit is reached, the workspace endpoint returns HTTP 429 with
`WORKER_QUEUE_FULL`. A different worker has an independent admission queue.

Waiting uses the caller's existing absolute dispatch deadline. It does not reset
or extend execution timeouts. Disconnecting or cancelling removes the waiting
request without cancelling the active assignment. Expired entries are pruned;
Redis key expiry also bounds state left by a crashed API process.

After admission, the API revalidates the worker incarnation, identity, tenant
binding and workspace operation. A waiting request cannot migrate to a replacement
worker. Existing execution acknowledgement, fencing, settlement and quarantine
rules remain responsible for the active assignment.

This is compatible with existing workers and requires only a Code API update.
Existing workers still execute one assignment at a time. Parallel execution across
workspaces requires separate lease claims and isolated native sandbox contexts;
this admission change does not advertise that capability. Queue time and execution
time currently share the HTTP request deadline. Separate budgets require a matching
LibreChat client change so that the client does not disconnect while waiting.

Focused regression coverage lives in `service/src/bridge/admission.test.ts` and
`service/src/bridge/worker-admission.test.ts`.
