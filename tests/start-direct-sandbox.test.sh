#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker/start-direct-sandbox.sh"

grep -Fq 'mount -o bind,ro "$ROOTFS/usr" /usr' "$script"
grep -Fq '[ -d /host-packages ] && [ "$(ls -A /host-packages 2>/dev/null)" ]' "$script"
grep -Fq 'using packages from $ROOTFS/pkgs' "$script"
if grep -Fq 'mount -o bind,ro "$ROOTFS/usr/sbin" /usr/sbin' "$script" \
  || grep -Fq 'mount -o bind,ro "$ROOTFS/usr/bin" /usr/bin' "$script"; then
  echo "start-direct-sandbox.sh still bind-mounts merged /usr subdirectories" >&2
  exit 1
fi

echo "merged /usr mount contract passed"
