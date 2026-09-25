# Sandbox API

NsJail-based sandbox for secure code execution. Runs untrusted user code inside isolated Linux namespaces with seccomp-bpf syscall filtering and cgroup resource limits.

## How It Works

1. The API receives a `POST /api/v2/execute` request containing user code, language, and optional files/stdin
2. A submission directory is created and user files are written to it
3. NsJail is invoked, bind-mounting the submission directory to `/mnt/data` inside the sandbox
4. The sandboxed process runs as `nobody` (UID 65534) with no network access, limited syscalls, and cgroup-enforced memory/CPU/PID limits
5. stdout, stderr, exit code, and signal information are captured and returned

## Sandbox Isolation

Each code execution runs in a fresh NsJail sandbox with the following isolation:

| Layer | Mechanism | Effect |
|-------|-----------|--------|
| **Namespaces** | PID, mount, network, user, IPC, UTS, cgroup | Complete process and filesystem isolation |
| **Seccomp-bpf** | Kafel policy in `nsjail.ts` | Blocks dangerous syscalls (`ptrace`, `mount`, `bpf`, etc.), kernel-control socket families (`AF_KEY`, `AF_NETLINK`, `AF_RXRPC`), nested namespace creation, and returns `EPERM`/`ENOSYS` for runtime probes like `io_uring` and `clone3` |
| **cgroups v2** | Memory, swap, PID limits | Prevents resource exhaustion |
| **rlimits** | AS, fsize, nofile, nproc, cpu | Per-process resource caps |
| **User mapping** | UID/GID 65534 (`nobody`) | No privilege escalation |
| **Filesystem** | Read-only `/usr`, tmpfs `/tmp`, writable `/mnt/data` only | Minimal writable surface |
| **Network** | `clone_newnet` (empty network namespace) | No outbound connectivity by default |

## Configuration

### NsJail Config

The protobuf config at `config/sandbox.cfg` defines the static sandbox policy: namespace flags, mount table, UID/GID mapping, and default cgroup limits. Per-execution overrides (timeout, memory, seccomp policy, env vars) are passed as CLI arguments by `nsjail.ts`.

### Environment Variables

All prefixed with `SANDBOX_` unless noted:

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_LOG_LEVEL` | `INFO` | Log verbosity |
| `SANDBOX_PACKAGES_DIRECTORY` | `/pkgs` | Directory containing language packages |
| `SANDBOX_DISABLE_NETWORKING` | `true` | Isolate sandbox from the network |
| `SANDBOX_ALLOWED_LOCAL_NETWORK_PORT` | `0` | Allow sandbox to reach this host port (for tool calling) |
| `SANDBOX_OUTPUT_MAX_SIZE` | `1024` | Per-stream output cap. stderr truncates at this size (the job keeps running); stdout overflow kills the job (`status: OL`), since stdout is the result. Every shipped compose/helm config sets `65536` — the `1024` fallback only applies when running the runner bare. |
| `SANDBOX_MAX_PROCESS_COUNT` | `64` | Max PIDs inside the sandbox |
| `SANDBOX_MAX_OPEN_FILES` | `2048` | rlimit nofile |
| `SANDBOX_MAX_FILE_SIZE` | `10000000` | rlimit fsize (bytes) |
| `SANDBOX_COMPILE_TIMEOUT` | `10000` | Compile phase timeout (ms) |
| `SANDBOX_RUN_TIMEOUT` | `30000` | Run phase timeout (ms) |
| `SANDBOX_COMPILE_CPU_TIME` | `10000` | Compile CPU time limit (ms) |
| `SANDBOX_RUN_CPU_TIME` | `30000` | Run CPU time limit (ms) |
| `SANDBOX_COMPILE_MEMORY_LIMIT` | `-1` | Compile memory cgroup limit (bytes, -1 = no limit) |
| `SANDBOX_RUN_MEMORY_LIMIT` | `-1` | Run memory cgroup limit (bytes, -1 = no limit) |
| `SANDBOX_MAX_CONCURRENT_JOBS` | `8` | Max parallel executions per sandbox runner |
| `SANDBOX_RLIMIT_AS` | `4096` | Address space rlimit (MB) |
| `SANDBOX_RLIMIT_FSIZE` | `100` | File size rlimit (MB) |
| `SANDBOX_LIMIT_OVERRIDES` | `{}` | JSON object for per-runtime limit overrides |
| `NSJAIL_PATH` | `/usr/sbin/nsjail` | Path to the NsJail binary |
| `NSJAIL_CONFIG` | `/sandbox_api/config/sandbox.cfg` | Path to the NsJail protobuf config |
| `FILE_SERVER_URL` | _(empty)_ | File server base URL for downloading/uploading files |
| `PORT` | `2000` | HTTP listen port |

## Supported Runtimes

Runtimes are auto-discovered from `/pkgs` at startup. Each package provides `compile` and `run` shell scripts. Currently tested and supported:

- **Python** 3.14 -- includes `matplotlib`, `numpy`, `pandas`, `scipy`, `statsmodels`, chDB (`chdb`), geospatial (`geopandas`, `rasterio`, `rioxarray`, `pyproj`), and other scientific packages
- **Node.js** 24 -- runs `.js` files with curated offline npm packages
- **Bun** (JavaScript/TypeScript) -- runs `.js`, `.ts`, and `.bun` files with the same curated offline package set

Other package-format-compatible runtimes (Go, Rust, Java, GCC) can be installed but may require additional system libraries to be added to the sandbox image.

## Filesystem Layout Inside the Sandbox

```
/mnt/data/          Working directory (bind mount, writable)
  ├── *.py          User code files
  ├── *.js / *.ts   User code files
  └── ...           Downloaded files from file server
