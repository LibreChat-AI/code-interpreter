#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

# Exercise the production cleanup function without booting a MicroVM.
sed -n '/^cleanup() {/,/^trap cleanup SIGTERM SIGINT/p' "$repo_root/docker/supervisor.sh" \
    | sed '$d' > "$fixture_dir/cleanup.sh"
cat > "$fixture_dir/fixture.sh" <<'FIXTURE'
#!/usr/bin/env bash
set -u
CLEANUP_IN_PROGRESS=false
source "$1/cleanup.sh"
fixture_dir="$1"

sleep 30 &
SANDBOX_PID=$!
(
    trap '
        sleep 0.1
        if kill -0 "$SANDBOX_PID" 2>/dev/null \
            && [ "$(awk '\''{print $3}'\'' "/proc/$SANDBOX_PID/stat")" != Z ]; then
            touch "$fixture_dir/drained"
        fi
        exit 0
    ' TERM
    touch "$fixture_dir/ready"
    while true; do sleep 0.01; done
) &
WORKER_PID=$!
while [ ! -f "$fixture_dir/ready" ]; do sleep 0.01; done
cleanup
FIXTURE

timeout 5 bash "$fixture_dir/fixture.sh" "$fixture_dir"
test -f "$fixture_dir/drained"
echo 'Worker drained before sandbox shutdown.'

for entry in docker-compose.yaml:service-worker docker-compose.scalable.yml:worker-sandbox docker-compose.local-dev.yml:service; do
    docker compose -f "$repo_root/${entry%:*}" config --format json \
        | python3 -c '
import json, sys
worker = json.load(sys.stdin)["services"][sys.argv[1]]
assert worker["stop_grace_period"] == "6m40s", worker["stop_grace_period"]
assert "CODEAPI_SHUTDOWN_TIMEOUT_MS" in worker["environment"]
' "${entry#*:}"
done
echo 'Compose worker stop grace permits the default execution and cleanup budget.'
