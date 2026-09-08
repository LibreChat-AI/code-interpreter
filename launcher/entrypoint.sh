#!/bin/bash
set -e

# TSI opens guest sockets in this container's network namespace. Keep service
# names intact so new connections can resolve replacements after a restart.
# Forward the resolver and search domains supplied by Docker or Kubernetes,
# rather than pinning endpoint IPs or baking a deployment-specific nameserver.
#
# libkrun places every guest environment entry on the kernel command line,
# which accepts only single-line printable ASCII and is truncated by the guest
# kernel past 2048 bytes. Keep the resolver directives alone, one per field,
# joined by a separator that api/src/guest-dns.sh expands back into lines.
RESOLV_FIELD_SEPARATOR='|'

encode_resolv_conf() {
    local LC_ALL=C
    local line words encoded=''
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [[ ! "$line" =~ ^[[:space:]]*(nameserver|search|domain|options|sortlist)[[:space:]] ]]; then
            continue
        fi
        read -ra words <<< "$line"
        line="${words[*]}"
        if [[ "$line" == *[!' '-'~']* || "$line" == *[\"$RESOLV_FIELD_SEPARATOR]* ]]; then
            echo "ERROR: runner /etc/resolv.conf line cannot cross the kernel command line: $line" >&2
            return 1
        fi
        encoded+="${encoded:+$RESOLV_FIELD_SEPARATOR}$line"
    done
    printf '%s' "$encoded"
}

SANDBOX_RESOLV_CONF="$(encode_resolv_conf < /etc/resolv.conf)"
export SANDBOX_RESOLV_CONF
if [[ "$RESOLV_FIELD_SEPARATOR$SANDBOX_RESOLV_CONF" != *"${RESOLV_FIELD_SEPARATOR}nameserver "[!\#]* ]]; then
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
