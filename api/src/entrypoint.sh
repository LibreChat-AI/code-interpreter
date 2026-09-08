#!/bin/bash
set -e

echo "Starting NsJail sandbox API..."

# Raise the RLIMIT_NOFILE limits so per-job nsjail can set its own soft
# limit (SANDBOX_MAX_OPEN_FILES) without EPERM. The AWS Lambda MicroVM base
# image ships a 1024 hard cap, below the sandbox default of 2048; nsjail
# runs the child with keep_caps:false, so the hard limit must already be
# high before the API starts. Only ever RAISE, never lower: `ulimit -n`
# clamps downward too, so an unconditional set would shrink Docker's ~1M
# default (and any SANDBOX_MAX_OPEN_FILES above 65536) instead of no-op'ing.
raise_nofile() {
  local kind="$1" want=65536 cur
  cur="$(ulimit "$kind" 2>/dev/null || echo unlimited)"
  if [ "$cur" != "unlimited" ] && [ "$cur" -lt "$want" ] 2>/dev/null; then
    ulimit "$kind" "$want" 2>/dev/null || true
  fi
}
raise_nofile -Hn   # hard first, so the soft raise below is permitted
raise_nofile -Sn

SANDBOX_USE_CGROUPV2="${SANDBOX_USE_CGROUPV2:-true}"
SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP="${SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP:-true}"
NSJAIL_CONFIG_SOURCE="${NSJAIL_CONFIG:-/sandbox_api/config/sandbox.cfg}"

# Mount tmpfs on /tmp for fast, memory-backed file I/O.
# On the KVM path, /tmp is on virtiofs-backed rootfs which has rename() quirks.
# tmpfs avoids this and is faster for the small files NsJail jobs use.
if mount -t tmpfs -o size=1g tmpfs /tmp 2>/dev/null; then
    echo "Mounted tmpfs (1g) on /tmp"
else
    echo "WARNING: tmpfs mount on /tmp failed — falling back to rootfs"
fi

# Create directories needed by NsJail
mkdir -p /tmp/sandbox
chown 0:0 /tmp/sandbox 2>/dev/null || true
chmod 711 /tmp/sandbox

# Mount virtiofs shares if running inside a libkrun microVM.
# The launcher exposes host directories as virtiofs tags that need explicit mounting.
if grep -q virtiofs /proc/filesystems 2>/dev/null; then
    if [ -d /pkgs ]; then
        mount -t virtiofs packages /pkgs 2>/dev/null && \
            echo "Mounted virtiofs 'packages' at /pkgs" || true
    fi
fi

# Restrict dmesg access (requires CAP_SYSLOG to read kernel ring buffer)
echo 1 > /proc/sys/kernel/dmesg_restrict 2>/dev/null || true

# Remove Kubernetes/containerd proc masks so NsJail can mount fresh procfs.
# Container runtimes add submounts to /proc (kcore, keys, timer_list, etc.)
# and the kernel blocks new procfs mounts when these exist. Removing them
# lets NsJail mount fresh procfs inside each sandbox's PID namespace, which
# only exposes the sandbox's own PIDs — preventing cross-sandbox visibility.
PROC_SUBMOUNTS=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | sort -r)
if [ -n "$PROC_SUBMOUNTS" ]; then
    echo "Removing $(echo "$PROC_SUBMOUNTS" | wc -l) /proc submounts for fresh procfs support..."
    for mnt in $PROC_SUBMOUNTS; do
        umount "$mnt" 2>/dev/null || true
    done
    REMAINING=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | wc -l)
    if [ "$REMAINING" -eq 0 ]; then
        echo "All /proc submounts removed — fresh procfs enabled"
    else
        echo "WARNING: $REMAINING /proc submounts remain — falling back to bind-mount /proc"
    fi
else
    echo "No /proc submounts detected — fresh procfs supported"
fi

if [ "$SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP" = "true" ]; then
    rm -f /usr/bin/umount 2>/dev/null || true
fi

