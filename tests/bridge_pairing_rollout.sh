#!/usr/bin/env bash
set -euo pipefail

values=helm/codeapi/values.yaml
deployment=helm/codeapi/templates/api-deployment.yaml

if ! grep -A 7 '^api:$' "$values" | grep -q '^  strategy:$'; then
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
