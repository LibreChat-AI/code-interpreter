#!/usr/bin/env bash
set -euo pipefail

values=helm/codeapi/values.yaml
deployment=helm/codeapi/templates/api-deployment.yaml
rollback=helm/codeapi/scripts/safe-pairing-rollback.sh

if ! grep -A 12 '^api:$' "$values" | grep -q '^  strategy:$'; then
  echo 'api.strategy must be configured for pairing-safe rollouts' >&2
  exit 1
fi
if ! grep -A 2 '^  strategy:$' "$values" | grep -q '^    type: Recreate$'; then
  echo 'api.strategy.type must default to Recreate while pre-fence replicas may exist' >&2
  exit 1
fi
if ! grep -A 3 '^  strategy:$' "$values" | grep -q '^    rollingUpdate: null$'; then
  echo 'api.strategy must clear rollingUpdate when switching existing deployments to Recreate' >&2
  exit 1
fi
if ! grep -q 'toYaml .Values.api.strategy' "$deployment"; then
  echo 'the API Deployment must render api.strategy' >&2
  exit 1
fi
if ! grep -q 'codeapi.librechat.ai/pairing-fence-version: "1"' "$deployment"; then
  echo 'the first pairing-fence chart upgrade must revise the API pod template' >&2
  exit 1
fi
if ! grep -A 8 '^  image:$' "$values" | grep -q '^    pullPolicy: Always$'; then
  echo 'the fenced API rollout must pull the current image even when the default tag is mutable' >&2
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
if ! grep -q 'delete horizontalpodautoscaler' "$rollback" ||
  ! grep -q 'scale "$deployment" --replicas=0' "$rollback" ||
  ! grep -q -- '--for=delete' "$rollback" ||
  ! grep -q 'create configmap "$rollback_config_map"' "$rollback" ||
  ! grep -q 'replica_state=' "$rollback" ||
  ! grep -q 'discover_api_deployments' "$rollback" ||
  ! grep -q 'list_api_pods' "$rollback" ||
  ! grep -q '^  drain_api delete$' "$rollback" ||
  ! grep -q 'helm rollback' "$rollback"; then
  echo 'rollback must record an epoch, remove autoscaling, verify the drain, and fail closed' >&2
  exit 1
fi
if ! grep -q 'CODEAPI_BRIDGE_PAIRING_ROLLBACK_EPOCH' "$deployment" ||
  ! grep -q 'optional: true' "$deployment"; then
  echo 'the API Deployment must consume the optional rollback epoch' >&2
  exit 1
fi
