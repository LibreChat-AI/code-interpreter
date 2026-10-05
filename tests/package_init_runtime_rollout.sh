#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render() {
    helm template runtime-rollout "$ROOT/helm/codeapi" \
        --show-only templates/package-init-job.yaml \
        --set workerSandbox.enabled=true \
        --set workerSandbox.packages.source=pvc "$@"
}
# Default mutable image must refresh on every pre-install/pre-upgrade hook.
render | grep -q 'imagePullPolicy: Always'
# Reused historical values must not bypass the runtime migration.
render --set workerSandbox.packages.initJob.image.pullPolicy=IfNotPresent \
    | grep -q 'imagePullPolicy: Always'
# Immutable release images retain their explicitly configured cache policy.
render --set workerSandbox.packages.initJob.image.tag=release-123 \
    --set workerSandbox.packages.initJob.image.pullPolicy=IfNotPresent \
    | grep -q 'imagePullPolicy: IfNotPresent'
echo 'PASS: package-init refreshes latest even with reused legacy values'
