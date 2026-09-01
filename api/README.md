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

For Bash, add `"shell_output_filter":"rtk"` to opt into compact RTK command
rewrites for that request. Omit the field or use `"raw"` to preserve the
unfiltered path. Other runtimes reject the field.
