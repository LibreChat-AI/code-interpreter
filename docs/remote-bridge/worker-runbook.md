# Self-hosted worker runbook

This runbook attaches an operator-controlled laptop or VM to a LibreChat Code
API deployment. The worker makes an outbound HTTPS connection; it does not
open an inbound port. The same procedure works for one machine or many
principal-bound machines.

The guide uses a named environment and the native Sandbox Runtime (SRT). It
covers a restricted personal-machine deployment and the `trusted-vm` preset,
where a separate VM boundary is responsible for most host isolation.

## 1. Understand the boundaries

Four independently managed components participate:

1. LibreChat stores the environment record, resolves its principal, applies
   administrator/user policy, and selects the worker for a conversation.
2. Code API authenticates the selection, queues and fences assignments, and
   exposes the outbound bridge.
3. `@librechat/code` runs on the attached machine, owns local workspace
   admission, rotates its bridge credential, and executes tools through SRT.
4. The machine owner controls the OS, workspace, network, credentials, and
   service lifecycle.

Pairing authenticates a worker. It does not make the host trustworthy, attest
the host policy, or replace tool approval. A `trusted-vm` worker is appropriate
only when the VM boundary is already operated as the security boundary.

## 2. Configure LibreChat and Code API

Deploy Code API's remote-bridge profile before pairing a machine. At minimum,
use paired authentication and dynamic routing so one bridge can serve many
principal-bound workers:

```dotenv
CODEAPI_SANDBOX_BACKEND=remote-bridge
CODEAPI_EXECUTION_PROFILE=stateful
CODEAPI_RUNTIME_SESSION_MODE=affinity
CODEAPI_BRIDGE_AUTH_MODE=paired
CODEAPI_BRIDGE_DYNAMIC_WORKERS=true
CODEAPI_BRIDGE_TOKEN=<strong-administrator-bootstrap-secret>
```

The administrator token belongs only on the Code API/control-plane host. Never
put it on an attached machine. Configure Redis and the remaining Code API
settings as described in the [Remote Code Bridge guide](./README.md).

Expose that Code API endpoint to LibreChat and explicitly choose which
state-sharing scopes the deployment permits:

```yaml
endpoints:
    agents:
        capabilities:
            [
                deferred_tools,
                execute_code,
                file_search,
                web_search,
                artifacts,
                subagents,
                actions,
                context,
                skills,
                memory,
                ask_user_question,
                tools,
                chain,
                ocr,
                stateful_code_sessions,
            ]
        statefulCodeSessions:
            allowedEnvironments: [user, agent-user, conversation]
            environments:
                - id: attached-workers
                  name: Attached machines
                  type: attached
                  baseURL: https://code.example.com/v1
                  default: true
```

The example preserves LibreChat's default capabilities and adds the opt-in
`stateful_code_sessions` capability. Adjust the list to the deployment's
policy. Exactly one configured Code environment must be the default. The three
sharing scopes mean:

-   `user`: reuse an environment for the signed-in user;
-   `agent-user`: reuse it for one agent and user; and
-   `conversation`: isolate reuse to one conversation.

These scopes determine session reuse. They do not weaken a worker's filesystem
root or share one user's principal-bound machine with another user.

Enable stateful code sessions on the intended agent and select the attached
environment. Start with file writes and command execution set to `ask`; expose
`allow` or `deny` only when the deployment and machine policy permit them.
Worker capabilities are a ceiling: a conversation setting cannot enable a
command or write that the worker did not advertise.

## 3. Roll out compatible consumers first

Before enabling `--environment` on a worker:

1. Deploy a LibreChat version that accepts named environment descriptors.
2. Deploy the matching Code API API and queue-worker processes.
3. Update `@librechat/code` on the attached machine.
4. Only then restart the worker with `--environment`.

An old worker remains compatible with new consumers until the opt-in flag is
used. An old strict consumer can reject a new worker's environment metadata.
During a rolling deployment, update every API/queue replica before changing
workers.

Record the exact source commit or package version at every tier. Do not infer a
worker's version from the Code API server: the worker is a separate process on
a separate machine.

## 4. Prepare the worker host

Install:

-   Node.js 20.11 or newer (Node.js 24 is supported);
-   Git;
-   `bubblewrap`, `socat`, and `ripgrep` on Linux;
-   Bash 5.2 or newer and `jq` when Bash Programmatic Tool Calling is enabled;
    and
-   GitHub CLI and Git LFS only when the workflows need them.

