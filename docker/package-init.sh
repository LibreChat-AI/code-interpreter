#!/bin/bash
#
# Package Init Script
# Installs Python, Node, Bun, and Bash runtime packages for the NsJail sandbox.
# Runs inside the package-init container to populate the packages PVC.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_FILE="/pkgs/.initialized"
FORCE_REBUILD="${FORCE_REBUILD:-false}"
PYTHON_VERSION="${PYTHON_VERSION:-3.14.4}"
PYTHON_SITE_VERSION="${PYTHON_VERSION%.*}"
PYTHON_ALIAS="python${PYTHON_SITE_VERSION}"
# "uv" (default) installs the Python package list noticeably faster than pip.
# Set to "pip" to use the previous behavior. Like any unpinned "latest
# compatible" install, the exact resolved versions can differ run to run (and
# between installers) for packages with no version constraint in the list
# below — that's inherent to installing unpinned packages, not specific to uv.
PYTHON_PACKAGE_INSTALLER="${PYTHON_PACKAGE_INSTALLER:-uv}"
UV_VERSION="${UV_VERSION:-0.11.26}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
BASH_PACKAGE_VERSION="${BASH_PACKAGE_VERSION:-5.2.0}"
BASH_DEST="/pkgs/bash/${BASH_PACKAGE_VERSION}"
INSTALL_FAILED=false
JS_PACKAGE_MANIFEST="${JS_PACKAGE_MANIFEST:-${SCRIPT_DIR}/javascript-packages.txt}"
BASH_RUN_SCRIPT="${BASH_RUN_SCRIPT:-${SCRIPT_DIR}/bash-run.sh}"