# Set up cgroup v2 delegation for NsJail when the container runtime allows it.
if [ "$SANDBOX_USE_CGROUPV2" = "true" ] && [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    echo "cgroup v2 detected, controllers available: $(cat /sys/fs/cgroup/cgroup.controllers)"

    if mkdir -p /sys/fs/cgroup/sandbox_api 2>/dev/null; then
        echo "Created /sys/fs/cgroup/sandbox_api"
    else
        echo "WARNING: Failed to create /sys/fs/cgroup/sandbox_api"
    fi

    if [ -d /sys/fs/cgroup/sandbox_api ] && echo $$ > /sys/fs/cgroup/sandbox_api/cgroup.procs 2>&1; then
        echo "Moved PID $$ to /sys/fs/cgroup/sandbox_api"
    else
        echo "WARNING: Failed to move PID $$ to /sys/fs/cgroup/sandbox_api"
    fi

    if echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>&1; then
        echo "Enabled +memory +pids on /sys/fs/cgroup/cgroup.subtree_control"
    else
        echo "WARNING: Failed to enable controllers on /sys/fs/cgroup/cgroup.subtree_control"
        echo "  Current subtree_control: $(cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || echo 'unreadable')"
        echo "  Procs in root cgroup: $(wc -l < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo 'unknown')"
    fi

    if [ -f /sys/fs/cgroup/sandbox_api/cgroup.controllers ]; then
        echo "sandbox_api controllers: $(cat /sys/fs/cgroup/sandbox_api/cgroup.controllers)"
    else
        echo "WARNING: sandbox_api/cgroup.controllers not found"
    fi

    echo "cgroup v2 delegation configured"
else
    echo "cgroup v2 disabled for NsJail"
    NSJAIL_CONFIG="/tmp/sandbox-no-cgroup.cfg"
    sed '/^cgroup_/d' "$NSJAIL_CONFIG_SOURCE" > "$NSJAIL_CONFIG"
    export NSJAIL_CONFIG
fi

# Ensure the nobody user (UID 65534) exists for NsJail
if ! timeout 2 getent passwd 65534 >/dev/null 2>&1; then
    useradd -M -u 65534 -s /usr/sbin/nologin nobody 2>/dev/null || true
fi

# Set up iptables rules for restricted local networking if configured
# SANDBOX_ALLOWED_LOCAL_NETWORK_PORT restricts sandbox to only connect to localhost:port
ALLOWED_PORT="${SANDBOX_ALLOWED_LOCAL_NETWORK_PORT:-0}"

# NsJail runs sandboxed processes as inside UID 65534 (nobody), mapped to a
# per-job outside UID by the sandbox API. The proxy socket remains mounted
# into each jail, so it does not need per-UID ownership.
SANDBOX_UID=65534

# Extract API port from bind address (default 2000)
API_PORT="${PORT:-2000}"

if [ "$ALLOWED_PORT" -gt 0 ] 2>/dev/null; then
    if [ "$ALLOWED_PORT" -eq "$API_PORT" ] 2>/dev/null; then
        echo "ERROR: SANDBOX_ALLOWED_LOCAL_NETWORK_PORT cannot be set to the API port ($API_PORT) - this would allow sandbox escape!"
        exit 1
    fi

    echo "Tool-call socket forwarding enabled for UID $SANDBOX_UID (port $ALLOWED_PORT)"
    # Do not start Node here. Lambda MicroVM image creation snapshots this
    # already-running container, and the official Node binary embeds OpenSSL.
    # The API starts and awaits the narrow Unix-socket proxy only after a
    # post-restore /execute is authorized for tool calls.
fi

# Package permissions are finalized by package-init when the PVC is populated.
# Avoid recursively chmoding /pkgs here: in KVM mode it is a virtio-fs mount,
# and walking the full package tree at every runner boot can exhaust VMM file
# descriptors before the sandbox API even starts.

# NsJail smoke test: verify sandbox can start before accepting traffic.
echo "Running NsJail smoke test..."
echo "Guest RLIMIT_NOFILE soft limit: $(ulimit -n 2>/dev/null || echo unknown)"
SMOKE_DIR=$(mktemp -d)
SMOKE_PER_JOB_UIDS="${SANDBOX_PER_JOB_UIDS:-true}"
SMOKE_UID_BASE="${SANDBOX_JOB_UID_BASE:-200000}"
SMOKE_GID_BASE="${SANDBOX_JOB_GID_BASE:-200000}"
if [ "$SMOKE_PER_JOB_UIDS" = "true" ]; then
    SMOKE_OUTSIDE_UID="$SMOKE_UID_BASE"
    SMOKE_OUTSIDE_GID="$SMOKE_GID_BASE"
else
    SMOKE_OUTSIDE_UID=65534
    SMOKE_OUTSIDE_GID=65534
fi
	if chown "$SMOKE_OUTSIDE_UID:$SMOKE_OUTSIDE_GID" "$SMOKE_DIR"; then
	    chmod 711 "$SMOKE_DIR"
	elif [ "$SMOKE_PER_JOB_UIDS" = "true" ]; then
	    echo "NsJail smoke test setup failed: SANDBOX_PER_JOB_UIDS=true requires chown support" >&2
	    exit 1
	else
	    chmod 777 "$SMOKE_DIR"
	fi
SMOKE_LOG=$(mktemp)
SMOKE_STDERR=$(mktemp)

NSJAIL_CGROUP_ARGS=()
if [ "$SANDBOX_USE_CGROUPV2" = "true" ]; then
    NSJAIL_CGROUP_ARGS=(--use_cgroupv2)
fi

if timeout 10 "${NSJAIL_PATH:-/usr/sbin/nsjail}" --config "${NSJAIL_CONFIG:-/sandbox_api/config/sandbox.cfg}" \
    "${NSJAIL_CGROUP_ARGS[@]}" --log "$SMOKE_LOG" \
    --user "65534:${SMOKE_OUTSIDE_UID}:1" --group "65534:${SMOKE_OUTSIDE_GID}:1" \
    -s /usr/bin:/bin -s /usr/lib:/lib -s /usr/lib64:/lib64 \
    -B "$SMOKE_DIR:/mnt/data" \
    -- /bin/sh -c 'printf "%s\n" sandbox_ok > /mnt/data/smoke.txt && test "$(cat /mnt/data/smoke.txt)" = sandbox_ok' > /dev/null 2>"$SMOKE_STDERR"; then
    echo "NsJail smoke test passed"
else
    echo "FATAL: NsJail smoke test failed — sandbox cannot start"
    echo "NsJail log output:"
    cat "$SMOKE_LOG" 2>/dev/null || true
    echo "NsJail stderr:"
    cat "$SMOKE_STDERR" 2>/dev/null || true
    rm -f "$SMOKE_LOG"
    rm -f "$SMOKE_STDERR"
    rm -rf "$SMOKE_DIR"
    exit 1
fi
rm -f "$SMOKE_LOG"
rm -f "$SMOKE_STDERR"
rm -rf "$SMOKE_DIR"

echo "Starting sandbox API server..."
exec bun run /sandbox_api/.build/index.js