For example, install the system dependencies on Ubuntu with:

```bash
sudo apt-get update
sudo apt-get install -y bash bubblewrap git jq ripgrep socat
```

On macOS, install the optional PTC and GitHub tools with:

```bash
brew install bash gh git-lfs jq ripgrep
```

Install Node.js through the host's managed package source or version manager.
Bun is not required by `@librechat/code`.

Keep source, application state, environment definitions, and credentials in
separate paths. For example:

```text
/opt/librechat-code/releases/<commit>/   pinned worker source/build
/srv/code-workspaces/                    coding roots
/etc/librechat-code/environments/        operator-owned YAML definitions
~/.config/librechat/code/                paired identity
~/.config/librechat-code/github-app.pem  optional GitHub App key
```

Every ancestor of a definition, identity, key, quarantine file, or workspace
root must be owned by the worker account or root. It must not be writable by
group or other users. Sticky shared directories such as `/tmp` are handled
separately, but should not hold durable configuration.

The workspace remains writable by its owner. For a dedicated service account,
a typical root is:

```bash
sudo install -d -o librechat-code -g librechat-code -m 0750 /srv/code-workspaces
```

Do not register a home directory or another root containing credentials,
shell history, SSH keys, or unrelated projects.

## 5. Install a pinned worker

Use a published version when available. To install from source, keep a pinned
checkout and build only the worker package:

```bash
git clone https://github.com/LibreChat-AI/code-interpreter.git /opt/librechat-code/source
cd /opt/librechat-code/source
git fetch origin main
git checkout --detach <reviewed-commit>
npm ci --prefix packages/code
npm run build --prefix packages/code
cd packages/code
sudo npm link
```

Confirm that `/usr/local/bin/librechat-code` resolves to the intended build.
Do not replace a running release until the new build and its native imports
have succeeded. Keeping releases in commit-named directories makes rollback a
service-path change instead of a rebuild.

## 6. Pair the machine

Create a pairing in LibreChat's Code environments UI when available. The
pairing must be bound to the intended deployment, tenant, user, role, or group.
The code is single-use and expires after ten minutes.

Redeem it on the worker machine:

```bash
librechat-code pair https://code.example.com/v1 '<one-time-code>' \
  --worker-id code-example123
```

Run pairing as the same operating-system account that will run the worker. If
the systemd service uses `User=librechat-code`, run the command as that account
or supply an explicit identity path the account can read and replace.

The CLI generates the Ed25519 private key locally and saves the identity under
`~/.config/librechat/code/` with owner-only permissions. Do not transmit or
copy that file through chat. The bridge credential expires after fifteen
minutes, but a running worker rotates it automatically. A normal restart does
not require re-pairing.

For a custom location, use `--identity` during pairing and set
`LIBRECHAT_CODE_IDENTITY_FILE` in the service. Keep the worker ID stable: agent
defaults and conversations refer to the environment record associated with
that identity.

## 7. Define named environments

Store definitions outside every workspace root. A broad, multi-project VM can
preserve an existing `primary` binding without pretending the root is one Git
repository:

```yaml
# /etc/librechat-code/environments/primary.yaml
name: primary
root: /srv/code-workspaces
```

For a single project, descriptive repository metadata and fixed actions may be
useful:

```yaml
name: app-dev
root: /srv/code-workspaces/app
repo: example/app
ref: main
setup:
    command: npm ci
    timeoutMs: 300000
actions:
    - name: typecheck
      command: npm run typecheck
      timeoutMs: 120000
    - name: test
      command: npm test
      timeoutMs: 300000
```

Important semantics:

-   `name` is both the workspace ID and its current display name. Preserve an
    existing ID such as `primary` to preserve agent/conversation bindings.
-   `repo` and `ref` are labels. They do not clone, fetch, or check out anything.
-   `root` must already exist. Relative roots resolve from the definition file.
-   Setup runs before registration on every worker start. It must be idempotent.
-   A setup failure or timeout prevents registration and leaves a durable
    quarantine marker for operator inspection.
-   Actions are fixed operator commands. The model selects only the action name
    and fingerprint; it cannot inject arguments, a command, or a working
    directory.
-   Actions still pass through LibreChat approval and worker command policy.
-   Up to 32 roots may be declared, and they must not overlap. A broad parent
    environment cannot coexist with child project environments.

Definitions contain policy rather than secrets. A root-owned file may be
readable by the service account, but must not be group/other writable. For
example:

