# MCP inputs during programmatic execution

Replay `/v1/exec/programmatic` responses advertise `continuation_files: 1` while
waiting for tool results. A result can add `files` using the existing owned input
reference schema. Bytes remain in file storage and never enter replay JSON.
Each reference is associated with an issued `call_id`.

Under the execution lock, the API validates result shape, execution ownership,
upload ownership, filename conflicts, and aggregate count. The additive inputs
are committed with immutable history before replay; the next sandbox iteration
mounts them before resuming user code. Identical retries are accepted. Existing
upload and input-manifest limits continue to apply.

Blocking mode does not advertise support and rejects continuation files with
`ptc_continuation_files_unsupported`. Hosts must check capability before promising
same-script availability. Existing clients retain current behavior.

Local verification uses synthetic inputs and direct NsJail on Docker Desktop;
it does not establish MicroVM, OBO, or remote-bridge compatibility.
