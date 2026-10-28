#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -r "$TMP_DIR"' EXIT
mkdir "$TMP_DIR/chart"
cp "$ROOT/helm/codeapi/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$ROOT/helm/codeapi/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' "$ROOT/helm/codeapi/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"
render() {
    helm template runtime-rollout "$TMP_DIR/chart" \
        --show-only templates/package-init-job.yaml \
        --set executionManifest.privateKey=test \
        --set executionManifest.publicKey=test \
        --set workerSandbox.enabled=true \
        --set workerSandbox.packages.source=pvc "$@"
}
# The hook installs the runtime selected by service requests.
render | grep -A 1 'name: NODE_VERSION' | grep -q 'value: "24.22.1"'
render | grep -A 1 'name: BUN_VERSION' | grep -q 'value: "1.4.4"'
# Explicit runtime selections still override the chart default.
render --set workerSandbox.packages.initJob.nodeVersion=24.22.0 \
    | grep -A 1 'name: NODE_VERSION' | grep -q 'value: "24.22.0"'
# Default mutable image must refresh on every pre-install/pre-upgrade hook.
render | grep -q 'imagePullPolicy: Always'
# Reused historical values must not bypass the runtime migration.
render --set workerSandbox.packages.initJob.image.pullPolicy=IfNotPresent \
    | grep -q 'imagePullPolicy: Always'
# Immutable release images retain their explicitly configured cache policy.
render --set workerSandbox.packages.initJob.image.tag=release-123 \
    --set workerSandbox.packages.initJob.image.pullPolicy=IfNotPresent \
    | grep -q 'imagePullPolicy: IfNotPresent'
# Local kind/minikube builds are deliberately loaded without a registry.
render -f "$ROOT/helm/codeapi/values-local.yaml" | grep -q 'imagePullPolicy: Never'
render --set workerSandbox.packages.initJob.image.pullPolicy=Never \
    | grep -q 'imagePullPolicy: Never'
echo 'PASS: package-init refreshes cached latest and preserves offline images'