```bash
sudo install -d -o root -g librechat-code -m 0750 /etc/librechat-code/environments
sudo install -o root -g librechat-code -m 0640 primary.yaml \
  /etc/librechat-code/environments/primary.yaml
```

Do not combine `--environment` with `--worker-dir`, `--default-workspace`,
`--workspace`, `--workspace-id`, or `--workspace-name`. Remove the equivalent
`LIBRECHAT_CODE_WORKER_DIR`, `LIBRECHAT_CODE_WORKSPACE_ID`, and
`LIBRECHAT_CODE_WORKSPACE_NAME` settings too.

## 8. Choose a command policy

For a personal machine, use the default `restricted` policy and explicitly
allow only required network destinations.

For a separately secured VM whose outer boundary is managed by the operator,
the worker may use:

```text
--allow-workspace-writes
--allow-workspace-commands
--command-policy-preset trusted-vm
```

`trusted-vm` is a policy preset, not an unsandboxed execution mode. SRT still
protects the bridge identity, GitHub credentials, worker configuration, and
control sockets. The preset deliberately permits broader workspace and network
behavior because the VM owner accepts responsibility for the host boundary.

LibreChat's tool approval remains independent. Enabling commands on a worker
does not authorize a user or agent to bypass `ask` or `deny` policy.

## 9. Optionally configure a GitHub App

Prefer a GitHub App over a personal token. Install it only on repositories the
agent may use and grant the minimum permissions its workflows require. Git
clone/fetch/push generally needs repository Contents access; API-based pull
request workflows also need Pull requests access.

Store the downloaded private key outside every workspace. Unlike an
environment definition, the key must have no group or other access and must be
readable by the service account:

```bash
install -d -m 0700 ~/.config/librechat-code
install -m 0600 app.private-key.pem ~/.config/librechat-code/github-app.pem
```

Configure the worker, preferably in a separate service drop-in:

```ini
[Service]
Environment=LIBRECHAT_CODE_GITHUB_APP_ID=12345
Environment=LIBRECHAT_CODE_GITHUB_INSTALLATION_ID=67890
Environment=LIBRECHAT_CODE_GITHUB_PRIVATE_KEY_FILE=/home/librechat-code/.config/librechat-code/github-app.pem
```

The trusted worker mints short-lived installation tokens. Sandboxed commands
receive masked Git/`gh` credentials only for the configured GitHub hosts; the
token is not written to the repository, remote URL, or Git configuration.

## 10. Run under systemd

Use a dedicated service account in a multi-user deployment. This example keeps
the paired identity in its default location:

```ini
# /etc/systemd/system/librechat-code.service
[Unit]
Description=LibreChat attached code worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=librechat-code
Group=librechat-code
WorkingDirectory=/srv/code-workspaces
Environment=HOME=/home/librechat-code
Environment=NODE_ENV=production
Environment=LIBRECHAT_CODE_WORKER_ID=code-example123
ExecStart=/usr/local/bin/librechat-code run \
  --environment /etc/librechat-code/environments/primary.yaml \
  --allow-workspace-writes \
  --allow-workspace-commands
Restart=always
RestartSec=5s
TimeoutStopSec=35s
KillMode=control-group
UMask=0077
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

For a trusted VM, append `--command-policy-preset trusted-vm` to `ExecStart`.
After installing or changing a unit or drop-in, reload it before restart:

```bash
sudo systemd-analyze verify librechat-code.service
sudo systemctl daemon-reload
sudo systemctl enable --now librechat-code.service
```

`systemctl restart` alone does not load a changed unit definition.

## 11. Run under launchd on macOS

Use absolute executable and release paths in the property list. Keep the paired
identity in the logged-in user's private configuration directory:

```xml
<key>ProgramArguments</key>
<array>
  <string>/absolute/path/to/node</string>
  <string>/opt/librechat-code/releases/COMMIT/packages/code/dist/cli.js</string>
  <string>run</string>
  <string>--environment</string>
  <string>/Users/worker/.config/librechat/code/environments/primary.yaml</string>
  <string>--allow-workspace-writes</string>
  <string>--allow-workspace-commands</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>LIBRECHAT_CODE_WORKER_ID</key>
  <string>code-example123</string>
  <key>LIBRECHAT_CODE_IDENTITY_FILE</key>
  <string>/Users/worker/.config/librechat/code/code-example123.json</string>
</dict>
```

Editing the plist does not update launchd's cached job. Reload it:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.librechat.code.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.librechat.code.plist
```

`launchctl kickstart -k` restarts the already-loaded definition and therefore
continues using stale paths after a plist edit.

