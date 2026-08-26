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

    # Bind the usr-merged tree atomically. Mounting /usr/sbin separately first
    # resolves to /usr/bin on Fedora and hides the mount binary needed below.
    mount -o bind,ro "$ROOTFS/usr"          /usr         || { echo "FATAL: cannot bind /usr"; exit 1; }
    hash -r

    # Keep native-tool registries from the same Debian rootfs as /usr. Leaving
    # the Fedora runner copies in place breaks alternatives-backed libraries.
    for registry in /etc/alternatives /etc/fonts /etc/libreoffice /var/cache/fontconfig; do
        if [ -d "$ROOTFS$registry" ]; then
            mount -o bind,ro "$ROOTFS$registry" "$registry" || {
                echo "FATAL: cannot bind $registry"
                exit 1
            }
        fi
    done

    mount -o bind,ro "$ROOTFS/sandbox_api"  /sandbox_api || { echo "FATAL: cannot bind /sandbox_api"; exit 1; }
    mount -o bind,ro "$ROOTFS/pkgs"         /pkgs        || { echo "FATAL: cannot bind /pkgs"; exit 1; }

    if [ -d /host-packages ]; then
        mount --bind /host-packages /pkgs 2>/dev/null || \
            echo "WARNING: could not bind /host-packages - sandbox will run without packages"
    fi

    multiarch_libdir=$(find /usr/lib -maxdepth 1 -type d -name "*-linux-gnu" -print -quit)
    if [ -n "$multiarch_libdir" ]; then
        export LD_LIBRARY_PATH="$multiarch_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    export PATH="/root/.bun/bin:$PATH"

    exec /sandbox_api/entrypoint.sh
'
