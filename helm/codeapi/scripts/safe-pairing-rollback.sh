#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 RELEASE REVISION [NAMESPACE] [helm rollback flags...]" >&2
  exit 64
}

release=${1:-}
revision=${2:-}
namespace=${3:-default}
if [[ -z "$release" || ! "$revision" =~ ^[1-9][0-9]*$ ]]; then
  usage
fi
shift $(( $# >= 3 ? 3 : $# ))

if [[ ! "$release" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "invalid Helm release name: $release" >&2
  exit 64
fi
if [[ ! "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "invalid Kubernetes namespace: $namespace" >&2
  exit 64
fi
for flag in "$@"; do
  case "$flag" in
    -n|-n?*|--namespace|--namespace=*|--kube-context|--kube-context=*|\
    --kubeconfig|--kubeconfig=*|--kube-apiserver|--kube-apiserver=*|\
    --kube-ca-file|--kube-ca-file=*|--kube-token|--kube-token=*|\
    --kube-tls-server-name|--kube-tls-server-name=*|\
    --kube-as-user|--kube-as-user=*|--kube-as-group|--kube-as-group=*|\
    --kube-insecure-skip-tls-verify|--kube-insecure-skip-tls-verify=*)
      echo "refusing target-changing Helm rollback flag: $flag" >&2
      exit 64
      ;;
  esac
done
for variable in \
  HELM_KUBEAPISERVER \
  HELM_KUBEASGROUPS \
  HELM_KUBEASUSER \
  HELM_KUBECAFILE \
  HELM_KUBECONTEXT \
  HELM_KUBEINSECURE_SKIP_TLS_VERIFY \
  HELM_KUBETLS_SERVER_NAME \
  HELM_KUBETOKEN \
  HELM_NAMESPACE; do
  if [[ -n ${!variable:-} ]]; then
    echo "refusing Helm target override from environment: $variable" >&2
    exit 64
  fi
done

timeout=${CODEAPI_ROLLBACK_TIMEOUT:-10m}
selector="app.kubernetes.io/instance=${release},app.kubernetes.io/component=api"

discover_api_deployments() {
  local output
  output=$(kubectl --namespace "$namespace" get deployment \
    --selector "$selector" --output name) || return
  deployments=()
  if [[ -n "$output" ]]; then
    mapfile -t deployments <<< "$output"
  fi
}

list_api_pods() {
  local output
  output=$(kubectl --namespace "$namespace" get pod \
    --selector "$selector" --output name) || return
  pods=()
  if [[ -n "$output" ]]; then
    mapfile -t pods <<< "$output"
  fi
}

discover_api_deployments
if (( ${#deployments[@]} != 1 )); then
  echo "expected exactly one Code API deployment for $selector" >&2
  exit 1
fi
deployment=${deployments[0]}

fence=$(kubectl --namespace "$namespace" get "$deployment" \
  --output 'jsonpath={.spec.template.metadata.annotations.codeapi\.librechat\.ai/pairing-fence-version}')
if [[ -z "$fence" ]]; then
  echo "refusing rollback: the live API deployment has no pairing fence" >&2
  exit 1
fi

deployment_name=${deployment#*/}
rollback_config_map=${deployment_name%-api}-pairing-rollback
rollback_epoch="$(date +%s)-${RANDOM}-${RANDOM}"

echo "Recording pairing rollback epoch $rollback_epoch..." >&2
kubectl --namespace "$namespace" create configmap "$rollback_config_map" \
  --from-literal="epoch=$rollback_epoch" --dry-run=client --output yaml | \
  kubectl --namespace "$namespace" apply --filename -

drain_api() {
  local pod_action=${1:-wait}
  local replica_state desired current ready available updated

  # Helm may have partially installed a target with a different fullname.
  # Resolve every matching API Deployment on each drain attempt.
  discover_api_deployments
  if (( ${#deployments[@]} == 0 )) && [[ "$pod_action" != delete ]]; then
    echo "refusing rollback: no API deployment matched $selector" >&2
    return 1
  fi

  echo "Deleting API autoscalers before the rollback fence is lowered..." >&2
  kubectl --namespace "$namespace" delete horizontalpodautoscaler \
    --selector "$selector" --ignore-not-found --wait=true

  echo "Scaling the fenced API deployment to zero..." >&2
  for deployment in "${deployments[@]}"; do
    kubectl --namespace "$namespace" scale "$deployment" --replicas=0
    kubectl --namespace "$namespace" rollout status "$deployment" \
      --timeout "$timeout"
  done

  list_api_pods
  if (( ${#pods[@]} > 0 )); then
    if [[ "$pod_action" == delete ]]; then
      kubectl --namespace "$namespace" delete pod \
        --selector "$selector" --wait=true --timeout "$timeout"
    else
      kubectl --namespace "$namespace" wait "${pods[@]}" \
        --for=delete --timeout "$timeout"
    fi
  fi

  # Relist immediately before Helm can lower the fence. This catches a new
  # matching pod that appeared after the first snapshot.
  discover_api_deployments
  for deployment in "${deployments[@]}"; do
    replica_state=$(kubectl --namespace "$namespace" get "$deployment" \
      --output 'jsonpath={.spec.replicas},{.status.replicas},{.status.readyReplicas},{.status.availableReplicas},{.status.updatedReplicas}') || return
    IFS=, read -r desired current ready available updated <<< "$replica_state"
    if [[ ${desired:-0} != 0 || ${current:-0} != 0 || ${ready:-0} != 0 ||
      ${available:-0} != 0 || ${updated:-0} != 0 ]]; then
      echo "refusing rollback: API deployment did not converge to zero replicas" >&2
      return 1
    fi
  done
  list_api_pods
  if (( ${#pods[@]} > 0 )); then
    echo "refusing rollback: API pods appeared after the drain" >&2
    return 1
  fi
}

drain_api wait

echo "All fenced API pods are gone; starting Helm rollback..." >&2
rollback_pid=
recover_interrupted_rollback() {
  local exit_status=$1
  trap - HUP INT TERM
  if [[ -n "$rollback_pid" ]]; then
    kill -TERM "$rollback_pid" 2>/dev/null || true
    wait "$rollback_pid" 2>/dev/null || true
  fi
  echo "Helm rollback interrupted; restoring the fail-closed API drain..." >&2
  set -e
  drain_api delete
  exit "$exit_status"
}
trap 'recover_interrupted_rollback 129' HUP
trap 'recover_interrupted_rollback 130' INT
trap 'recover_interrupted_rollback 143' TERM

helm rollback "$release" "$revision" \
  --namespace "$namespace" --wait --wait-for-jobs --timeout "$timeout" "$@" &
rollback_pid=$!
set +e
wait "$rollback_pid"
rollback_status=$?
set -e
rollback_pid=
trap - HUP INT TERM

if (( rollback_status == 0 )); then
  exit 0
else
  echo "Helm rollback failed; restoring the fail-closed API drain..." >&2
  drain_api delete
  exit "$rollback_status"
fi
