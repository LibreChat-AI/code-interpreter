#!/bin/bash
# KVM microVM guest clock synchronization wrapper.
# Synchronizes guest system CLOCK_REALTIME directly from the host via the KVM
# virtual PTP hardware clock (/dev/ptp0) using chrony, before starting the API.
# The host clock is the root authority; no external network NTP traffic is used.
# Runtime state is isolated in a private, root-owned directory under /run.

# Own the bootstrap shell: libkrun signals this PID, not a supervisor subshell.
# Like the previous exec path, this function exits rather than returning.
run_clock_synchronized_guest() {
    set -euo pipefail
    local root="${1?root argument required (empty for the guest)}"
    shift
    [ "$#" -gt 0 ] || { echo 'ERROR: guest command required' >&2; exit 1; }
    export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}:/usr/sbin"

    local clock_dir="$root/run/codeapi-clock"
    local socket_file="$clock_dir/chronyd.sock"
    local chrony_pid="" guest_pid="" sync_pid=""

    # /run is a fresh guest-private tmpfs. mkdir refuses existing entries,
    # including dangling symlinks; sandbox UIDs cannot replace its children.
    (umask 077; mkdir "$clock_dir") || exit 1

    stop_child() {
        local pid="$1"
        [ -n "$pid" ] || return 0
        kill -TERM "$pid" 2>/dev/null || true
        local attempt
        for attempt in {1..20}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.05
        done
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    }

    cleanup() {
        trap - EXIT INT TERM
        stop_child "$sync_pid"
        stop_child "$guest_pid"
        stop_child "$chrony_pid"
        rm -rf -- "$clock_dir"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    chronyd -d -u root -f "$root/sandbox_api/config/guest-chrony.conf" &
    chrony_pid=$!

    # Allow socket creation before chronyc connects; refuse a dead daemon.
    local attempt
    for attempt in {1..100}; do
        kill -0 "$chrony_pid" 2>/dev/null || {
            echo 'ERROR: guest clock daemon exited during startup' >&2
            exit 1
        }
        [ ! -e "$socket_file" ] || break
        sleep 0.05
    done
    [ -e "$socket_file" ] || {
        echo 'ERROR: guest clock control socket did not become ready' >&2
        exit 1
    }

    # Bound both clock acquisition and a stuck control client. Backgrounding
    # the wait lets INT/TERM interrupt startup and clean up the whole group.
    timeout -k 1 15 chronyc -h "$socket_file" waitsync 100 0.05 0 0.1 &
    sync_pid=$!
    local status=0
    wait "$sync_pid" || status=$?
    sync_pid=""
    if [ "$status" -ne 0 ] || ! kill -0 "$chrony_pid" 2>/dev/null; then
        echo 'ERROR: guest clock synchronization failed' >&2
        exit 1
    fi

    "$@" <&0 &
    guest_pid=$!
    local finished=""
    status=0
    wait -n -p finished "$chrony_pid" "$guest_pid" 2>/dev/null || status=$?
    if [ "${finished:-}" = "$chrony_pid" ]; then
        chrony_pid=""
        echo 'ERROR: guest clock daemon exited; stopping the guest command' >&2
        exit 1
    fi
    if [ "${finished:-}" = "$guest_pid" ]; then
        guest_pid=""
        exit "$status"
    fi

    # Bash can cache a very short-lived child's exit before wait -n starts.
    # Read its status once without swallowing failures or spinning on ECHILD.
    kill -0 "$chrony_pid" 2>/dev/null || exit 1
    status=0
    wait "$guest_pid" || status=$?
    guest_pid=""
    exit "$status"
}