/tmp/               tmpfs (20MB, writable)
/usr/               Host /usr (read-only bind mount)
/bin -> /usr/bin    Symlink (merged-usr)
/lib -> /usr/lib    Symlink (merged-usr)
/lib64 -> /usr/lib64  Symlink (merged-usr)
/proc/              procfs (read-only, required by Bun)
/dev/null           Device node (read-only)
/dev/urandom        Device node (read-only)
/dev/zero           Device node (read-only)
/pkgs/   Language runtime packages (read-only bind mount)
```

## API Endpoints

### `POST /api/v2/execute`

Execute code in a sandboxed environment.

When a persisted input file is removed during execution, a complete artifact
scan reports its relative path in `deleted_files`. Callers can use this
explicit list to remove stale file references from their next session request.
The field is omitted when no persisted inputs were removed or when artifact
scanning is incomplete, so truncation or unreadable paths cannot be mistaken
for deletions.

When supported output files are omitted because the response reaches its file
count limit, nesting or path limits, file-size limit, or a filesystem entry
cannot be read, the response includes `artifact_truncation`. Its `reasons`
object counts detected omissions by cause, `skipped_count` reports the total
detected omissions, and `skipped` contains up to 20 relative paths so callers
can match an expected output. Intentional filters such as unsupported file
extensions, hidden runtime directories, and unchanged session files do not
produce this marker when they can be classified within the bounded scan. A
depth-capped subtree that exceeds the metadata probe budget is reported
conservatively rather than allowing post-execution traversal to run unbounded.

### `GET /api/v2/runtimes`

List available language runtimes.

## Development

```bash
# Build and run locally with docker-compose, from the codeapi root
docker compose up --build

