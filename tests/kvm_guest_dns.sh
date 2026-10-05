#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'chmod -R u+w "$TEST_DIR"; rm -rf "$TEST_DIR"' EXIT
source "$ROOT/api/src/guest-dns.sh"

# Configure the baked link while writable, then only the runtime /run target.
mkdir -p "$TEST_DIR/guest/etc" "$TEST_DIR/guest/run"
printf 'nameserver 1.1.1.1\n' > "$TEST_DIR/guest/etc/resolv.conf"
prepare_guest_dns "$TEST_DIR/guest"
[[ "$(readlink "$TEST_DIR/guest/etc/resolv.conf")" == '../run/codeapi-resolver/resolv.conf' ]]
chmod 555 "$TEST_DIR/guest/etc"
SANDBOX_RESOLV_CONF=$'nameserver 127.0.0.11\noptions ndots:0'
configure_guest_dns "$TEST_DIR/guest"
printf 'nameserver 127.0.0.11\noptions ndots:0\n' > "$TEST_DIR/expected"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"
[[ ! -v SANDBOX_RESOLV_CONF ]]
# Ownership protection: no group/other permissions on the runtime directory.
[[ "$(ls -ld "$TEST_DIR/guest/run/codeapi-resolver" | cut -c1-10)" == 'drwx------' ]]

# A fresh boot can use Kubernetes DNS/search paths without rebuilding the root.
rm -rf "$TEST_DIR/guest/run/codeapi-resolver"
SANDBOX_RESOLV_CONF=$'nameserver 10.96.0.10\nsearch tenant.svc.cluster.local svc.cluster.local cluster.local\noptions ndots:5' # leak-check:allow
printf '%s\n' "$SANDBOX_RESOLV_CONF" > "$TEST_DIR/expected"
configure_guest_dns "$TEST_DIR/guest"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"

# The launcher entrypoint joins directives with a separator so the handoff
# survives the kernel command line; the guest expands it back into lines.
rm -rf "$TEST_DIR/guest/run/codeapi-resolver"
SANDBOX_RESOLV_CONF='nameserver 10.96.0.10|search tenant.svc.cluster.local svc.cluster.local cluster.local|options ndots:5' # leak-check:allow
configure_guest_dns "$TEST_DIR/guest"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"
[[ ! -v SANDBOX_RESOLV_CONF ]]

# Never reuse a stale directory or follow an attacker-controlled runtime link.
SANDBOX_RESOLV_CONF='nameserver 127.0.0.11'
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted pre-existing runtime DNS directory' >&2; exit 1
fi
rm -rf "$TEST_DIR/guest/run/codeapi-resolver"
mkdir "$TEST_DIR/foreign"
ln -s "$TEST_DIR/foreign" "$TEST_DIR/guest/run/codeapi-resolver"
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted runtime DNS symlink' >&2; exit 1
fi
[[ ! -e "$TEST_DIR/foreign/resolv.conf" ]]
rm "$TEST_DIR/guest/run/codeapi-resolver"
unset SANDBOX_RESOLV_CONF
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted missing guest resolver' >&2; exit 1
fi
SANDBOX_RESOLV_CONF='# no nameserver'
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted empty guest resolver' >&2; exit 1
fi
SANDBOX_RESOLV_CONF='search example.com|options ndots:0'
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted encoded guest resolver without nameserver' >&2; exit 1
fi

# Direct NsJail and Lambda retain the resolver managed by their container.
mkdir -p "$TEST_DIR/direct/etc"
printf 'nameserver 192.0.2.53\n' > "$TEST_DIR/direct/etc/resolv.conf"
cp "$TEST_DIR/direct/etc/resolv.conf" "$TEST_DIR/expected"
configure_guest_dns "$TEST_DIR/direct"
cmp "$TEST_DIR/expected" "$TEST_DIR/direct/etc/resolv.conf"

