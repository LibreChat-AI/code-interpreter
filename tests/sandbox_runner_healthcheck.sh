#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"

cat > "$TMP_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${TEST_CURL_FAIL:-false}" == "true" ]]; then
    exit 22
fi

if [[ -n "${TEST_EXPECTED_URL:-}" && "${!#}" != "$TEST_EXPECTED_URL" ]]; then
    printf 'unexpected healthcheck URL: %s\n' "${!#}" >&2
    exit 2
fi

printf 'HTTP/1.1 200 OK\r\n'
if [[ -n "${TEST_GUEST_DATE:-}" ]]; then
    printf 'Date: %s\r\n' "$TEST_GUEST_DATE"
fi
printf '\r\n'
EOF

cat > "$TMP_DIR/bin/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 2 && "$1" == "-u" && "$2" == "+%s" ]]; then
    if [[ -e "${TEST_HOST_SAMPLE_STATE:?}" ]]; then
        printf '%s\n' "${TEST_HOST_AFTER_SECONDS:?}"
    else
        : > "$TEST_HOST_SAMPLE_STATE"
        printf '%s\n' "${TEST_HOST_BEFORE_SECONDS:?}"
    fi
    exit 0
fi

if [[ "$#" -eq 4 && "$1" == "-u" && "$2" == "-d" && "$4" == "+%s" ]]; then
    if [[ "${TEST_GUEST_DATE_INVALID:-false}" == "true" ]]; then
        exit 1
    fi
    printf '%s\n' "${TEST_GUEST_SECONDS:?}"
    exit 0
fi

printf 'unexpected date arguments: %q\n' "$*" >&2
exit 2
EOF

cat > "$TMP_DIR/bin/cksum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cat >/dev/null
printf '%s 1\n' "${TEST_CKSUM:-0}"
EOF

chmod +x "$TMP_DIR/bin/curl" "$TMP_DIR/bin/date" "$TMP_DIR/bin/cksum"

run_check() {
    rm -f "$TMP_DIR/host-sample"
    env \
        PATH="$TMP_DIR/bin:$PATH" \
        SANDBOX_RUNNER_FD_LIVENESS_LIMIT=0 \
        SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS=0 \
        TEST_HOST_BEFORE_SECONDS=100 \
        TEST_HOST_AFTER_SECONDS=100 \
        TEST_HOST_SAMPLE_STATE="$TMP_DIR/host-sample" \
        TEST_GUEST_DATE='Tue, 04 Aug 2026 08:00:00 GMT' \
        TEST_EXPECTED_URL='http://127.0.0.1:2000/api/v2/health' \
        "$@" \
        bash -c 'exec bash "$1" "${TEST_PROBE_ARGUMENT:-}"' _ "$ROOT/docker/sandbox-runner-healthcheck.sh"
}

run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=0 \
    TEST_PROBE_ARGUMENT=--ready \
    TEST_EXPECTED_URL='http://127.0.0.1:2000/api/v2/ready'

run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_SECONDS=91

# A guest timestamp inside the host interval is healthy even when either
# individual host sample differs by more than the configured limit.
run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=1 \
    TEST_HOST_BEFORE_SECONDS=100 \
    TEST_HOST_AFTER_SECONDS=104 \
    TEST_GUEST_SECONDS=102

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_SECONDS=90 2> "$TMP_DIR/backward.log"; then
    echo "healthcheck accepted guest clock at the backward-skew limit" >&2
    exit 1
fi
grep -F 'guest clock skew is -10s, pod limit is 10s (configured maximum 10s)' "$TMP_DIR/backward.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_SECONDS=110 2> "$TMP_DIR/forward.log"; then
    echo "healthcheck accepted guest clock at the forward-skew limit" >&2
    exit 1
fi
grep -F 'guest clock skew is 10s, pod limit is 10s (configured maximum 10s)' "$TMP_DIR/forward.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS=2 \
    TEST_CKSUM=2 \
    TEST_GUEST_SECONDS=92 2> "$TMP_DIR/jitter.log"; then
    echo "healthcheck did not apply its deterministic per-pod threshold" >&2
    exit 1
fi
grep -F 'guest clock skew is -8s, pod limit is 8s (configured maximum 10s)' "$TMP_DIR/jitter.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_DATE= \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/missing.log"; then
    echo "healthcheck accepted a response without a Date header" >&2
    exit 1
fi
grep -F 'guest response is missing the HTTP Date header' "$TMP_DIR/missing.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_DATE_INVALID=true \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/malformed.log"; then
    echo "healthcheck accepted a malformed Date header" >&2
    exit 1
fi
grep -F 'guest returned an invalid HTTP Date header' "$TMP_DIR/malformed.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_GUEST_DATE=now \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/non-http-date.log"; then
    echo "healthcheck accepted a GNU-date-parseable value that is not an HTTP-date" >&2
    exit 1
fi
grep -F 'guest returned an invalid HTTP Date header: now' "$TMP_DIR/non-http-date.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    TEST_CURL_FAIL=true \
    TEST_GUEST_SECONDS=100; then
    echo "healthcheck accepted a failed guest request" >&2
    exit 1
fi

run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=0 \
    TEST_GUEST_DATE= \
    TEST_GUEST_SECONDS=100

# Compose and standalone Docker callers only observe health status, so the
# clock-skew guard stays disabled unless an orchestrator explicitly opts in.
run_check \
    TEST_GUEST_DATE= \
    TEST_GUEST_SECONDS=100

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=invalid \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/invalid.log"; then
    echo "healthcheck accepted an invalid clock-skew limit" >&2
    exit 1
fi
grep -F 'invalid SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS: invalid' "$TMP_DIR/invalid.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=08 \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/leading-zero.log"; then
    echo "healthcheck accepted a non-canonical clock-skew limit" >&2
    exit 1
fi
grep -F 'expected a canonical non-negative integer' "$TMP_DIR/leading-zero.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=9223372036854775807 \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/overflow-limit.log"; then
    echo "healthcheck accepted a clock-skew limit that could overflow arithmetic" >&2
    exit 1
fi
grep -F 'plus SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be less than the 30-second execution-manifest tolerance' "$TMP_DIR/overflow-limit.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=25 \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/unsafe-limit.log"; then
    echo "healthcheck accepted a limit without request-latency headroom" >&2
    exit 1
fi
grep -F 'plus SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be less than the 30-second execution-manifest tolerance' "$TMP_DIR/unsafe-limit.log" >/dev/null

if run_check \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS=10 \
    SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS=0 \
    TEST_GUEST_SECONDS=100 2> "$TMP_DIR/zero-timeout.log"; then
    echo "healthcheck accepted a zero request timeout" >&2
    exit 1
fi
grep -F 'SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be greater than zero' "$TMP_DIR/zero-timeout.log" >/dev/null

echo "sandbox-runner healthcheck checks passed"
