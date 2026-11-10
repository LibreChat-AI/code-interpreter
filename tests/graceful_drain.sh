#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_CHART="${1:-$ROOT/helm/codeapi}"
PREFIX="${2:-}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Render without optional database subcharts or network dependency downloads.
mkdir "$TMP_DIR/chart"
cp "$SOURCE_CHART/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$SOURCE_CHART/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' "$SOURCE_CHART/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"

render() {
    local args=(
        --set "${PREFIX}workerSandbox.enabled=true"
        --set "${PREFIX}egressGateway.enabled=true"
        --set "${PREFIX}executionManifest.publicKey=test"
    )
    if [[ -n "$PREFIX" ]]; then
        args+=(--set "${PREFIX}executionManifest.privateKeySecretName=test")
    else
        args+=(--set executionManifest.privateKey=test)
    fi
    helm template drain "$TMP_DIR/chart" "${args[@]}" "$@"
}

runner() {
    awk '
        function emit() { if (kind && name) printf "%s", document }
        /^---$/ { emit(); document=""; kind=0; name=0; next }
        { document=document $0 "\n" }
        /^kind: Deployment$/ { kind=1 }
        /^  name: .*sandbox-runner$/ { name=1 }
        END { emit() }
    '
}

render | runner > "$TMP_DIR/off.yaml"
if grep -Eq 'preStop:|terminationGracePeriodSeconds:|SANDBOX_DRAIN_|SANDBOX_GRACEFUL_DRAIN_ENABLED|--ready' "$TMP_DIR/off.yaml"; then
    echo 'disabled drain must preserve the previous lifecycle' >&2
    exit 1
fi
render --set "${PREFIX}workerSandbox.sandboxRunner.gracefulDrain.enabled=true" | runner > "$TMP_DIR/on.yaml"
for expected in 'terminationGracePeriodSeconds: 60' 'preStop:' '/usr/local/bin/sandbox-runner-drain.sh' 'SANDBOX_GRACEFUL_DRAIN_ENABLED' 'SANDBOX_DRAIN_TIMEOUT_MS' 'value: "45000"' 'value: "5000"' 'value: "1"' '- --ready'; do
    grep -Fq -- "$expected" "$TMP_DIR/on.yaml" || { echo "missing drain contract: $expected" >&2; exit 1; }
done
# The existing host FD/guest clock check remains both liveness and readiness.
[[ "$(grep -Fc '/usr/local/bin/sandbox-runner-healthcheck.sh' "$TMP_DIR/on.yaml")" == 2 ]]
[[ "$(grep -Fc -- '- --ready' "$TMP_DIR/on.yaml")" == 1 ]]

for invalid in timeoutSeconds=0 timeoutSeconds=-1 timeoutSeconds=1.5 minDelaySeconds=46 minDelaySeconds=6 retryAfterSeconds=0 retryAfterSeconds=6 terminationGracePeriodSeconds=50; do
    if render --set "${PREFIX}workerSandbox.sandboxRunner.gracefulDrain.enabled=true" \
        --set "${PREFIX}workerSandbox.sandboxRunner.gracefulDrain.$invalid" > /dev/null 2> "$TMP_DIR/error"; then
        echo "accepted invalid drain budget: $invalid" >&2
        exit 1
    fi
    grep -Fq gracefulDrain "$TMP_DIR/error"
done
if [[ -n "$PREFIX" ]]; then
    override="${PREFIX}workerSandbox.sandboxEnv.SANDBOX_DRAIN_TIMEOUT_MS=1"
else
    override='workerSandbox.sandboxExtraEnv[0].name=SANDBOX_DRAIN_TIMEOUT_MS'
fi
if render --set "$override" > /dev/null 2> "$TMP_DIR/error"; then
    echo 'accepted a drain environment override outside the validated settings' >&2
    exit 1
fi
grep -Fq gracefulDrain "$TMP_DIR/error"
echo 'Graceful drain chart regressions passed'