# Exercise the actual launcher script up to exec, substituting only its binary.
# Service names (including HTTPS authority and IPv6) must never be rewritten.
mkdir "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/launcher" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$EGRESS_GATEWAY_URL" == 'https://egress_gateway:3190/base' ]]
[[ "$FILE_SERVER_URL" == 'http://[::1]:3000/base' ]]
[[ "$SANDBOX_FORWARD_TARGET" == 'tool_call_server:3033' ]]
printf '%s\n' "$SANDBOX_RESOLV_CONF" > "$TEST_RESOLVER_OUTPUT"
STUB
cat > "$TEST_DIR/bin/getent" <<'STUB'
#!/usr/bin/env bash
[[ -z "${TEST_RUNNER_ADDRESS-192.0.2.99}" ]] || printf '%s stale-address\n' "${TEST_RUNNER_ADDRESS-192.0.2.99}"
STUB
# The relay stub records its endpoints; readiness comes from the fake /proc/net.
cat > "$TEST_DIR/bin/socat" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_SOCAT_CALLS"
STUB
chmod +x "$TEST_DIR/bin/launcher" "$TEST_DIR/bin/getent" "$TEST_DIR/bin/socat"
# 192.0.2.99:53 bound for UDP and listening for TCP, in /proc/net byte order.
mkdir "$TEST_DIR/proc-net-bound" "$TEST_DIR/proc-net-unbound"
printf '  sl  local_address rem_address   st\n   0: 630200C0:0035 00000000:0000 07 00000000:00000000\n' > "$TEST_DIR/proc-net-bound/udp"
printf '  sl  local_address rem_address   st\n   0: 630200C0:0035 00000000:0000 0A 00000000:00000000\n' > "$TEST_DIR/proc-net-bound/tcp"
printf '  sl  local_address rem_address   st\n' | tee "$TEST_DIR/proc-net-unbound/udp" > "$TEST_DIR/proc-net-unbound/tcp"
# libkrun appends every guest environment entry to the kernel command line,
# which linux-loader limits to single-line printable ASCII. Docker's generated
# resolv.conf is multi-line with comments, so the entrypoint must forward only
# the resolver directives, joined by the separator guest-dns.sh expands.
run_entrypoint() {
    local resolv_conf="$1" proc_net="${2:-$TEST_DIR/proc-net-bound}"
    sed -e "s|/usr/local/bin/launcher|$TEST_DIR/bin/launcher|g" \
        -e "s|/etc/resolv.conf|$resolv_conf|g" \
        -e "s|/proc/net/|$proc_net/|g" \
        -e 's|RESOLVER_RELAY_READY_ATTEMPTS=50|RESOLVER_RELAY_READY_ATTEMPTS=3|' \
        "$ROOT/launcher/entrypoint.sh" > "$TEST_DIR/entrypoint.sh"
    rm -f "$TEST_DIR/forwarded" "$TEST_DIR/socat-calls"
    PATH="$TEST_DIR/bin:$PATH" \
    EGRESS_GATEWAY_URL='https://egress_gateway:3190/base' \
    FILE_SERVER_URL='http://[::1]:3000/base' \
    SANDBOX_FORWARD_TARGET='tool_call_server:3033' \
    LAUNCHER_FILTER_VSOCK_ENOTCONN=false \
    TEST_RESOLVER_OUTPUT="$TEST_DIR/forwarded" \
    TEST_SOCAT_CALLS="$TEST_DIR/socat-calls" \
    bash "$TEST_DIR/entrypoint.sh"
}
# Independent reference for the expected handoff: directives only, whitespace
# collapsed, joined by the separator. The first loopback nameserver becomes the
# relay address; other loopback nameservers are unreachable and dropped.
encoded_reference() {
    LC_ALL=C awk -v relay=192.0.2.99 '/^[[:space:]]*(nameserver|search|domain|options|sortlist)[[:space:]]/ {
        sub(/\r$/, ""); $1 = $1
        address = tolower($2)
        if ($1 == "nameserver" && (address ~ /^127\./ || address ~ /^[0:]*:0*1$/ || address ~ /^::ffff:127\./)) { if (loop == "") loop = $2; if ($2 != loop) next; $2 = relay }
        print
    }' "$1" | paste -sd '|' -
}
# The relays start in the background, so wait for both before comparing. Both
# bound idle children; the TCP listener also caps concurrent children.
assert_relayed() {
    local udp_target="$1" tcp_target="$2" attempt
    for ((attempt = 0; attempt < 50; attempt++)); do
        [[ -e "$TEST_DIR/socat-calls" && "$(wc -l < "$TEST_DIR/socat-calls")" -ge 2 ]] && break
        sleep 0.1
    done
    [[ "$(LC_ALL=C sort "$TEST_DIR/socat-calls")" == "$(printf -- '-T 30 TCP4-LISTEN:53,bind=192.0.2.99,reuseaddr,fork,max-children=64 %s\n-T 5 UDP4-RECVFROM:53,bind=192.0.2.99,fork %s' "$tcp_target" "$udp_target")" ]]
}
cat > "$TEST_DIR/docker-resolv.conf" <<'RESOLV'
# Generated by Docker Engine.
# This file can be edited; Docker Engine will not make further changes once it
# has been modified.

