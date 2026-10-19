#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
command -v helm >/dev/null

# Render only this chart's templates so the test does not download the Redis
# or MinIO dependencies.
mkdir "$TMP_DIR/chart"
cp "$ROOT/helm/codeapi/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$ROOT/helm/codeapi/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' "$ROOT/helm/codeapi/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"

render() {
    helm template redis-tls "$TMP_DIR/chart" \
        --set executionManifest.privateKey=test \
        --set executionManifest.publicKey=test "$@"
}

# Print "<container> <env name>" for every REDIS_TLS* / alternative DNS env var.
redis_tls_env() {
    awk '
        /^        - name: / { container=$3 }
        /^            - name: REDIS_TLS$/ { print container, $3 }
        /^            - name: REDIS_USE_ALTERNATIVE_DNS_LOOKUP$/ { print container, $3 }
    ' "$1" | sort
}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# External Redis with TLS: exactly the five control-plane containers get both
# vars; sandbox-runner must never receive Redis configuration.
render --set redis.enabled=false \
    --set redis.external.host=redis.example.com \
    --set redis.external.tls=true \
    --set redis.external.useAlternativeDnsLookup=true > "$TMP_DIR/tls.yaml"
expected="$(for c in api egress-gateway file-server service-worker tool-call-server; do
    echo "$c REDIS_TLS"
    echo "$c REDIS_USE_ALTERNATIVE_DNS_LOOKUP"
done | sort)"
actual="$(redis_tls_env "$TMP_DIR/tls.yaml")"
[ "$actual" = "$expected" ] || fail "unexpected Redis TLS env placement:
$actual"
if awk '/^        - name: sandbox-runner$/{s=1;next} /^        - name: /{s=0} s && /REDIS_/' "$TMP_DIR/tls.yaml" | grep -q .; then
    fail "sandbox-runner received REDIS_* env"
fi

# Each option is independent.
render --set redis.enabled=false --set redis.external.host=x \
    --set redis.external.tls=true > "$TMP_DIR/tls-only.yaml"
[ "$(redis_tls_env "$TMP_DIR/tls-only.yaml" | grep -c ' REDIS_TLS$')" = 5 ] \
    || fail "redis.external.tls did not render REDIS_TLS on all five containers"
! redis_tls_env "$TMP_DIR/tls-only.yaml" | grep -q REDIS_USE_ALTERNATIVE_DNS_LOOKUP \
    || fail "REDIS_USE_ALTERNATIVE_DNS_LOOKUP rendered without useAlternativeDnsLookup"

# TLS is ignored for the bundled subchart, which has no TLS.
render --set redis.enabled=true --set redis.external.tls=true \
    --set redis.external.useAlternativeDnsLookup=true > "$TMP_DIR/bundled.yaml"
[ -z "$(redis_tls_env "$TMP_DIR/bundled.yaml")" ] \
    || fail "bundled Redis must not get REDIS_TLS"

# Defaults and older values files without redis.external render no TLS env.
render > "$TMP_DIR/default.yaml"
[ -z "$(redis_tls_env "$TMP_DIR/default.yaml")" ] || fail "default render sets Redis TLS env"
render --set redis.external=null > "$TMP_DIR/no-external.yaml"
cmp -s "$TMP_DIR/default.yaml" "$TMP_DIR/no-external.yaml" \
    || fail "render without redis.external differs from default"

echo 'PASS: Redis TLS env reaches every control-plane Redis client and never sandbox-runner'
