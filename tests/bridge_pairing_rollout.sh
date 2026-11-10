#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
rollback="$ROOT/helm/codeapi/scripts/safe-pairing-rollback.sh"
deployment="$TMP_DIR/api.yaml"

# Assert on rendered behavior, independent of values ordering/template helpers.
mkdir "$TMP_DIR/chart"
cp "$ROOT/helm/codeapi/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$ROOT/helm/codeapi/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' "$ROOT/helm/codeapi/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"
render() {
  helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --show-only templates/api-deployment.yaml "$@"
}
render > "$deployment"
if ! grep -q '^    type: Recreate$' "$deployment" ||
   grep -q '^    rollingUpdate:' "$deployment"; then
  echo 'API rollouts must default to Recreate and clear rollingUpdate' >&2
  exit 1
fi
if ! grep -q 'codeapi.librechat.ai/pairing-fence-version: "1"' "$deployment"; then
  echo 'the first pairing-fence chart upgrade must revise the API pod template' >&2
  exit 1
fi
if ! grep -q 'imagePullPolicy: Always' "$deployment"; then
  echo 'the fenced API rollout must pull the current image even when the default tag is mutable' >&2
  exit 1
fi
render --set api.strategy.type=RollingUpdate \
  --set api.strategy.rollingUpdate.maxSurge=1 > "$TMP_DIR/override.yaml"
if ! grep -q '^    type: RollingUpdate$' "$TMP_DIR/override.yaml" ||
   ! grep -q '^      maxSurge: 1$' "$TMP_DIR/override.yaml"; then
  echo 'the API Deployment must render an explicit api.strategy override' >&2
  exit 1
fi
if [[ ! -x "$rollback" ]]; then
  echo 'the pairing-safe rollback helper must be executable' >&2
  exit 1
fi
bash -n "$rollback"
if "$rollback" codeapi 1 default --kube-context other >/dev/null 2>&1; then
  echo 'rollback must reject a Helm context that differs from the kubectl drain' >&2
  exit 1
fi
if "$rollback" codeapi 1 default --kubeconfig=/tmp/other >/dev/null 2>&1; then
  echo 'rollback must reject a Helm kubeconfig that differs from the kubectl drain' >&2
  exit 1
fi
if HELM_KUBECONTEXT=other "$rollback" codeapi 1 default >/dev/null 2>&1; then
  echo 'rollback must reject a Helm context inherited from the environment' >&2
  exit 1
fi
if ! grep -q 'delete horizontalpodautoscaler' "$rollback" ||
  ! grep -q 'scale "$deployment" --replicas=0' "$rollback" ||
  ! grep -q -- '--for=delete' "$rollback" ||
  ! grep -q 'create configmap "$rollback_config_map"' "$rollback" ||
  ! grep -q 'replica_state=' "$rollback" ||
  ! grep -q 'discover_api_deployments' "$rollback" ||
  ! grep -q 'list_api_pods' "$rollback" ||
  ! grep -q '^  drain_api delete$' "$rollback" ||
  ! grep -q 'recover_interrupted_rollback' "$rollback" ||
  ! grep -q 'helm rollback' "$rollback"; then
  echo 'rollback must record an epoch, remove autoscaling, verify the drain, and fail closed' >&2
  exit 1
fi
if ! grep -q 'CODEAPI_BRIDGE_PAIRING_ROLLBACK_EPOCH' "$deployment" ||
  ! grep -q 'optional: true' "$deployment"; then
  echo 'the API Deployment must consume the optional rollback epoch' >&2
  exit 1
fi