nameserver 127.0.0.11
options ndots:0

# Based on host file: '/etc/resolv.conf' (internal resolver)
# ExtServers: [host(10.255.255.254)]
# Overrides: []
# Option ndots from: internal
RESOLV
# The guest keeps loopback traffic local, so Docker's embedded resolver is
# relayed from the runner address and the guest gets that address instead.
run_entrypoint "$TEST_DIR/docker-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99|options ndots:0' ]]
[[ "$(cat "$TEST_DIR/forwarded")" == "$(encoded_reference "$TEST_DIR/docker-resolv.conf")" ]]
assert_relayed UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
[[ "$(wc -l < "$TEST_DIR/forwarded")" == 1 ]]
if LC_ALL=C grep -q '[^ -~]' "$TEST_DIR/forwarded"; then
    echo 'forwarded resolver contains bytes the kernel command line rejects' >&2; exit 1
fi
# The guest restores the Docker directives with the relayed nameserver.
rm -rf "$TEST_DIR/guest/run/codeapi-resolver"
SANDBOX_RESOLV_CONF="$(cat "$TEST_DIR/forwarded")" configure_guest_dns "$TEST_DIR/guest"
printf 'nameserver 192.0.2.99\noptions ndots:0\n' > "$TEST_DIR/expected"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"

# Only one loopback resolver can be relayed; other loopback entries would time
# out in the guest, while routable nameservers keep their order.
printf 'nameserver 127.0.0.53\r\nnameserver 10.0.0.2\nnameserver\t127.0.0.11\nsearch example.internal\n' > "$TEST_DIR/multi-loopback-resolv.conf"
run_entrypoint "$TEST_DIR/multi-loopback-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99|nameserver 10.0.0.2|search example.internal' ]]
[[ "$(cat "$TEST_DIR/forwarded")" == "$(encoded_reference "$TEST_DIR/multi-loopback-resolv.conf")" ]]
assert_relayed UDP4-SENDTO:127.0.0.53:53 TCP4:127.0.0.53:53

