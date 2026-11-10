#!/bin/bash
set -e

KVM_ENABLED="${KVM_ENABLED:-true}"

if [[ "${SANDBOX_GRACEFUL_DRAIN_ENABLED:-false}" == true ]]; then
    /usr/local/bin/sandbox-runner-drain.sh init
    export SANDBOX_DRAIN_PUBLIC_KEY="$(cat "${SANDBOX_DRAIN_STATE_DIR:-/run/codeapi-drain}/public.b64")"
fi

if [ "$KVM_ENABLED" = "true" ]; then
    exec /usr/local/bin/launcher-entrypoint.sh "$@"
fi

exec /usr/local/bin/start-direct-sandbox.sh "$@"
