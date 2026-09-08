#!/bin/bash
# The guest root may be read-only. Bake the link, populate its target only
# after /tmp is mounted, and leave direct NsJail/Lambda resolvers untouched.

prepare_guest_dns() {
    local root="$1"
    rm -f "$root/etc/resolv.conf"
    ln -s ../tmp/codeapi-resolver/resolv.conf "$root/etc/resolv.conf"
}

configure_guest_dns() {
    local root="${1:-}"
    local target="$root/tmp/codeapi-resolver"
    if [ ! -L "$root/etc/resolv.conf" ] || \
        [ "$(readlink "$root/etc/resolv.conf")" != '../tmp/codeapi-resolver/resolv.conf' ]; then
        return 0
    fi
    if ! printf '%s\n' "${SANDBOX_RESOLV_CONF:-}" | grep -Eq '^[[:space:]]*nameserver[[:space:]]+[^[:space:]#]'; then
        echo 'ERROR: KVM guest requires resolver configuration from launcher-entrypoint.sh' >&2
        return 1
    fi
    # A fresh, root-owned directory prevents a sandbox UID from replacing DNS
    # configuration in the shared /tmp mount. Never reuse a pre-existing entry.
    (umask 077; mkdir "$target") || return 1
    printf '%s\n' "$SANDBOX_RESOLV_CONF" > "$target/resolv.conf" || return 1
    chmod 600 "$target/resolv.conf" || return 1
    unset SANDBOX_RESOLV_CONF
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -e
    case "${1:-}" in
        --prepare-rootfs) prepare_guest_dns "${2:?rootfs path required}" ;;
        --configure) configure_guest_dns "${2:-}" ;;
        *) echo 'usage: guest-dns.sh --prepare-rootfs ROOTFS | --configure [ROOTFS]' >&2; exit 2 ;;
    esac
fi
