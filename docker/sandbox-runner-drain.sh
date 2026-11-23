#!/usr/bin/env bash
set -euo pipefail

# This directory stays on the host; it is not mounted into the guest or jobs.
state_dir="${SANDBOX_DRAIN_STATE_DIR:-/run/codeapi-drain}"
if [[ "${1:-}" == init ]]; then
    umask 077
    mkdir -p "$state_dir"
    openssl genpkey -algorithm ED25519 -out "$state_dir/private.pem"
    openssl pkey -in "$state_dir/private.pem" -pubout -outform DER | base64 | tr -d '\n' > "$state_dir/public.b64"
    printf %s codeapi-runner-drain-v1 > "$state_dir/message"
    exit 0
fi

timeout_ms="${SANDBOX_DRAIN_TIMEOUT_MS:-45000}"
[[ "$timeout_ms" =~ ^[1-9][0-9]{0,8}$ ]] || { echo 'Invalid SANDBOX_DRAIN_TIMEOUT_MS' >&2; exit 1; }
signature="$(openssl pkeyutl -sign -rawin -inkey "$state_dir/private.pem" -in "$state_dir/message" | base64 | tr -d '\n')"
exec curl --fail --silent --show-error --max-time "$(( (timeout_ms + 999) / 1000 + 5 ))" \
    -X POST -H "X-CodeAPI-Drain-Signature: $signature" \
    "http://127.0.0.1:${PORT:-2000}/api/v2/drain"
