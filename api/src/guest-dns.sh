#!/bin/bash
# The guest root may be read-only. Bake the link, populate its target only
# after /run is mounted, and leave direct NsJail/Lambda resolvers untouched.

prepare_guest_dns() {
    local root="$1"
    mkdir -p "$root/run"
    rm -f "$root/etc/resolv.conf"
    ln -s ../run/codeapi-resolver/resolv.conf "$root/etc/resolv.conf"
}

configure_guest_dns() {
    local root="${1:-}"
    local target="$root/run/codeapi-resolver"
    if [ ! -L "$root/etc/resolv.conf" ] || \
        [ "$(readlink "$root/etc/resolv.conf")" != '../run/codeapi-resolver/resolv.conf' ]; then
        return 0
    fi
    if ! printf '%s\n' "${SANDBOX_RESOLV_CONF:-}" | grep -Eq '^[[:space:]]*nameserver[[:space:]]+[^[:space:]#]'; then
        echo 'ERROR: KVM guest requires resolver configuration from launcher-entrypoint.sh' >&2
        return 1
    fi
    # A fresh, root-owned directory prevents a sandbox UID from replacing DNS
    # configuration in the runtime mount. Never reuse a pre-existing entry.
    (umask 077; mkdir "$target") || return 1
    printf '%s\n' "$SANDBOX_RESOLV_CONF" > "$target/resolv.conf" || return 1
    chmod 600 "$target/resolv.conf" || return 1
    unset SANDBOX_RESOLV_CONF
}

run_guest_command() {
    local root="$1"
    shift
    # This runs for every LAUNCHER_EXEC, before the selected executable. Keep
    # DNS separate from /tmp, which the normal API entrypoint mounts later.
    mount -t tmpfs -o size=1m,mode=0755 tmpfs "$root/run" || return 1
    configure_guest_dns "$root" || return 1
    exec -- "$@"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -e
    case "${1:-}" in
        --prepare-rootfs) prepare_guest_dns "${2:?rootfs path required}" ;;
        --configure) configure_guest_dns "${2:-}" ;;
        --exec) run_guest_command "" "${2:?guest executable required}" ;;
        *) echo 'usage: guest-dns.sh --prepare-rootfs ROOTFS | --configure [ROOTFS] | --exec EXECUTABLE' >&2; exit 2 ;;
    esac
fi
