#!/usr/bin/env bash
set -euo pipefail

# Keep every fixture in one bounded, private session, including GNU timeout's
# separate process group. Clean descendants even when an assertion or TERM
# interrupts the suite before the supervisor can perform its own cleanup.
if [[ "${CLOCK_TEST_SESSION:-}" != 1 ]]; then
    exec python3 - "$0" "$@" <<'PY'
import os
import signal
import subprocess
import sys
import time

child = subprocess.Popen(
    ["bash", *sys.argv[1:]],
    env={**os.environ, "CLOCK_TEST_SESSION": "1"},
    start_new_session=True,
)

def stop_session(sig):
    pids = subprocess.check_output(["ps", "-axo", "pid="], text=True).split()
    for value in pids:
        pid = int(value)
        try:
            if os.getsid(pid) == child.pid:
                os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

def interrupted(sig, _frame):
    raise SystemExit(128 + sig)

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    try:
        status = child.wait(timeout=40)
    except subprocess.TimeoutExpired:
        print("clock lifecycle suite exceeded its deadline", file=sys.stderr)
        status = 124
finally:
    stop_session(signal.SIGTERM)
    time.sleep(0.1)
    stop_session(signal.SIGKILL)
    child.wait()
sys.exit(status)
PY
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"

cleanup() {
    # The outer session owner handles process cleanup even on suite failure.
    chmod -R u+w "$TEST_DIR" 2>/dev/null || true
    rm -rf "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

create_guest_root() {
    local dir="$1"
    mkdir -p "$dir/run" "$dir/sandbox_api/config"
    cp "$ROOT/api/config/guest-chrony.conf" "$dir/sandbox_api/config/guest-chrony.conf"
}

# Base stub bin directory for simulating chronyd and chronyc
mkdir -p "$TEST_DIR/bin"

cat > "$TEST_DIR/bin/chronyd" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${TEST_CHRONYD_CRASH_EARLY:-false}" == "true" ]]; then
    echo "chronyd early crash simulation" >&2
    exit 1
fi

cfg=""
while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-f" ]]; then
        cfg="$2"
        shift 2
    else
        shift
    fi
done

if [[ -z "$cfg" || ! -f "$cfg" ]]; then
    echo "chronyd: configuration file not found: $cfg" >&2
    exit 1
fi

root="${cfg%/sandbox_api/config/guest-chrony.conf}"
clock_dir="${root}/run/codeapi-clock"
sock="${clock_dir}/chronyd.sock"

if [[ -n "${TEST_CHRONYD_PID_FILE:-}" ]]; then
    echo "$$" > "$TEST_CHRONYD_PID_FILE"
fi

mkdir -p "$(dirname "$sock")"
touch "$sock"

trap 'rm -f "$sock"; exit 0' TERM INT EXIT

while true; do
    sleep 0.05
done
STUB

cat > "$TEST_DIR/bin/chronyc" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${TEST_SYNC_FAIL:-false}" == "true" ]]; then
    echo "chronyc waitsync failure simulation" >&2
    exit 1
fi

if [[ -n "${TEST_SYNC_STARTED_FILE:-}" ]]; then
    touch "$TEST_SYNC_STARTED_FILE"
fi

if [[ -n "${TEST_DELAY_SYNC_FILE:-}" ]]; then
    while [[ ! -e "$TEST_DELAY_SYNC_FILE" ]]; do
        sleep 0.05
    done
fi

exit 0
STUB

chmod +x "$TEST_DIR/bin/chronyd" "$TEST_DIR/bin/chronyc"

# Use an exec'ing executable, not a background shell function: Bash 5.2 can
# otherwise leave a wrapper PID between the test and the supervised workload.
cat > "$TEST_DIR/bin/invoke_guest" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
root="$1"
shift
exec bash -c 'source "$1"; run_clock_synchronized_guest "$2" "${@:3}"' -- \
    "$TEST_CLOCK_SOURCE" "$root" "$@"
STUB
chmod +x "$TEST_DIR/bin/invoke_guest"
export TEST_CLOCK_SOURCE="$ROOT/api/src/guest-clock.sh"
export PATH="$TEST_DIR/bin:$PATH"

# 1. Directory pre-seed rejection
GUEST_ROOT="$TEST_DIR/root_preseed"
create_guest_root "$GUEST_ROOT"
mkdir -p "$GUEST_ROOT/run/codeapi-clock"
API_CALLED="$TEST_DIR/api_called_preseed"
if invoke_guest "$GUEST_ROOT" touch "$API_CALLED" 2>/dev/null; then
    echo 'accepted pre-existing clock directory' >&2
    exit 1
fi
[[ ! -e "$API_CALLED" ]]

# 2. Directory symlink rejection
GUEST_ROOT="$TEST_DIR/root_symlink"
create_guest_root "$GUEST_ROOT"
mkdir -p "$TEST_DIR/foreign_dir"
ln -s "$TEST_DIR/foreign_dir" "$GUEST_ROOT/run/codeapi-clock"
API_CALLED="$TEST_DIR/api_called_symlink"
if invoke_guest "$GUEST_ROOT" touch "$API_CALLED" 2>/dev/null; then
    echo 'accepted symlinked clock directory' >&2
    exit 1
fi
[[ ! -e "$API_CALLED" ]]
[[ -z "$(ls -A "$TEST_DIR/foreign_dir")" ]]

# 3. Mode 0700 creation and cleanup on exit
GUEST_ROOT="$TEST_DIR/root_mode"
create_guest_root "$GUEST_ROOT"
MODE_FILE="$TEST_DIR/dir_mode"
invoke_guest "$GUEST_ROOT" bash -c 'ls -ld "$1/run/codeapi-clock" | cut -c1-10 > "$2"' -- "$GUEST_ROOT" "$MODE_FILE"
[[ "$(cat "$MODE_FILE")" == "drwx------" ]]
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 4. Gating: API is never started before trusted clock synchronization is ready
GUEST_ROOT="$TEST_DIR/root_gate"
create_guest_root "$GUEST_ROOT"
SYNC_TRIGGER="$TEST_DIR/sync_proceed"
API_CALLED="$TEST_DIR/api_called_gate"

TEST_SYNC_STARTED_FILE="$TEST_DIR/sync_started" \
TEST_DELAY_SYNC_FILE="$SYNC_TRIGGER" invoke_guest "$GUEST_ROOT" touch "$API_CALLED" &
gate_pid=$!

# Wait until chronyd has created the socket and chronyc is waiting on the trigger
while [[ ! -e "$TEST_DIR/sync_started" ]]; do
    if ! kill -0 "$gate_pid" 2>/dev/null; then
        echo "supervisor died unexpectedly during gating setup" >&2
        exit 1
    fi
    sleep 0.05
done

# chronyc is now definitely blocked on synchronization, not merely unscheduled.
[[ ! -e "$API_CALLED" ]]

# Release synchronization and verify API now executes and completes
touch "$SYNC_TRIGGER"
wait "$gate_pid"
[[ -e "$API_CALLED" ]]
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 5. Startup synchronization failure prevents API from starting and cleans up
GUEST_ROOT="$TEST_DIR/root_sync_fail"
create_guest_root "$GUEST_ROOT"
API_CALLED="$TEST_DIR/api_called_sync_fail"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_sync_fail.pid"
if TEST_SYNC_FAIL=true \
   TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" \
   invoke_guest "$GUEST_ROOT" touch "$API_CALLED" 2>/dev/null; then
    echo "supervisor succeeded despite synchronization failure" >&2
    exit 1
fi
[[ ! -e "$API_CALLED" ]]
cpid="$(cat "$CHRONYD_PID_FILE" 2>/dev/null || true)"
if [[ -n "$cpid" ]] && kill -0 "$cpid" 2>/dev/null; then
    echo "chronyd was not terminated on sync failure" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 6. Chronyd early crash prevents API execution
GUEST_ROOT="$TEST_DIR/root_early_crash"
create_guest_root "$GUEST_ROOT"
API_CALLED="$TEST_DIR/api_called_early_crash"
if TEST_CHRONYD_CRASH_EARLY=true \
   invoke_guest "$GUEST_ROOT" touch "$API_CALLED" 2>/dev/null; then
    echo "supervisor succeeded despite chronyd early crash" >&2
    exit 1
fi
[[ ! -e "$API_CALLED" ]]
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 7. Normal API exit status propagation (0) and clean daemon shutdown
GUEST_ROOT="$TEST_DIR/root_code_0"
create_guest_root "$GUEST_ROOT"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_code_0.pid"
TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" invoke_guest "$GUEST_ROOT" bash -c "exit 0"
cpid="$(cat "$CHRONYD_PID_FILE")"
if kill -0 "$cpid" 2>/dev/null; then
    echo "chronyd was not cleaned up after normal API exit" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 8. Non-zero API exit status propagation (42) and clean daemon shutdown
GUEST_ROOT="$TEST_DIR/root_code_42"
create_guest_root "$GUEST_ROOT"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_code_42.pid"
set +e
TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" invoke_guest "$GUEST_ROOT" bash -c "exit 42"
rc=$?
set -e
[[ "$rc" -eq 42 ]]
cpid="$(cat "$CHRONYD_PID_FILE")"
if kill -0 "$cpid" 2>/dev/null; then
    echo "chronyd was not cleaned up after non-zero API exit" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 9. Clock daemon death terminates active API and returns non-zero
GUEST_ROOT="$TEST_DIR/root_daemon_death"
create_guest_root "$GUEST_ROOT"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_daemon_death.pid"
API_PID_FILE="$TEST_DIR/api_daemon_death.pid"
API_READY="$TEST_DIR/api_ready_daemon_death"

TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" \
invoke_guest "$GUEST_ROOT" bash -c 'echo $$ > "$1"; touch "$2"; while true; do sleep 0.05; done' -- "$API_PID_FILE" "$API_READY" &
sup_pid=$!

while [[ ! -e "$API_READY" ]]; do
    if ! kill -0 "$sup_pid" 2>/dev/null; then
        echo "supervisor died prematurely during daemon death setup" >&2
        exit 1
    fi
    sleep 0.05
done

api_pid="$(cat "$API_PID_FILE")"
chrony_pid="$(cat "$CHRONYD_PID_FILE")"
kill -0 "$api_pid"
kill -0 "$chrony_pid"

# Kill chronyd to simulate daemon crash
kill -9 "$chrony_pid"

set +e
wait "$sup_pid"
sup_rc=$?
set -e

if [[ "$sup_rc" -eq 0 ]]; then
    echo "supervisor returned zero exit code after clock daemon crash" >&2
    exit 1
fi

# The API process must have been terminated and not left running
if kill -0 "$api_pid" 2>/dev/null; then
    echo "API process was left alive after clock daemon crash" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 10. Clean signal termination (SIGTERM) to child process stops both daemon and API child
GUEST_ROOT="$TEST_DIR/root_sigterm"
create_guest_root "$GUEST_ROOT"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_sigterm.pid"
API_PID_FILE="$TEST_DIR/api_sigterm.pid"
API_READY="$TEST_DIR/api_ready_sigterm"

TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" \
invoke_guest "$GUEST_ROOT" bash -c 'echo $$ > "$1"; touch "$2"; while true; do sleep 0.05; done' -- "$API_PID_FILE" "$API_READY" &
sup_pid=$!

while [[ ! -e "$API_READY" ]]; do
    if ! kill -0 "$sup_pid" 2>/dev/null; then
        echo "supervisor died prematurely during sigterm setup" >&2
        exit 1
    fi
    sleep 0.05
done

api_pid="$(cat "$API_PID_FILE")"
chrony_pid="$(cat "$CHRONYD_PID_FILE")"
kill -0 "$api_pid"
kill -0 "$chrony_pid"

kill -TERM "$sup_pid"
set +e
wait "$sup_pid"
wait_rc=$?
set -e

[[ "$wait_rc" -eq 143 ]]

if kill -0 "$api_pid" 2>/dev/null; then
    echo "API process was left alive after supervisor SIGTERM" >&2
    exit 1
fi
if kill -0 "$chrony_pid" 2>/dev/null; then
    echo "chronyd was left alive after supervisor SIGTERM" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 11. Bounded shutdown handles stubborn child ignoring SIGTERM (SIGKILL fallback)
GUEST_ROOT="$TEST_DIR/root_stubborn"
create_guest_root "$GUEST_ROOT"
CHRONYD_PID_FILE="$TEST_DIR/chronyd_stubborn.pid"
API_PID_FILE="$TEST_DIR/api_stubborn.pid"
API_READY="$TEST_DIR/api_ready_stubborn"

TEST_CHRONYD_PID_FILE="$CHRONYD_PID_FILE" \
invoke_guest "$GUEST_ROOT" bash -c 'trap "" TERM; echo $$ > "$1"; touch "$2"; while true; do sleep 0.05; done' -- "$API_PID_FILE" "$API_READY" &
sup_pid=$!

while [[ ! -e "$API_READY" ]]; do
    if ! kill -0 "$sup_pid" 2>/dev/null; then
        echo "supervisor died prematurely during stubborn child setup" >&2
        exit 1
    fi
    sleep 0.05
done

api_pid="$(cat "$API_PID_FILE")"
chrony_pid="$(cat "$CHRONYD_PID_FILE")"
kill -0 "$api_pid"
kill -0 "$chrony_pid"

start_ts=$(date +%s)
kill -TERM "$sup_pid"
set +e
wait "$sup_pid"
wait_rc=$?
set -e
end_ts=$(date +%s)

[[ "$wait_rc" -eq 143 ]]

if kill -0 "$api_pid" 2>/dev/null; then
    echo "stubborn API child was not killed" >&2
    exit 1
fi
if kill -0 "$chrony_pid" 2>/dev/null; then
    echo "chronyd was left alive after stubborn child termination" >&2
    exit 1
fi
elapsed=$((end_ts - start_ts))
if [[ "$elapsed" -gt 5 ]]; then
    echo "shutdown took longer than bounded limit: ${elapsed}s" >&2
    exit 1
fi
[[ ! -e "$GUEST_ROOT/run/codeapi-clock" ]]

# 12. Missing command or missing config file fails cleanly without executing
GUEST_ROOT="$TEST_DIR/root_empty"
create_guest_root "$GUEST_ROOT"
if invoke_guest "$GUEST_ROOT" 2>/dev/null; then
    echo "accepted missing command" >&2
    exit 1
fi

GUEST_ROOT="$TEST_DIR/root_noconfig"
mkdir -p "$GUEST_ROOT/run"
if invoke_guest "$GUEST_ROOT" true 2>/dev/null; then
    echo "accepted missing chrony config" >&2
    exit 1
fi

printf 'guest clock lifecycle checks passed\n'
