#!/bin/bash

echo "Starting Sandbox (direct NsJail, no microVM) on port 2000..."

ROOTFS="${SANDBOX_ROOTFS:-/sandbox-rootfs}"

mkdir -p /sandbox_api /pkgs

if mount -o remount,rw /sys/fs/cgroup 2>/dev/null; then
    echo "[sandbox] Remounted cgroupfs as rw"
else
    echo "[sandbox] WARNING: could not remount cgroupfs rw - NsJail cgroup isolation may fail"
fi

mkdir -p /sys/fs/cgroup/init
echo "[sandbox] Draining root cgroup ($(wc -w < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo '?') procs) into init/..."
_root_procs=$(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null || true)
for _pid in $_root_procs; do
    echo "$_pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
done
_remaining=$(wc -w < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo "?")
echo "[sandbox] Root cgroup procs after drain: $_remaining"

if echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
    echo "[sandbox] Enabled +memory +pids on root cgroup.subtree_control"
else
    echo "[sandbox] WARNING: could not enable controllers on root ($_remaining procs remain)"
fi

PROC_SUBMOUNTS=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | sort -r)
if [ -n "$PROC_SUBMOUNTS" ]; then
    echo "[sandbox] Removing $(echo "$PROC_SUBMOUNTS" | wc -l) /proc submounts for fresh procfs support..."
    for mnt in $PROC_SUBMOUNTS; do
        umount "$mnt" 2>/dev/null || true
    done
    REMAINING=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | wc -l)
    if [ "$REMAINING" -eq 0 ]; then
        echo "[sandbox] All /proc submounts removed"
    else
        echo "[sandbox] WARNING: $REMAINING /proc submounts remain"
    fi
else
    echo "[sandbox] No /proc submounts to remove"
fi

export SANDBOX_ROOTFS="$ROOTFS"

exec unshare --mount bash -c '
    ROOTFS="${SANDBOX_ROOTFS:-/sandbox-rootfs}"

    # ⚠️ Resolve mount to an absolute path BEFORE any bind-mount runs, and
    # use that variable for every call below (live-incident fix,
    # 2026-08-10). Bash caches a bare command word to the absolute path it
    # first resolved via PATH (its hash table) and does NOT re-search PATH
    # on later invocations. The very first bind-mount below replaces
    # /usr/sbin'"'"'s CONTENT with $ROOTFS/usr/sbin (a different rootfs,
    # e.g. Debian, which may not ship a mount binary at that exact path) —
    # so a later bare `mount` call can still be hashed to the pre-bind-mount
    # /usr/sbin/mount and fail with "No such file or directory" even though
    # a working mount binary exists elsewhere on $PATH. Confirmed live.
    MOUNT_BIN="$(command -v mount)"

    "$MOUNT_BIN" -o bind,ro "$ROOTFS/usr/sbin"     /usr/sbin    || { echo "FATAL: cannot bind /usr/sbin"; exit 1; }
    "$MOUNT_BIN" -o bind,ro "$ROOTFS/usr/lib"      /usr/lib     || { echo "FATAL: cannot bind /usr/lib"; exit 1; }

    if [ -d "$ROOTFS/usr/lib64" ] && ! [ -L "$ROOTFS/usr/lib64" ]; then
        "$MOUNT_BIN" -o bind,ro "$ROOTFS/usr/lib64" /usr/lib64 2>/dev/null || \
            echo "[sandbox] WARNING: could not bind /usr/lib64 - sandboxed binaries may fail to exec"
    fi

    "$MOUNT_BIN" -o bind,ro "$ROOTFS/usr/local"    /usr/local   || { echo "FATAL: cannot bind /usr/local"; exit 1; }
    "$MOUNT_BIN" -o bind,ro "$ROOTFS/sandbox_api"  /sandbox_api || { echo "FATAL: cannot bind /sandbox_api"; exit 1; }
    "$MOUNT_BIN" -o bind,ro "$ROOTFS/pkgs"       /pkgs      || { echo "FATAL: cannot bind /pkgs"; exit 1; }

    if [ -d /host-packages ]; then
        "$MOUNT_BIN" --bind /host-packages /pkgs 2>/dev/null || \
            echo "WARNING: could not bind /host-packages - sandbox will run without packages"
    fi

    "$MOUNT_BIN" -o bind,ro "$ROOTFS/usr/bin" /usr/bin || { echo "FATAL: cannot bind /usr/bin"; exit 1; }

    multiarch_libdir=$(find /usr/lib -maxdepth 1 -type d -name "*-linux-gnu" -print -quit)
    if [ -n "$multiarch_libdir" ]; then
        export LD_LIBRARY_PATH="$multiarch_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    export PATH="/root/.bun/bin:$PATH"

    exec /sandbox_api/entrypoint.sh
'
