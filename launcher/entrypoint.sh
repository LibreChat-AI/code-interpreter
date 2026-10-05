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

# The guest kernel keeps loopback traffic on its own loopback device instead of
# proxying it through TSI, so a loopback resolver such as Docker's embedded
# 127.0.0.11 never answers inside the guest. Relay it from this container's own
# address, which the guest reaches through TSI, and hand the guest that address.
# The relay forks per datagram and per connection, so bound how long an idle
# child may live, and how many TCP children may run at once. socat 1.8 fails
# every UDP-RECVFROM child given max-children, so the UDP relay relies on its
# short idle timeout. Only the runner network reaches the relay: NsJail jobs in
# the guest run in their own network namespace.
RESOLVER_RELAY_READY_ATTEMPTS=50
RESOLVER_RELAY_MAX_CHILDREN=64
RESOLVER_RELAY_UDP_IDLE_SECONDS=5
RESOLVER_RELAY_TCP_IDLE_SECONDS=30

is_loopback_nameserver() {
    [[ "$1" == 127.* || "$1" == ::1 ]]
}

loopback_nameserver() {
    awk '{ sub(/\r$/, "") } $1 == "nameserver" && ($2 ~ /^127\./ || $2 == "::1") { print $2; exit }' "$1"
}

runner_address() {
    getent ahostsv4 "$(cat /proc/sys/kernel/hostname)" | awk '$1 !~ /^127\./ { print $1; exit }'
}

encode_resolv_conf() {
    local loopback="${1:-}" relay="${2:-}"
    local LC_ALL=C
    local line words encoded=''
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [[ ! "$line" =~ ^[[:space:]]*(nameserver|search|domain|options|sortlist)[[:space:]] ]]; then
            continue
        fi
        read -ra words <<< "$line"
        if [ "${words[0]}" = nameserver ] && is_loopback_nameserver "${words[1]}"; then
            [ "${words[1]}" = "$loopback" ] || continue
            words[1]="$relay"
        fi
        line="${words[*]}"
        if [[ "$line" == *[!' '-'~']* || "$line" == *[\"$RESOLV_FIELD_SEPARATOR]* ]]; then
            echo "ERROR: runner /etc/resolv.conf line cannot cross the kernel command line: $line" >&2
            return 1
        fi
        encoded+="${encoded:+$RESOLV_FIELD_SEPARATOR}$line"
    done
    printf '%s' "$encoded"
}

proc_net_address() {
    local a b c d
    IFS=. read -r a b c d <<< "$1"
    printf '%02X%02X%02X%02X:0035' "$d" "$c" "$b" "$a"
}

start_resolver_relay() {
    local nameserver="$1" address="$2" local_address udp_pid tcp_pid attempt
    local udp_target="UDP4-SENDTO:$nameserver:53" tcp_target="TCP4:$nameserver:53"
    if [ "$nameserver" = ::1 ]; then
        udp_target='UDP6-SENDTO:[::1]:53'
        tcp_target='TCP6:[::1]:53'
    fi
    socat -T "$RESOLVER_RELAY_UDP_IDLE_SECONDS" \
        "UDP4-RECVFROM:53,bind=$address,fork" "$udp_target" &
    udp_pid=$!
    socat -T "$RESOLVER_RELAY_TCP_IDLE_SECONDS" \
        "TCP4-LISTEN:53,bind=$address,reuseaddr,fork,max-children=$RESOLVER_RELAY_MAX_CHILDREN" "$tcp_target" &
    tcp_pid=$!
    local_address="$(proc_net_address "$address")"
    for ((attempt = 0; attempt < RESOLVER_RELAY_READY_ATTEMPTS; attempt++)); do
        if grep -q " $local_address " /proc/net/udp && grep -q " $local_address 00000000:0000 0A " /proc/net/tcp; then
            echo "Relaying guest DNS from $address:53 to loopback resolver $nameserver"
            return 0
        fi
        if ! kill -0 "$udp_pid" "$tcp_pid" 2>/dev/null; then
            break
        fi
        sleep 0.1
    done
    kill "$udp_pid" "$tcp_pid" 2>/dev/null || true
    echo "ERROR: guest DNS relay could not listen on $address:53 for loopback resolver $nameserver" >&2
    return 1
}

LOOPBACK_NAMESERVER="$(loopback_nameserver /etc/resolv.conf)"
RESOLVER_RELAY_ADDRESS=''
if [ -n "$LOOPBACK_NAMESERVER" ]; then
    RESOLVER_RELAY_ADDRESS="$(runner_address)"
    if [ -z "$RESOLVER_RELAY_ADDRESS" ]; then
        echo "ERROR: runner has no non-loopback IPv4 address to relay loopback resolver $LOOPBACK_NAMESERVER" >&2
        exit 1
    fi
fi

SANDBOX_RESOLV_CONF="$(encode_resolv_conf "$LOOPBACK_NAMESERVER" "$RESOLVER_RELAY_ADDRESS" < /etc/resolv.conf)"
export SANDBOX_RESOLV_CONF
if [[ "$RESOLV_FIELD_SEPARATOR$SANDBOX_RESOLV_CONF" != *"${RESOLV_FIELD_SEPARATOR}nameserver "[!\#]* ]]; then
    echo 'ERROR: runner /etc/resolv.conf has no nameserver' >&2
    exit 1
fi

if [ -n "$LOOPBACK_NAMESERVER" ]; then
    start_resolver_relay "$LOOPBACK_NAMESERVER" "$RESOLVER_RELAY_ADDRESS"
fi

if [ "${LAUNCHER_FILTER_VSOCK_ENOTCONN:-true}" = "true" ]; then
    # libkrun can emit this benign TSI/vsock teardown line after the guest has
    # already closed its side of the socket. It contains the word "error", so
    # text-based log panels count it as an app failure unless we drop it here.
    exec /usr/local/bin/launcher "$@" \
        2> >(grep --line-buffered -vF 'devices::virtio::vsock::tsi_stream error sending shutdown to socket: ENOTCONN' >&2)
fi

exec /usr/local/bin/launcher "$@"
