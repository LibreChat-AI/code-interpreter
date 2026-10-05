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

# One inet_aton(3) part: hex with 0x, octal with a leading 0, else decimal.
inet_aton_part() {
    case "$1" in
        0x*) [[ "$1" =~ ^0x[0-9a-f]+$ ]] && echo $((16#${1#0x})) ;;
        0*) [[ "$1" =~ ^0[0-7]*$ ]] && echo $((8#$1)) ;;
        *) [[ "$1" =~ ^[0-9]+$ ]] && echo $((10#$1)) ;;
    esac
}

# Numeric value of an IPv4 address in the inet_aton(3) forms glibc accepts in
# resolv.conf: one to four parts, the last filling the remaining bytes.
ipv4_value() {
    local parts part value=0 index last
    IFS=. read -ra parts <<< "$1"
    [[ "$1" != *. ]] && (( ${#parts[@]} >= 1 && ${#parts[@]} <= 4 )) || return 1
    last=$(( ${#parts[@]} - 1 ))
    for ((index = 0; index < last; index++)); do
        part="$(inet_aton_part "${parts[index]}")" || return 1
        (( part <= 255 )) || return 1
        value=$(( value | part << (24 - 8 * index) ))
    done
    part="$(inet_aton_part "${parts[last]}")" || return 1
    (( part < 1 << (32 - 8 * last) )) || return 1
    echo $(( value | part ))
}

# The eight 16-bit groups of an IPv6 address in decimal, accepting compressed
# zeros and a dotted IPv4 tail.
ipv6_groups() {
    local address="$1" head tail octets octet group groups=() tail_groups=() fill
    if [[ "$address" =~ ^(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
        address="${BASH_REMATCH[1]}"
        IFS=. read -ra octets <<< "${BASH_REMATCH[2]}"
        for octet in "${octets[@]}"; do
            [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( octet <= 255 )) || return 1
        done
        address+="$(printf '%x:%x' $(( octets[0] << 8 | octets[1] )) $(( octets[2] << 8 | octets[3] )))"
    fi
    [[ "$address" =~ ^[0-9a-f:]+$ && "$address" != :[!:]* && "$address" != *[!:]: && "$address" != *:::* ]] || return 1
    if [[ "$address" == *::* ]]; then
        head="${address%%::*}"
        tail="${address#*::}"
        [[ "$tail" != *::* ]] || return 1
        [ -z "$head" ] || IFS=: read -ra groups <<< "$head"
        [ -z "$tail" ] || IFS=: read -ra tail_groups <<< "$tail"
        fill=$(( 8 - ${#groups[@]} - ${#tail_groups[@]} ))
        (( fill >= 1 )) || return 1
        for ((; fill > 0; fill--)); do groups+=(0); done
        groups+=("${tail_groups[@]}")
    else
        IFS=: read -ra groups <<< "$address"
    fi
    (( ${#groups[@]} == 8 )) || return 1
    for group in "${groups[@]}"; do
        [[ "$group" =~ ^[0-9a-f]{1,4}$ ]] || return 1
        printf '%d ' $((16#$group))
    done
}

# Canonical form of a loopback nameserver in any spelling glibc accepts: IPv4
# 127.0.0.0/8, IPv6 ::1, or IPv4-mapped 127.0.0.0/8 (relayed as IPv4). Fails for
# every other address.
canonical_loopback() {
    local address="${1,,}" text groups value
    address="${address%%\%*}"
    if [[ "$address" == *:* ]]; then
        text="$(ipv6_groups "$address")" || return 1
        read -ra groups <<< "$text"
        if [ "${groups[*]}" = '0 0 0 0 0 0 0 1' ]; then
            echo ::1
            return 0
        fi
        [ "${groups[*]:0:6}" = '0 0 0 0 0 65535' ] || return 1
        value=$(( groups[6] << 16 | groups[7] ))
    else
        value="$(ipv4_value "$address")" || return 1
    fi
    (( value >> 24 == 127 )) || return 1
    printf '%d.%d.%d.%d' $(( value >> 24 )) $(( value >> 16 & 255 )) $(( value >> 8 & 255 )) $(( value & 255 ))
}

loopback_nameserver() {
    local line words
    while IFS= read -r line || [ -n "$line" ]; do
        read -ra words <<< "${line%$'\r'}"
        if [ "${words[0]:-}" = nameserver ] && canonical_loopback "${words[1]:-}"; then
            return 0
        fi
    done < "$1"
}

runner_address() {
    getent ahostsv4 "$(cat /proc/sys/kernel/hostname)" | awk '$1 !~ /^127\./ { print $1; exit }'
}

encode_resolv_conf() {
    local loopback="${1:-}" relay="${2:-}"
    local LC_ALL=C
    local line words canonical encoded=''
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [[ ! "$line" =~ ^[[:space:]]*(nameserver|search|domain|options|sortlist)[[:space:]] ]]; then
            continue
        fi
        read -ra words <<< "$line"
        if [ "${words[0]}" = nameserver ] && canonical="$(canonical_loopback "${words[1]}")"; then
            [ "$canonical" = "$loopback" ] || continue
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