load_js_packages() {
    if [ ! -f "$JS_PACKAGE_MANIFEST" ]; then
        echo "ERROR: Missing JavaScript package manifest: $JS_PACKAGE_MANIFEST"
        INSTALL_FAILED=true
        JS_PACKAGES=()
        return
    fi

    JS_PACKAGES=()
    while IFS= read -r package_spec || [ -n "$package_spec" ]; do
        [[ "$package_spec" =~ ^[[:space:]]*(#|$) ]] && continue
        JS_PACKAGES+=("$package_spec")
    done < "$JS_PACKAGE_MANIFEST"
    if [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "ERROR: JavaScript package manifest is empty: $JS_PACKAGE_MANIFEST"
        INSTALL_FAILED=true
    fi
}

validate_bun_package_batch_size() {
    local batch_size="${BUN_PACKAGE_BATCH_SIZE:-4}"
    if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: BUN_PACKAGE_BATCH_SIZE must be a positive integer (got: ${batch_size})" >&2
        return 1
    fi
    printf '%s\n' "$batch_size"
}

package_name_from_spec() {
    local spec="$1"
    echo "${spec%@*}"
}

package_version_from_spec() {
    local spec="$1"
    echo "${spec##*@}"
}

js_packages_ready() {
    local pkg_root="$1"
    local spec package_name package_version package_json
    [ "${#JS_PACKAGES[@]}" -gt 0 ] || return 1
    for spec in "${JS_PACKAGES[@]}"; do
        package_name="$(package_name_from_spec "$spec")"
        package_version="$(package_version_from_spec "$spec")"
        package_json="${pkg_root}/node_modules/${package_name}/package.json"
        [ -f "$package_json" ] || return 1
        if [ "$package_name" != "$package_version" ]; then
            grep -F "\"version\": \"${package_version}\"" "$package_json" >/dev/null || return 1
        fi
    done
}

load_js_packages

echo "=============================================="
echo "  Code Interpreter - Package Init"
echo "=============================================="
echo ""

packages_ready() {
    [ -f "/pkgs/python/${PYTHON_VERSION}/.package-installed" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/PIL" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/markitdown" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/chdb" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/statsmodels" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/rasterio" ] &&
    [ -f "/pkgs/node/${NODE_VERSION}/.package-installed" ] &&
    js_packages_ready "/pkgs/node/${NODE_VERSION}" &&
    [ -f "/pkgs/bun/${BUN_VERSION}/.package-installed" ] &&
    js_packages_ready "/pkgs/bun/${BUN_VERSION}" &&
    [ -f "/pkgs/bash/${BASH_PACKAGE_VERSION}/.package-installed" ]
}

sync_bash_run_wrapper() {
    if [ ! -f "$BASH_RUN_SCRIPT" ]; then
        echo "ERROR: Missing Bash run wrapper: $BASH_RUN_SCRIPT" >&2
        return 1
    fi
    if ! cmp -s "$BASH_RUN_SCRIPT" "$BASH_DEST/run"; then
        echo "Updating Bash run wrapper"
        if ! install -m 0755 "$BASH_RUN_SCRIPT" "$BASH_DEST/run"; then
            return 1
        fi
    fi
    return 0
}

if [ -f "$MARKER_FILE" ] && [ "$FORCE_REBUILD" != "true" ]; then
    if packages_ready; then
        sync_bash_run_wrapper
        echo "Packages already initialized (marker file exists)"
        echo "Set FORCE_REBUILD=true to force reinstall"
        echo ""
        echo "Installed packages:"
        ls -la /pkgs/ 2>/dev/null || echo "  (none)"
        exit 0
    fi
    echo "Initialization marker exists, but one or more required packages are missing"
    echo "Continuing package initialization"
fi

if [ "$FORCE_REBUILD" = "true" ] && [ -d "/pkgs" ]; then
    echo "Force rebuild requested, cleaning existing packages..."
    rm -rf /pkgs/* /pkgs/.initialized
fi

# ==============================
# Install Python
# ==============================
echo ""
echo "=============================================="
echo "  Installing Python ${PYTHON_VERSION}"
echo "=============================================="
echo ""

PKG_DEST="/pkgs/python/${PYTHON_VERSION}"
mkdir -p "$PKG_DEST"
rm -f "$PKG_DEST/.package-installed"

cd /tmp
wget -q "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz"
tar xf "Python-${PYTHON_VERSION}.tar.xz"
cd "Python-${PYTHON_VERSION}"
./configure --prefix="$PKG_DEST" --enable-optimizations 2>/dev/null
make -j$(nproc)
make install
cd /tmp
rm -rf /tmp/Python-${PYTHON_VERSION}*

cat > "$PKG_DEST/pkg-info.json" << EOF
{
    "language": "python",
    "version": "${PYTHON_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["py", "py3", "python3", "${PYTHON_ALIAS}"]
}
EOF

cat > "$PKG_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/bin/python3" "$@"
EOF
chmod +x "$PKG_DEST/run"

echo "PATH=${PKG_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." > "$PKG_DEST/.env"

echo "Python ${PYTHON_VERSION} installed"

# ==============================
# Install Python packages
# ==============================
echo ""
echo "=============================================="
echo "  Installing Python packages"
echo "=============================================="
echo ""

PIP_PATH="${PKG_DEST}/bin/pip3"
if [ -f "$PIP_PATH" ]; then
    "$PIP_PATH" install --upgrade pip 2>/dev/null || true
    PYTHON_PACKAGES_INSTALLED=false

    PYTHON_INSTALL_CMD=("$PIP_PATH" install)
    if [ "$PYTHON_PACKAGE_INSTALLER" = "uv" ]; then
        "$PIP_PATH" install "uv==${UV_VERSION}" 2>/dev/null || true
        PYTHON_INSTALL_CMD=("${PKG_DEST}/bin/uv" pip install --python "${PKG_DEST}/bin/python3")
    fi

    # MarkItDown 0.1.x initializes Magika/ONNX at import time; the aarch64
    # onnxruntime wheel segfaults under NsJail. 0.0.2 still supports PPTX via
    # python-pptx without that native dependency.
    if ! "${PYTHON_INSTALL_CMD[@]}" \
        openpyxl \
        matplotlib \
        numpy \
        pandas \
        lifelines \
        scipy \
        statsmodels \
        pillow \
        scikit-learn \
        scikit-image \
        networkx \
        sympy \
        wordcloud \
        pypdf2 \
        python-docx \
        imageio \
        seaborn \
        plotly \
        beautifulsoup4 \
        tabulate \
        xlrd \
        numba \
        patsy \
        numexpr \
        pyarrow \
        chdb==4.1.6 \
        markitdown==0.0.2 \
        python-pptx \
        xlsxwriter \
        docx2python \
        docxtpl \
        mammoth \
        pdf2image \
        "pdfminer.six" \
        reportlab \
        opencv-python-headless \
        svglib \
        cairosvg \
        exifread \
        hachoir \
        python-barcode \
        qrcode \
        fonttools \
        pytesseract \
        pdfminer \
        vsdx \
        rasterio \
        rioxarray \
        geopandas \
        pyogrio \
        pyproj \
        osmnx \
        folium \
        gpxpy; then
        echo "ERROR: Python package installation failed"
        INSTALL_FAILED=true
    else
        PYTHON_PACKAGES_INSTALLED=true
    fi

    "$PIP_PATH" install --upgrade six 2>/dev/null || true
    if [ "$PYTHON_PACKAGES_INSTALLED" = true ]; then
        echo "$(date +%s)000" > "$PKG_DEST/.package-installed"
    fi

    echo ""
    echo "Installed Python packages:"
    "$PIP_PATH" list 2>/dev/null | head -20
else
    echo "ERROR: pip not found at $PIP_PATH"
    INSTALL_FAILED=true
fi

# ==============================
# Install Node.js
# ==============================
echo ""
echo "=============================================="
echo "  Installing Node.js ${NODE_VERSION}"
echo "=============================================="
echo ""

NODE_DEST="/pkgs/node/${NODE_VERSION}"
mkdir -p "$NODE_DEST"
rm -f "$NODE_DEST/.package-installed"
NODE_INSTALLED=false

ARCH=$(uname -m)
case "$ARCH" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *)
        echo "ERROR: Unsupported architecture for Node.js: $ARCH"
        NODE_ARCH=""
        INSTALL_FAILED=true
        ;;
esac

if [ -n "$NODE_ARCH" ]; then
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    cd /tmp
    if curl -fsSL "$NODE_URL" -o node.tar.xz; then
        if tar -xJf node.tar.xz --strip-components=1 -C "$NODE_DEST"; then
            rm -f node.tar.xz

            cat > "$NODE_DEST/pkg-info.json" << EOF
{
    "language": "node",
    "version": "${NODE_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["nodejs", "node-js", "node-javascript"]
}
EOF

            cat > "$NODE_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
fi
"${SCRIPT_DIR}/bin/node" "$@"
EOF
            chmod +x "$NODE_DEST/run"

            {
                echo "PATH=${NODE_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:."
                echo "NODE_PATH=${NODE_DEST}/node_modules"
            } > "$NODE_DEST/.env"

            NODE_INSTALLED=true
            echo "Node.js ${NODE_VERSION} installed: $($NODE_DEST/bin/node --version)"
        else
            echo "ERROR: Failed to extract Node.js archive"
            rm -f node.tar.xz
            INSTALL_FAILED=true
        fi
    else
        echo "ERROR: Failed to download Node.js"
        INSTALL_FAILED=true
    fi
fi

# ==============================
# Install JavaScript packages for Node.js
# ==============================
echo ""
echo "=============================================="
echo "  Installing Node.js packages"
echo "=============================================="
echo ""

NODE_NPM="${NODE_DEST}/bin/npm"
if [ "$NODE_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -gt 0 ] && [ -f "$NODE_NPM" ]; then
    if ! PATH="${NODE_DEST}/bin:$PATH" "$NODE_NPM" install \
        --prefix "$NODE_DEST" \
        --omit=dev \
        --no-audit \
        --no-fund \
        --save-exact \
        --package-lock=false \
        "${JS_PACKAGES[@]}"; then
        echo "ERROR: Node.js package installation failed"
        INSTALL_FAILED=true
    else
        echo "$(date +%s)000" > "$NODE_DEST/.package-installed"
    fi

    echo ""
    echo "Installed Node.js packages:"
    PATH="${NODE_DEST}/bin:$PATH" "$NODE_NPM" ls --prefix "$NODE_DEST" --depth=0 2>/dev/null | head -40 || true
elif [ "$NODE_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
    echo "ERROR: No JavaScript packages loaded for Node.js"
    INSTALL_FAILED=true
elif [ "$NODE_INSTALLED" = true ]; then
    echo "ERROR: npm not found at $NODE_NPM"
    INSTALL_FAILED=true
else
    echo "Skipping Node.js package installation because Node.js was not installed"
fi

# ==============================
# Install Bun
# ==============================
echo ""
echo "=============================================="
echo "  Installing Bun ${BUN_VERSION}"
echo "=============================================="
echo ""

BUN_DEST="/pkgs/bun/${BUN_VERSION}"
mkdir -p "$BUN_DEST"
rm -f "$BUN_DEST/.package-installed"
BUN_INSTALLED=false

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  BUN_ARCH="x64" ;;
    aarch64|arm64) BUN_ARCH="aarch64" ;;
    *)
        echo "ERROR: Unsupported architecture for Bun: $ARCH"
        BUN_ARCH=""
        INSTALL_FAILED=true
        ;;
esac

if [ -n "$BUN_ARCH" ]; then
    BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip"
    cd /tmp
    if curl -fsSL "$BUN_URL" -o bun.zip; then
        if unzip -o bun.zip && mv bun-linux-${BUN_ARCH}/bun "$BUN_DEST/"; then
            chmod +x "$BUN_DEST/bun"
            rm -rf bun.zip bun-linux-${BUN_ARCH}

            cat > "$BUN_DEST/pkg-info.json" << EOF
{
    "language": "bun",
    "version": "${BUN_VERSION}",
    "build_platform": "docker-debian",
    "provides": [
        { "language": "typescript", "aliases": ["bun-ts"] },
        { "language": "javascript", "aliases": ["bun-js"] }
    ]
}
EOF

            cat > "$BUN_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
fi
"${SCRIPT_DIR}/bun" run "$@"
EOF
            chmod +x "$BUN_DEST/run"

            {
                echo "PATH=${BUN_DEST}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:."
                echo "NODE_PATH=${BUN_DEST}/node_modules"
            } > "$BUN_DEST/.env"

            BUN_INSTALLED=true
            echo "Bun ${BUN_VERSION} installed: $($BUN_DEST/bun --version)"
        else
            echo "ERROR: Failed to extract Bun archive"
            rm -rf bun.zip bun-linux-${BUN_ARCH}
            INSTALL_FAILED=true
        fi
    else
        echo "ERROR: Failed to download Bun"
        INSTALL_FAILED=true
    fi
fi

# ==============================
# Install JavaScript packages for Bun
# ==============================
echo ""
echo "=============================================="
echo "  Installing Bun packages"
echo "=============================================="
echo ""

if [ "$BUN_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -gt 0 ] && [ -f "$BUN_DEST/bun" ]; then
    cd "$BUN_DEST"
    BUN_BATCH_FAILED=false
    if ! BUN_PACKAGE_BATCH_SIZE="$(validate_bun_package_batch_size)"; then
        INSTALL_FAILED=true
    else
        BUN_BATCH_COUNT=$(( (${#JS_PACKAGES[@]} + BUN_PACKAGE_BATCH_SIZE - 1) / BUN_PACKAGE_BATCH_SIZE ))
        BUN_BATCH_INDEX=1

        for ((i = 0; i < ${#JS_PACKAGES[@]}; i += BUN_PACKAGE_BATCH_SIZE)); do
            echo "Installing Bun package batch ${BUN_BATCH_INDEX}/${BUN_BATCH_COUNT}"
            if ! BUN_CONFIG_MAX_HTTP_REQUESTS="${BUN_CONFIG_MAX_HTTP_REQUESTS:-8}" ./bun add --exact "${JS_PACKAGES[@]:i:BUN_PACKAGE_BATCH_SIZE}"; then
                BUN_BATCH_FAILED=true
                break
            fi
            BUN_BATCH_INDEX=$((BUN_BATCH_INDEX + 1))
        done

        if [ "$BUN_BATCH_FAILED" = true ]; then
            echo "ERROR: Bun package installation failed"
            INSTALL_FAILED=true
        else
            echo "$(date +%s)000" > "$BUN_DEST/.package-installed"
        fi
    fi

    echo ""
    echo "Installed Bun packages:"
    ./bun pm ls --depth 0 2>/dev/null | head -40 || true
elif [ "$BUN_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
    echo "ERROR: No JavaScript packages loaded for Bun"
    INSTALL_FAILED=true
elif [ "$BUN_INSTALLED" = true ]; then
    echo "ERROR: bun not found at $BUN_DEST/bun"
    INSTALL_FAILED=true
else
    echo "Skipping Bun package installation because Bun was not installed"
fi

# ==============================
# Register Bash
# ==============================
echo ""
echo "=============================================="
echo "  Registering Bash"
echo "=============================================="
echo ""

SYSTEM_BASH_VERSION=$(bash --version | sed -nE '1s/.* ([0-9]+[.][0-9]+[.][0-9]+).*/\1/p')
mkdir -p "$BASH_DEST"

cat > "$BASH_DEST/pkg-info.json" << EOF
{
    "language": "bash",
    "version": "${BASH_PACKAGE_VERSION}",
    "build_platform": "docker-debian",
    "system_version": "${SYSTEM_BASH_VERSION}",
    "aliases": ["sh"]
}
EOF

if ! sync_bash_run_wrapper; then
    INSTALL_FAILED=true
fi

echo "PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." > "$BASH_DEST/.env"
echo "$(date +%s)000" > "$BASH_DEST/.package-installed"

echo "Bash ${BASH_PACKAGE_VERSION} registered (using system binary ${SYSTEM_BASH_VERSION})"

# ==============================
# Finalize
# ==============================
echo ""
echo "=============================================="
echo "  Finalizing"
echo "=============================================="
echo ""

echo "Setting permissions..."
chmod -R a+rX /pkgs/ 2>/dev/null || true

if [ "$INSTALL_FAILED" = true ]; then
    echo ""
    echo "=============================================="
    echo "  ERROR: Package initialization FAILED"
    echo "=============================================="
    echo ""
    echo "One or more packages failed to install."
    echo "Marker file NOT created -- next run will retry."
    echo ""
    echo "Partial packages on disk:"
    ls -la /pkgs/
    echo ""
    exit 1
fi

echo "Creating initialization marker..."
cat > "$MARKER_FILE" << MARKER
initialized_at=$(date -Iseconds)
python_version=${PYTHON_VERSION}
node_version=${NODE_VERSION}
bun_version=${BUN_VERSION}
packages=$(ls /pkgs/ 2>/dev/null | tr '\n' ',')
MARKER

echo ""
echo "=============================================="
echo "  Package initialization complete!"
echo "=============================================="
echo ""
echo "Installed packages:"
ls -la /pkgs/
echo ""
