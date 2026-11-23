#!/bin/bash
set -euo pipefail

fd_limit="${SANDBOX_RUNNER_FD_LIVENESS_LIMIT:-40000}"
clock_skew_limit_seconds="${SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS:-0}"
clock_skew_jitter_seconds="${SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS:-2}"
timeout_seconds="${SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS:-5}"
manifest_clock_tolerance_seconds=30
port="${PORT:-2000}"
url="${SANDBOX_RUNNER_HEALTHCHECK_URL:-http://127.0.0.1:${port}/api/v2/health}"
if [[ "${1:-}" == "--ready" ]]; then
    url="http://127.0.0.1:${port}/api/v2/ready"
fi

validate_non_negative_integer() {
    local name="$1"
    local value="$2"

    case "$value" in
        0|[1-9]|[1-9][0-9]*) ;;
        *)
            echo "invalid ${name}: ${value} (expected a canonical non-negative integer)" >&2
            exit 2
            ;;
    esac
}

validate_non_negative_integer SANDBOX_RUNNER_FD_LIVENESS_LIMIT "$fd_limit"
validate_non_negative_integer \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS \
    "$clock_skew_limit_seconds"
validate_non_negative_integer \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS \
    "$clock_skew_jitter_seconds"
validate_non_negative_integer \
    SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS \
    "$timeout_seconds"

if [ "$timeout_seconds" -eq 0 ]; then
    echo "SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be greater than zero" >&2
    exit 2
fi

if [ "$clock_skew_limit_seconds" -gt 0 ]; then
    if [ "${#clock_skew_limit_seconds}" -gt 2 ] || \
        [ "$clock_skew_limit_seconds" -ge "$manifest_clock_tolerance_seconds" ]; then
        echo "SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS plus SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be less than the ${manifest_clock_tolerance_seconds}-second execution-manifest tolerance" >&2
        exit 2
    fi

    remaining_tolerance_seconds=$((manifest_clock_tolerance_seconds - clock_skew_limit_seconds))
    if [ "${#timeout_seconds}" -gt 2 ] || \
        [ "$timeout_seconds" -ge "$remaining_tolerance_seconds" ]; then
        echo "SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS plus SANDBOX_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS must be less than the ${manifest_clock_tolerance_seconds}-second execution-manifest tolerance" >&2
        exit 2
    fi
fi

if [ "$clock_skew_limit_seconds" -gt 0 ] && ! command -v date >/dev/null 2>&1; then
    echo "sandbox-runner clock-skew check requires date" >&2
    exit 2
fi

effective_clock_skew_limit_seconds="$clock_skew_limit_seconds"
if [ "$clock_skew_limit_seconds" -gt 0 ] && [ "$clock_skew_jitter_seconds" -gt 0 ]; then
    if [ "${#clock_skew_jitter_seconds}" -gt 2 ] || \
        [ "$clock_skew_jitter_seconds" -ge "$clock_skew_limit_seconds" ]; then
        echo "SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS must be less than SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS" >&2
        exit 2
    fi
    if ! command -v cksum >/dev/null 2>&1; then
        echo "sandbox-runner clock-skew jitter requires cksum" >&2
        exit 2
    fi

    # Pods from one rollout have nearly identical ages and drift rates. Give
    # each pod a stable threshold within the configured range to reduce the
    # chance that same-age replicas restart together.
    jitter_key="${HOSTNAME:-sandbox-runner}"
    jitter_checksum=$(printf '%s' "$jitter_key" | cksum)
    jitter_checksum="${jitter_checksum%% *}"
    effective_clock_skew_limit_seconds=$((
        clock_skew_limit_seconds - (jitter_checksum % (clock_skew_jitter_seconds + 1))
    ))
fi

if [ "$fd_limit" -gt 0 ]; then
    fd_count=$(find /proc/1/fd -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d '[:space:]')
    if [ "$fd_count" -ge "$fd_limit" ]; then
        echo "sandbox-runner unhealthy: pid 1 has ${fd_count} open fds, limit is ${fd_limit}" >&2
        exit 1
    fi
fi

if [ "$clock_skew_limit_seconds" -eq 0 ]; then
    curl -fsS --max-time "$timeout_seconds" "$url" >/dev/null
    exit 0
fi

host_before_seconds=$(date -u +%s)
response_headers=$(curl -fsS --max-time "$timeout_seconds" --dump-header - --output /dev/null "$url")
host_after_seconds=$(date -u +%s)

guest_date=$(printf '%s\n' "$response_headers" | awk '
    tolower($1) == "date:" {
        sub(/\r$/, "")
        sub(/^[^:]*:[[:space:]]*/, "")
        value = $0
    }
    END { print value }
')

if [ -z "$guest_date" ]; then
    echo "sandbox-runner unhealthy: guest response is missing the HTTP Date header" >&2
    exit 1
fi

http_date_pattern='^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$'
if ! [[ "$guest_date" =~ $http_date_pattern ]]; then
    echo "sandbox-runner unhealthy: guest returned an invalid HTTP Date header: ${guest_date}" >&2
    exit 1
fi

if ! guest_seconds=$(date -u -d "$guest_date" +%s 2>/dev/null); then
    echo "sandbox-runner unhealthy: guest returned an invalid HTTP Date header: ${guest_date}" >&2
    exit 1
fi

# The response can take time to arrive, so compare guest time with the host
# interval that enclosed the request instead of with a single sample. This
# prevents probe latency from looking like backward clock drift.
if [ "$guest_seconds" -lt "$host_before_seconds" ]; then
    skew_seconds=$((guest_seconds - host_before_seconds))
elif [ "$guest_seconds" -gt "$host_after_seconds" ]; then
    skew_seconds=$((guest_seconds - host_after_seconds))
else
    skew_seconds=0
fi

absolute_skew_seconds="$skew_seconds"
if [ "$absolute_skew_seconds" -lt 0 ]; then
    absolute_skew_seconds=$((-absolute_skew_seconds))
fi

if [ "$absolute_skew_seconds" -ge "$effective_clock_skew_limit_seconds" ]; then
    echo "sandbox-runner unhealthy: guest clock skew is ${skew_seconds}s, pod limit is ${effective_clock_skew_limit_seconds}s (configured maximum ${clock_skew_limit_seconds}s)" >&2
    exit 1
fi
