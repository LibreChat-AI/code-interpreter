#!/bin/bash
set -euo pipefail

rootfs="${1:?usage: build-rootfs-image.sh ROOTFS_DIR OUTPUT_IMAGE}"
image="${2:?usage: build-rootfs-image.sh ROOTFS_DIR OUTPUT_IMAGE}"

if [ ! -d "$rootfs" ]; then
    echo "rootfs directory not found: $rootfs" >&2
    exit 1
fi

mkdir -p "$rootfs/dev" "$rootfs/proc" "$rootfs/sys" "$rootfs/tmp" "$rootfs/run" "$rootfs/mnt"
chmod 1777 "$rootfs/tmp"

used_kib=$(du -sk --apparent-size "$rootfs" | awk '{print $1}')
# Give ext4 enough headroom for metadata and future small additions, then shrink
# the filesystem after population so the final raw image stays compact.
size_mib=$(( (used_kib * 13 / 10 + 262144 + 1023) / 1024 ))
if [ "$size_mib" -lt 256 ]; then
    size_mib=256
fi

rm -f "$image"
truncate -s "${size_mib}M" "$image"
mkfs.ext4 -q -O ^has_journal -E root_owner=0:0 -d "$rootfs" "$image"
e2fsck -fy "$image" >/dev/null
resize2fs -M "$image" >/dev/null
chmod 0444 "$image"

echo "Built ext4 rootfs image at $image ($(du -h "$image" | awk '{print $1}'))"