# An IPv6 loopback resolver is just as unreachable from the guest; the IPv4
# relay forwards to it over IPv6.
printf 'nameserver ::1\noptions ndots:0\n' > "$TEST_DIR/ipv6-loopback-resolv.conf"
run_entrypoint "$TEST_DIR/ipv6-loopback-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99|options ndots:0' ]]
[[ "$(cat "$TEST_DIR/forwarded")" == "$(encoded_reference "$TEST_DIR/ipv6-loopback-resolv.conf")" ]]
assert_relayed 'UDP6-SENDTO:[::1]:53' 'TCP6:[::1]:53'
printf 'nameserver 127.0.0.11\nnameserver ::1\n' > "$TEST_DIR/mixed-loopback-resolv.conf"
run_entrypoint "$TEST_DIR/mixed-loopback-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99' ]]
assert_relayed UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
# Every spelling glibc accepts for a loopback resolver is relayed to its
# canonical address: compressed or zero-padded ::1, IPv4-mapped 127/8 in any
# IPv6 form, and inet_aton(3) IPv4 forms.
while read -r spelling udp_target tcp_target; do
    printf 'nameserver %s\nnameserver 10.0.0.2\n' "$spelling" > "$TEST_DIR/spelled-loopback-resolv.conf"
    run_entrypoint "$TEST_DIR/spelled-loopback-resolv.conf"
    [[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99|nameserver 10.0.0.2' ]]
    assert_relayed "$udp_target" "$tcp_target"
done <<'SPELLINGS'
0:0:0:0:0:0:0:1 UDP6-SENDTO:[::1]:53 TCP6:[::1]:53
0000::0001 UDP6-SENDTO:[::1]:53 TCP6:[::1]:53
::1%lo UDP6-SENDTO:[::1]:53 TCP6:[::1]:53
::FFFF:127.0.0.11 UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
0:0:0:0:0:ffff:127.0.0.11 UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
::ffff:7f00:b UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
127.1 UDP4-SENDTO:127.0.0.1:53 TCP4:127.0.0.1:53
2130706443 UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
0x7f.0.0.0xb UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
0177.0.0.013 UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
SPELLINGS
# Spellings of the same loopback resolver collapse into one relayed entry.
printf 'nameserver 127.0.0.11\nnameserver ::ffff:7f00:b\nnameserver 127.0.0.53\n' > "$TEST_DIR/same-loopback-resolv.conf"
run_entrypoint "$TEST_DIR/same-loopback-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 192.0.2.99|nameserver 192.0.2.99' ]]
assert_relayed UDP4-SENDTO:127.0.0.11:53 TCP4:127.0.0.11:53
# Routable resolvers and addresses glibc rejects are forwarded unchanged, without
# a relay: 0127 is octal 87, and ::7f00:1 is not IPv4-mapped.
printf 'nameserver 2001:db8::1\nnameserver fd00::11\nnameserver ::ffff:10.0.0.2\nnameserver ::7f00:1\nnameserver 0127.0.0.1\nnameserver 127.0.0.256\nnameserver 1:2:3:4:5:6:7:8:\nnameserver 127..1\n' > "$TEST_DIR/routable-resolv.conf"
run_entrypoint "$TEST_DIR/routable-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 2001:db8::1|nameserver fd00::11|nameserver ::ffff:10.0.0.2|nameserver ::7f00:1|nameserver 0127.0.0.1|nameserver 127.0.0.256|nameserver 1:2:3:4:5:6:7:8:|nameserver 127..1' ]]
[[ ! -e "$TEST_DIR/socat-calls" ]]

# A relay that never listens, or a runner without a routable address, fails
# startup instead of booting a guest that cannot resolve service names.
if run_entrypoint "$TEST_DIR/docker-resolv.conf" "$TEST_DIR/proc-net-unbound" 2> "$TEST_DIR/entrypoint-error"; then
    echo 'started launcher without a listening resolver relay' >&2; exit 1
fi
grep -q 'guest DNS relay could not listen on 192.0.2.99:53' "$TEST_DIR/entrypoint-error"
[[ ! -e "$TEST_DIR/forwarded" ]]
if TEST_RUNNER_ADDRESS='' run_entrypoint "$TEST_DIR/docker-resolv.conf" 2> "$TEST_DIR/entrypoint-error"; then
    echo 'started launcher without a resolver relay address' >&2; exit 1
fi
grep -q 'no non-loopback IPv4 address to relay loopback resolver 127.0.0.11' "$TEST_DIR/entrypoint-error"
[[ ! -e "$TEST_DIR/forwarded" && ! -e "$TEST_DIR/socat-calls" ]]

# Kubernetes resolvers: tabs, CRLF, trailing spaces, and unknown keywords are
# normalized away; search domains and options survive intact.
printf 'nameserver\t10.96.0.10  \r\nsearch   tenant.svc.cluster.local svc.cluster.local cluster.local\n; resolver comment\nlookup file bind\noptions ndots:5\n' > "$TEST_DIR/k8s-resolv.conf" # leak-check:allow
run_entrypoint "$TEST_DIR/k8s-resolv.conf"
[[ "$(cat "$TEST_DIR/forwarded")" == 'nameserver 10.96.0.10|search tenant.svc.cluster.local svc.cluster.local cluster.local|options ndots:5' ]] # leak-check:allow
[[ ! -e "$TEST_DIR/socat-calls" ]]

# The runner's own resolver must round-trip through the same reference.
run_entrypoint /etc/resolv.conf
[[ "$(cat "$TEST_DIR/forwarded")" == "$(encoded_reference /etc/resolv.conf)" ]]

# Content that cannot cross the kernel command line fails before the launcher
# starts, instead of a libkrun InvalidAscii panic and a restart loop.
for bad in $'nameserver 1.1.1.1\nsearch caf\xc3\xa9.example\n' $'nameserver 1.1.1.1\nsearch a|b\n' $'nameserver 1.1.1.1\noptions "ndots:1"\n'; do
    printf '%s' "$bad" > "$TEST_DIR/bad-resolv.conf"
    if run_entrypoint "$TEST_DIR/bad-resolv.conf" 2> "$TEST_DIR/entrypoint-error"; then
        echo 'forwarded resolver content the kernel command line cannot carry' >&2; exit 1
    fi
    grep -q 'cannot cross the kernel command line' "$TEST_DIR/entrypoint-error"
    [[ ! -e "$TEST_DIR/forwarded" ]]
done
printf '# comments only\nsearch example.com\n' > "$TEST_DIR/bad-resolv.conf"
if run_entrypoint "$TEST_DIR/bad-resolv.conf" 2> "$TEST_DIR/entrypoint-error"; then
    echo 'started launcher without a nameserver' >&2; exit 1
fi
grep -q 'has no nameserver' "$TEST_DIR/entrypoint-error"
[[ ! -e "$TEST_DIR/forwarded" ]]

# Every rootfs assembly path must prepare DNS after COPY, before disk creation.
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for name, count in [('api/Dockerfile', 2), ('docker/Dockerfile.worker-sandbox', 2), ('launcher/Dockerfile', 1)]:
    text = (root / name).read_text()
    assert text.count('--prepare-rootfs /sandbox-rootfs') == count, name
    assert 'COPY api/src/guest-dns.sh ./guest-dns.sh' in text, name
    for stage in text.split('\nFROM '):
        if 'COPY --from=sandbox-' in stage and ' / /sandbox-rootfs/' in stage:
            assert stage.index(' / /sandbox-rootfs/') < stage.index('--prepare-rootfs /sandbox-rootfs'), name
        if '/usr/local/bin/build-rootfs-image.sh /sandbox-rootfs /sandbox-rootfs.img' in stage:
            assert stage.index('--prepare-rootfs /sandbox-rootfs') < stage.index('/usr/local/bin/build-rootfs-image.sh /sandbox-rootfs /sandbox-rootfs.img'), name
text = (root / 'launcher/src/main.rs').read_text()
assert '"SANDBOX_RESOLV_CONF"' in text.split('const ALLOW_EXACT:')[1].split('];')[0]
argv = text.split('let guest_args:')[1].split('let env_strs:')[0]
# libkrun init supplies argv[0]. Repeating the binary here makes Bash try to
# interpret /bin/bash itself as a shell script instead of the DNS wrapper.
assert '"/bin/bash"' not in argv
assert '"/sandbox_api/guest-dns.sh".into()' in argv
assert '"--exec".into()' in argv and 'exec_path.clone()' in argv
assert 'let exec_c = cstr("/bin/bash")' in text
assert 'guest_args.iter().map(|arg| cstr(arg))' in text
# Every forwarded entry is checked against the kernel command line's charset,
# quoting and size rules before libkrun can panic on it.
assert text.index('guest_cmdline_problem(&guest_env, &guest_args)') < text.index('ffi::krun_set_exec(')
assert text.index('is_allowed_guest_env_key(k, egress_gateway_enabled)') < text.index('guest_cmdline_problem(&guest_env, &guest_args)')
PY
# The wrapper configures DNS before a custom guest executable, independently
# of the normal API entrypoint and its later /tmp mount.
rm -rf "$TEST_DIR/guest/run/codeapi-resolver"
cat > "$TEST_DIR/bin/mount" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "-t tmpfs -o size=1m,mode=0755 tmpfs $TEST_GUEST_ROOT/run" ]]
[[ "${TEST_MOUNT_FAIL:-false}" != true ]]
STUB
cat > "$TEST_DIR/bin/custom-guest" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat "$TEST_GUEST_ROOT/etc/resolv.conf")" == 'nameserver 127.0.0.11' ]]
[[ ! -v SANDBOX_RESOLV_CONF ]]
echo 'custom guest DNS ready'
STUB
chmod +x "$TEST_DIR/bin/mount" "$TEST_DIR/bin/custom-guest"
PATH="$TEST_DIR/bin:$PATH" TEST_GUEST_ROOT="$TEST_DIR/guest" \
SANDBOX_RESOLV_CONF='nameserver 127.0.0.11' \
bash -c 'source "$1"; run_guest_command "$2" "$3"' -- \
    "$ROOT/api/src/guest-dns.sh" "$TEST_DIR/guest" "$TEST_DIR/bin/custom-guest"

if PATH="$TEST_DIR/bin:$PATH" TEST_GUEST_ROOT="$TEST_DIR/guest" \
TEST_MOUNT_FAIL=true SANDBOX_RESOLV_CONF='nameserver 127.0.0.11' \
bash -c 'source "$1"; run_guest_command "$2" "$3"' -- \
    "$ROOT/api/src/guest-dns.sh" "$TEST_DIR/guest" "$TEST_DIR/bin/custom-guest" > "$TEST_DIR/failed-boot"; then
    echo 'started custom guest despite failed runtime mount' >&2; exit 1
fi
[[ ! -s "$TEST_DIR/failed-boot" ]]
printf 'KVM guest DNS checks passed\n'
