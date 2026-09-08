#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'chmod -R u+w "$TEST_DIR"; rm -rf "$TEST_DIR"' EXIT
source "$ROOT/api/src/guest-dns.sh"

# Configure the baked link while writable, then only the runtime /tmp target.
mkdir -p "$TEST_DIR/guest/etc" "$TEST_DIR/guest/tmp"
printf 'nameserver 1.1.1.1\n' > "$TEST_DIR/guest/etc/resolv.conf"
prepare_guest_dns "$TEST_DIR/guest"
[[ "$(readlink "$TEST_DIR/guest/etc/resolv.conf")" == '../tmp/codeapi-resolver/resolv.conf' ]]
chmod 555 "$TEST_DIR/guest/etc"
SANDBOX_RESOLV_CONF=$'nameserver 127.0.0.11\noptions ndots:0'
configure_guest_dns "$TEST_DIR/guest"
printf 'nameserver 127.0.0.11\noptions ndots:0\n' > "$TEST_DIR/expected"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"
[[ ! -v SANDBOX_RESOLV_CONF ]]
# Ownership protection: no group/other permissions on the runtime directory.
[[ "$(ls -ld "$TEST_DIR/guest/tmp/codeapi-resolver" | cut -c1-10)" == 'drwx------' ]]

# A fresh boot can use Kubernetes DNS/search paths without rebuilding the root.
rm -rf "$TEST_DIR/guest/tmp/codeapi-resolver"
SANDBOX_RESOLV_CONF=$'nameserver 10.96.0.10\nsearch tenant.svc.cluster.local svc.cluster.local cluster.local\noptions ndots:5'
printf '%s\n' "$SANDBOX_RESOLV_CONF" > "$TEST_DIR/expected"
configure_guest_dns "$TEST_DIR/guest"
cmp "$TEST_DIR/expected" "$TEST_DIR/guest/etc/resolv.conf"

# Never reuse a stale directory or follow an attacker-controlled runtime link.
SANDBOX_RESOLV_CONF='nameserver 127.0.0.11'
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted pre-existing runtime DNS directory' >&2; exit 1
fi
rm -rf "$TEST_DIR/guest/tmp/codeapi-resolver"
mkdir "$TEST_DIR/foreign"
ln -s "$TEST_DIR/foreign" "$TEST_DIR/guest/tmp/codeapi-resolver"
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted runtime DNS symlink' >&2; exit 1
fi
[[ ! -e "$TEST_DIR/foreign/resolv.conf" ]]
rm "$TEST_DIR/guest/tmp/codeapi-resolver"
unset SANDBOX_RESOLV_CONF
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted missing guest resolver' >&2; exit 1
fi
SANDBOX_RESOLV_CONF='# no nameserver'
if configure_guest_dns "$TEST_DIR/guest" 2>/dev/null; then
    echo 'accepted empty guest resolver' >&2; exit 1
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
printf '192.0.2.99 stale-address\n'
STUB
chmod +x "$TEST_DIR/bin/launcher" "$TEST_DIR/bin/getent"
sed "s|/usr/local/bin/launcher|$TEST_DIR/bin/launcher|g" "$ROOT/launcher/entrypoint.sh" > "$TEST_DIR/entrypoint.sh"
PATH="$TEST_DIR/bin:$PATH" \
EGRESS_GATEWAY_URL='https://egress_gateway:3190/base' \
FILE_SERVER_URL='http://[::1]:3000/base' \
SANDBOX_FORWARD_TARGET='tool_call_server:3033' \
LAUNCHER_FILTER_VSOCK_ENOTCONN=false \
TEST_RESOLVER_OUTPUT="$TEST_DIR/forwarded" \
bash "$TEST_DIR/entrypoint.sh"
printf '%s\n' "$(cat /etc/resolv.conf)" > "$TEST_DIR/expected"
cmp "$TEST_DIR/expected" "$TEST_DIR/forwarded"

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
text = (root / 'api/src/entrypoint.sh').read_text()
assert text.index('mount -t tmpfs') < text.index('configure_guest_dns') < text.index('# Create directories needed by NsJail')
PY
printf 'KVM guest DNS checks passed\n'
