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
exec unshare --mount /sandbox-rootfs-setup "$ROOTFS"
