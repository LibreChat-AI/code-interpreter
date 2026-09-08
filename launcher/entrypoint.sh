#!/bin/bash
set -e

# TSI opens guest sockets in this container's network namespace. Keep service
# names intact so new connections can resolve replacements after a restart.
# Forward the resolver and search domains supplied by Docker or Kubernetes,
# rather than pinning endpoint IPs or baking a deployment-specific nameserver.
export SANDBOX_RESOLV_CONF="$(cat /etc/resolv.conf)"
if ! printf '%s\n' "$SANDBOX_RESOLV_CONF" | grep -Eq '^[[:space:]]*nameserver[[:space:]]+[^[:space:]#]'; then
    echo 'ERROR: runner /etc/resolv.conf has no nameserver' >&2
    exit 1
fi

if [ "${LAUNCHER_FILTER_VSOCK_ENOTCONN:-true}" = "true" ]; then
    # libkrun can emit this benign TSI/vsock teardown line after the guest has
    # already closed its side of the socket. It contains the word "error", so
    # text-based log panels count it as an app failure unless we drop it here.
    exec /usr/local/bin/launcher "$@" \
        2> >(grep --line-buffered -vF 'devices::virtio::vsock::tsi_stream error sending shutdown to socket: ENOTCONN' >&2)
fi

exec /usr/local/bin/launcher "$@"
