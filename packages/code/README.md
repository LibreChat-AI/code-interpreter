# `@librechat/code`

Provider-neutral protocol and worker CLI for attaching a stateful, sandboxed
code environment to LibreChat Code API.

The CLI is a transport bridge, not a sandbox. Run it beside a Code Interpreter
sandbox (NsJail for trusted local development, or the hardened microVM stack for
untrusted internet traffic). It connects outbound to Code API, long-polls for
assignments, forwards them to the local sandbox, and returns fenced results.
The VM does not need an inbound public port.

## Run

```bash
npm install -g @librechat/code

LIBRECHAT_CODE_URL=https://code.example.com/v1 \
LIBRECHAT_CODE_WORKER_TOKEN='<strong random secret>' \
LIBRECHAT_CODE_WORKER_ID=my-vm \
LIBRECHAT_CODE_SANDBOX_ENDPOINT=http://127.0.0.1:2000/api/v2 \
librechat-code
```

Optional environment variables:

- `LIBRECHAT_CODE_SANDBOX_PROFILE`: capability label; defaults to `nsjail`.
- `LIBRECHAT_CODE_RUNTIMES`: comma-separated capability labels.
- `LIBRECHAT_CODE_POLICY`: local policy description hashed into the worker's
  registration; defaults to `default-deny`.
- `LIBRECHAT_CODE_STATEFUL_WORKSPACE`: defaults to `false`. Set it to `true`
  only when the local sandbox supervisor provides a distinct persistent runner
  for every runtime session. In that mode the endpoint must contain a
  `{runtimeSessionId}` placeholder, for example
  `http://127.0.0.1:2000/sessions/{runtimeSessionId}/api/v2`. The worker URL-
  encodes and substitutes the assigned session ID before execution. Hintless
  assignments use an ephemeral `assignment-<id>` session so affinity-mode
  stateless work never reaches a literal placeholder route.

A single built-in sandbox runner binds itself to one runtime session and must
not be advertised as stateful. Use the default stateless capability until a
session-routing supervisor is configured.

The worker retries result settlement through the assignment deadline. If a
stateful result remains ambiguous, it exits with a quarantine error instead of
accepting another assignment. Reset or discard that session's local runner
before restarting the worker; its workspace may contain mutations that Code
API did not commit.

After discarding or resetting that session's local runner, acknowledge recovery
with `librechat-code reset-workspace <runtime-session-id>`. The command uses the
configured worker credentials, registers a fresh incarnation, and only clears
the server fence when no assignment is active. Run it while the normal worker
process is stopped, then restart the normal worker after the command exits.

Use a unique worker ID and secret per Code API deployment, expose only the
sandbox loopback endpoint to the CLI, and enforce VM/container egress policy
independently of the bridge transport.