# Test execution
curl -s http://localhost:2000/api/v2/execute \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","version":"3.14.4","files":[{"content":"print(42)"}]}' | jq
```

### Requested runtime caps

`POST /api/v2/execute` treats `run_timeout` as an upper bound in milliseconds.
A request above the effective runtime limit is clamped to that limit, including
language and package overrides. Smaller caps are preserved, and omission uses
the runtime default. Compile, CPU, and memory constraints retain their existing
validation behavior.

Roll out this sandbox behavior before enabling timeout forwarding in the
service's plain `/exec` handler. Older sandboxes reject caps above their local
runtime limit; older services remain compatible with updated sandboxes.

### Runner memory after cleanup

`Job.cleanup()` emits `Post-cleanup resources` after workspace removal and UID
release (or quarantine). `/execute` now waits for cleanup before sending success
or execution-failure responses. Artifact upload still finishes before cleanup.
Persistent session workspaces and their pinned UIDs are intentionally preserved;
failed disposable cleanup still quarantines the directory and retains its UID
for the existing retry path. This change does not alter those policies.

The following metrics use only fixed, low-cardinality labels:

| Metric suffix (prefix `codeapi_sandbox_`) | Meaning |
| --- | --- |
| `post_cleanup_memory_bytes{kind}` | `current`, `anon`, `file`, `shmem` at the visible cgroup v2 mount root |
| `post_cleanup_tmp_used{resource}` | `/tmp` allocated `bytes`, allocated `inodes`, and `is_tmpfs` (0 or 1) |
| `post_cleanup_workspaces{kind}` | Remaining `disposable`, `session`, and `other` entries in `/tmp/sandbox` |
| `cleanup_total{mode,outcome}` | Disposable/session cleanup attempts: `removed`, `preserved`, `retained`, `error` |
| `post_cleanup_sample_success{source}` | Whether `memory`, `tmp`, or `workspaces` was readable on the last sample |
| `post_cleanup_timestamp_seconds` | When the last cleanup sample was taken |

These are runner-wide **last-cleanup samples**, not live gauges or per-job
memory attribution. Other jobs can still be running. Reaper-only changes are
visible on the next job cleanup, not immediately. Interpret the workspace counts
alongside active executions and the sample timestamp. Unavailable sources are
reported as unavailable and their old gauge values are removed, never replaced
with a healthy-looking zero. The structured log also includes active UID slots
and the number of retained cleanup retries. Synthetic jobs update metrics while
suppressing successful per-job logs as before.

The visible cgroup root covers the API and sibling NsJail cgroups. The old
`Post-execution memory` log instead samples `/proc/self/cgroup` **before** job
cleanup, so it can have a different scope. `file` includes `shmem`; do not add
them or assume all `file` memory is reclaimable page cache.

`statfs` measures allocation, including deleted-but-open files on the sampled
mount, without walking user files. The runner's 1 GiB `/tmp` mount is distinct
from each jail's 20 MiB `/tmp` mount. Its ceiling does not cap all container
memory. If workspace counts fall but shmem does not, investigate descendant
processes and retained mounts as well as files. A stable API-process FD count
alone cannot exclude those cases. Memory requests and HPA settings are unchanged.

#### Cleanup stress tests

Ordinary unit tests cover metrics, unavailable sources, session/disposable
classification and response ordering. The opt-in stress tests must run in an
**isolated test container**, never on an active runner:

```bash
# From api/, with /tmp mounted as tmpfs and per-job chown available:
SANDBOX_CLEANUP_TMPFS_TEST=1 bun test src/cleanup.integration.test.ts

# Additionally requires the runner's NsJail binary, spec-guard, config,
# and normal namespace/cgroup permissions. Run this file alone.
NSJAIL_CONFIG=/sandbox_api/config/sandbox.cfg \
SANDBOX_CLEANUP_NSJAIL_TEST=1 bun test src/cleanup.integration.test.ts
```

The first test repeats real Job priming and cleanup with large payloads and many
small files, checking tmpfs bytes/inodes and UID slots after every iteration.
CI runs it in a dedicated Bun container with a 1 GiB `/tmp` tmpfs. It does not
execute NsJail. The second test uses real NsJail jobs covering normal completion,
timeout and output overflow, including a detached child holding an unlinked file.
It asserts no processes remain under the job UID before removing its workspace,
then checks workspace removal and post-cleanup tmpfs allocation. This test is
skipped unless explicitly enabled; a unit-test pass is not proof of namespace
teardown on the production kernel.