## 12. Verify the complete path

Do not stop at “the process is running.” Check:

1. The service command points to the intended version and environment file.
2. The native executor child started.
3. The worker has an established outbound HTTPS connection to Code API.
4. Code API reports the worker `online: true` and `ready: true` with the expected
   workspace IDs and operations.
5. LibreChat lists the environment for the expected principal.
6. A disposable chat can select the workspace, read a file, perform an approved
   write, execute a command, and retain state on the next turn.
7. Stop/cancellation prevents a delayed mutation.
8. A denied action remains denied even when the worker uses `trusted-vm`.

Useful host checks:

```bash
systemctl show librechat-code.service -p ExecStart -p MainPID -p NRestarts
journalctl -u librechat-code.service --since '10 minutes ago'
ss -tpn | grep librechat-code
```

The Code API status endpoint requires its administrator credential. Filter the
response before sharing it; do not expose tokens, pairings, bindings, or host
paths in logs or chat.

## 13. Upgrade and roll back

For each upgrade:

1. Read the release notes and confirm whether LibreChat/Code API consumers must
   land first.
2. Stage and build the new worker beside the current release.
3. Run focused package/native checks.
4. Update the service path or pinned checkout.
5. Reload the service manager definition when it changed.
6. Restart once and verify the complete path above.
7. Retain the previous release until the worker has completed real work.

For source-linked installations, verify both `git rev-parse HEAD` and the
actual executable target. Updating a Code API checkout on another host does not
update this worker.

Rollback by restoring the previous executable/service path and restarting. Do
not roll a new-metadata worker back behind the minimum consumer version while
it still advertises named environments.

## 14. Recover safely

### Expired bridge credential

A running worker refreshes its short-lived credential automatically. If a
machine is offline long enough that refresh can no longer authenticate, issue
a fresh one-time pairing for the same worker ID and redeem it with a newly
generated keypair. Reusing the worker ID preserves the LibreChat environment
record and its agent assignments; creating a new ID creates a new environment.

### Failed environment setup or uncertain mutation

Inspect or restore the affected workspace first. Then, with the normal worker
stopped, clear the local quarantine using the same identity/deployment context:

```bash
librechat-code clear-workspace-quarantine \
  --worker-dir /srv/code-workspaces/app \
  --workspace-id app-dev
```

If Code API also retains a server-side workspace fence, run the normal worker
configuration once with `--reset-workspace-quarantine app-dev`, wait for it to
exit successfully, and then start the normal service. The reset flag does not
replace the local clear command.

Never clear quarantine merely to make the worker start. It represents a setup,
command, cancellation, or settlement whose effects may be incomplete.

## 15. Common failures

-   **`--environment cannot be combined...`:** remove old workspace flags and
    equivalent environment variables.
-   **Definition or root rejected as replaceable:** remove group/other write
    permission from every path ancestor; keep owner write.
-   **Worker starts but old command/path remains:** run
    `systemctl daemon-reload`, or fully boot out/bootstrap a changed launchd
    plist.
-   **Worker online but not ready:** check native sandbox preparation, definition
    validation, setup, quarantine, and readiness logs.
-   **Setup repeats on restart:** setup is intentionally per-start; make it
    idempotent or remove it.
-   **Git works on the host but not in tools:** verify the App installation,
    permissions, private-key mode/owner, and allowed GitHub domains.
-   **Repository label is present but files are absent:** `repo`/`ref` are
    metadata; clone or mount the repository yourself.
-   **Existing chats lose their workspace:** preserve the original workspace ID
    in `name`, commonly `primary`.
-   **Multiple project roots are rejected:** roots cannot overlap; remove the
    broad parent or keep it as the only environment.

## Final checklist

-   [ ] LibreChat and every Code API replica support the worker protocol.
-   [ ] Worker version/source commit is recorded.
-   [ ] Pairing is principal-bound and the identity file is private.
-   [ ] Definitions are outside roots and immutable to sandboxed tools.
-   [ ] Workspace ancestors are not group/other writable.
-   [ ] GitHub App is optional, least-privilege, and installed only where needed.
-   [ ] Approval policy remains enforced independently of worker capability.
-   [ ] Service manager uses the intended executable and configuration.
-   [ ] Worker is online, ready, and advertises the expected workspace.
-   [ ] Read, approved mutation, command, persistence, denial, and cancellation
        are tested.
-   [ ] Upgrade and quarantine-recovery procedures are recorded for the operator.
