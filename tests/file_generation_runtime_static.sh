#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash -n "$ROOT/build-packages.sh"
bash -n "$ROOT/docker/package-init.sh"
python3 - "$ROOT/scripts/verify-file-generation-runtime.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
compile(path.read_text(encoding="utf-8"), str(path), "exec")
PY

for package in libreoffice ffmpeg poppler-utils libpango-1.0-0 libpangoft2-1.0-0 shared-mime-info; do
    grep -F "$package" "$ROOT/api/Dockerfile" >/dev/null
done
if grep -F '    weasyprint \' "$ROOT/api/Dockerfile" >/dev/null; then
    echo 'Debian WeasyPrint is vulnerable; install the patched Python runtime package instead.' >&2
    exit 1
fi

for package in openpyxl xlsxwriter pandas numpy python-docx docxtpl python-pptx pillow pypdf pypdf2 pdfplumber reportlab weasyprint msgpack setuptools; do
    grep -F "$package" "$ROOT/build-packages.sh" >/dev/null
    grep -F "$package" "$ROOT/docker/package-init.sh" >/dev/null
done

grep -F '/pkgs/.bundle.sha256' "$ROOT/build-packages.sh" >/dev/null
grep -F '/pkgs/.bundle.sha256' "$ROOT/docker/package-init.sh" >/dev/null
grep -F '"nanoid": "^3.3.18"' "$ROOT/api/package.json" >/dev/null
grep -F 'NPM_VERSION="${NPM_VERSION:-12.0.2}"' "$ROOT/docker/package-init.sh" >/dev/null
grep -F 'NPM_TAR_VERSION="${NPM_TAR_VERSION:-7.5.21}"' "$ROOT/docker/package-init.sh" >/dev/null
grep -F 'NPM_BRACE_EXPANSION_VERSION="${NPM_BRACE_EXPANSION_VERSION:-5.0.9}"' "$ROOT/docker/package-init.sh" >/dev/null
grep -F 'NPM_IP_ADDRESS_VERSION="${NPM_IP_ADDRESS_VERSION:-10.3.1}"' "$ROOT/docker/package-init.sh" >/dev/null
grep -F 'NPM_VERSION="${NPM_VERSION:-12.0.2}"' "$ROOT/build-packages.sh" >/dev/null
grep -F 'NPM_TAR_VERSION="${NPM_TAR_VERSION:-7.5.21}"' "$ROOT/build-packages.sh" >/dev/null
grep -F 'NPM_BRACE_EXPANSION_VERSION="${NPM_BRACE_EXPANSION_VERSION:-5.0.9}"' "$ROOT/build-packages.sh" >/dev/null
grep -F 'NPM_IP_ADDRESS_VERSION="${NPM_IP_ADDRESS_VERSION:-10.3.1}"' "$ROOT/build-packages.sh" >/dev/null
grep -F 'NPM_INSTALL_ATTEMPTS="${NPM_INSTALL_ATTEMPTS:-3}"' "$ROOT/docker/package-init.sh" >/dev/null
sed -n '/^npm_runtime_ready()/,/^}/p' "$ROOT/docker/package-init.sh" \
    | grep -F 'PATH="${node_root}/bin:$PATH"' >/dev/null
grep -F 'remove_nonruntime_pip_sbom "${PKG_DEST}/bin/python3"' "$ROOT/docker/package-init.sh" >/dev/null
grep -F 'bom.cdx.json").unlink(missing_ok=True)' "$ROOT/build-packages.sh" >/dev/null
for package in tar brace-expansion ip-address; do
    grep -F "install_npm_dependency_patch" "$ROOT/docker/package-init.sh" >/dev/null
    grep -F "$package" "$ROOT/docker/package-init.sh" >/dev/null
    grep -F "patch_npm_dependency $package" "$ROOT/build-packages.sh" >/dev/null
done
for package in nanoid@5.1.16 sharp@0.35.0 js-yaml@4.3.1 adm-zip@0.6.0; do
    grep -Fx "$package" "$ROOT/javascript-packages.txt" >/dev/null
done
grep -F '/host-packages/** r,' "$ROOT/apparmor/sandbox-nsjail" >/dev/null
for mount_path in /etc/alternatives /etc/fonts /etc/libreoffice /var/cache/fontconfig; do
    grep -F "src: \"$mount_path\"" "$ROOT/api/config/sandbox.cfg" >/dev/null
done

echo 'OK: file-generation runtime dependencies and validation hooks are present.'
