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

    # ⚠️ Copy mount (and its full shared-library closure) to a path none of
    # the bind-mounts below ever touch, BEFORE the first bind-mount runs
    # (live-incident fix, 2026-08-10, supersedes an earlier same-day
    # attempt that only cached mount'"'"'s pre-bind PATH in a variable — that
    # does NOT work: a bind-mount replaces the file *content* visible at a
    # path system-wide, so a variable still holding that same path (e.g.
    # /usr/sbin/mount) breaks identically once /usr/sbin is bound over,
    # regardless of caching). The very first bind-mount below replaces
    # /usr/sbin'"'"'s content with $ROOTFS/usr/sbin (a different rootfs, e.g.
    # Debian, which does not ship a mount binary at that exact path) — so
    # ANY subsequent reference to the original /usr/sbin/mount path, cached
    # or not, becomes "No such file or directory". Copying the binary
    # itself (plus every .so it dlopens, via ldd) to /host-tools — never a
    # bind-mount target — makes it immune to all the binds that follow.
    mkdir -p /host-tools/lib
    _mount_src="$(command -v mount)"
    cp "$_mount_src" /host-tools/mount
    chmod +x /host-tools/mount
    for _lib in $(ldd "$_mount_src" 2>/dev/null | awk "{print \$3}" | grep "^/"); do
        cp -n "$_lib" /host-tools/lib/ 2>/dev/null || true
    done
    MOUNT_BIN=/host-tools/mount
    if [ -n "$(ls -A /host-tools/lib 2>/dev/null)" ]; then
        export LD_LIBRARY_PATH="/host-tools/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    # ⚠️ On this image'"'"'s base (fedora:43), /usr/sbin is a SYMLINK to
    # `bin` (i.e. /usr/sbin and /usr/bin are the SAME underlying directory)
    # — live-incident fix, 2026-08-10. Binding $ROOTFS/usr/sbin onto
    # /usr/sbin therefore actually lands the bind on /usr/bin (mount
    # resolves the symlink); the LATER bind of $ROOTFS/usr/bin onto
    # /usr/bin then stacks on top and shadows it, so nsjail — which lives
    # only in $ROOTFS/usr/sbin (a real, separate directory on the target
    # rootfs, e.g. Debian) — silently disappears again by the time
    # /sandbox_api/entrypoint.sh runs its smoke test. Confirmed live:
    # nsjail is present and executable right after the /usr/sbin bind, and
    # gone ("No such file or directory") after the /usr/bin bind that
    # follows. Fix: if /usr/sbin is a symlink, replace it with a real
    # (empty) directory INSIDE this private mount namespace before
    # binding, so it becomes an independent mount point that the later
    # /usr/bin bind cannot shadow. Namespace-local — never touches the
    # actual node or any other container.
    if [ -L /usr/sbin ]; then
        rm /usr/sbin && mkdir /usr/sbin
    fi

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

    # Done with our host-side mount(1) — unset LD_LIBRARY_PATH before the
    # sandboxed entrypoint sets its own below, so /host-tools/lib (Fedora
    # libs) never shadows the guest rootfs'"'"'s own libraries for it.
    unset LD_LIBRARY_PATH

    multiarch_libdir=$(find /usr/lib -maxdepth 1 -type d -name "*-linux-gnu" -print -quit)
    if [ -n "$multiarch_libdir" ]; then
        export LD_LIBRARY_PATH="$multiarch_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    export PATH="/root/.bun/bin:$PATH"

    exec /sandbox_api/entrypoint.sh
'
