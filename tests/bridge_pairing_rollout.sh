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
if ! grep -q 'delete horizontalpodautoscaler' "$rollback" ||
  ! grep -q 'scale "$deployment" --replicas=0' "$rollback" ||
  ! grep -q -- '--for=delete' "$rollback" ||
  ! grep -q 'helm rollback' "$rollback"; then
  echo 'rollback must remove autoscaling, drain API pods, then invoke Helm' >&2
  exit 1
fi
