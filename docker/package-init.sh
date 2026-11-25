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
NODE_VERSION="${NODE_VERSION:-24.22.1}"
BUN_VERSION="${BUN_VERSION:-1.4.4}"
BASH_PACKAGE_VERSION="${BASH_PACKAGE_VERSION:-5.2.0}"
# Optional extended runtimes (empty value disables the runtime and its
# packages_ready check): Go, Java (Temurin), Rust.
GO_VERSION="${GO_VERSION:-1.27.4}"
JAVA_FEATURE_VERSION="${JAVA_FEATURE_VERSION:-27}"
JAVA_VERSION="${JAVA_VERSION:-27.0.1}"
RUST_VERSION="${RUST_VERSION:-1.100.0}"
INSTALL_FAILED=false
JS_PACKAGE_MANIFEST="${JS_PACKAGE_MANIFEST:-${SCRIPT_DIR}/javascript-packages.txt}"

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
    [ -f "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/.sandbox-pipe-runtime-v1" ] &&
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
    { [ -z "${GO_VERSION}" ] || [ -f "/pkgs/go/${GO_VERSION}/.package-installed" ]; } &&
    { [ -z "${JAVA_VERSION}" ] || [ -f "/pkgs/java/${JAVA_VERSION}/.package-installed" ]; } &&
    { [ -z "${RUST_VERSION}" ] || [ -f "/pkgs/rust/${RUST_VERSION}/.package-installed" ]; } &&
    [ -f "/pkgs/bash/${BASH_PACKAGE_VERSION}/.package-installed" ]
}

write_node_launcher() {
    local destination="$1"
    local launcher
    launcher="$(mktemp "${destination}/.run.XXXXXX")"
    cat > "$launcher" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ]; then
    if [ -L /mnt/data/node_modules ]; then
        LINK_TARGET="$(readlink -m /mnt/data/node_modules)"
        if [ "$LINK_TARGET" != "$MODULE_DIR" ]; then
            case "$LINK_TARGET" in
                "${SCRIPT_DIR%/*/*}/"*/node_modules)
                    ln -sfnT "$MODULE_DIR" /mnt/data/node_modules ;;
            esac
        fi
    elif [ ! -e /mnt/data/node_modules ]; then
        ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
    fi
fi
"${SCRIPT_DIR}/bin/node" "$@"
EOF
    chmod 0755 "$launcher"
    mv -f "$launcher" "${destination}/run"
}

write_bun_launcher() {
    local destination="$1"
    local launcher
    launcher="$(mktemp "${destination}/.run.XXXXXX")"
    cat > "$launcher" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ]; then
    if [ -L /mnt/data/node_modules ]; then
        LINK_TARGET="$(readlink -m /mnt/data/node_modules)"
        if [ "$LINK_TARGET" != "$MODULE_DIR" ]; then
            case "$LINK_TARGET" in
                "${SCRIPT_DIR%/*/*}/"*/node_modules)
                    ln -sfnT "$MODULE_DIR" /mnt/data/node_modules ;;
            esac
        fi
    elif [ ! -e /mnt/data/node_modules ]; then
        ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
    fi
fi
"${SCRIPT_DIR}/bun" run "$@"
EOF
    chmod 0755 "$launcher"
    mv -f "$launcher" "${destination}/run"
}

if [ -f "$MARKER_FILE" ] && [ "$FORCE_REBUILD" != "true" ]; then
    if packages_ready; then
        write_node_launcher "/pkgs/node/${NODE_VERSION}"
        write_bun_launcher "/pkgs/bun/${BUN_VERSION}"
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
"${PKG_DEST}/bin/python3" "${SCRIPT_DIR}/python-runtime/install.py"
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

            write_node_launcher "$NODE_DEST"

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

            write_bun_launcher "$BUN_DEST"

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
# Install Go
# ==============================
echo ""
echo "=============================================="
echo "  Installing Go ${GO_VERSION}"
echo "=============================================="
echo ""

if [ -n "${GO_VERSION}" ]; then
    GO_ARCH=""
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) GO_ARCH="amd64" ;;
        aarch64|arm64) GO_ARCH="arm64" ;;
        *)
            echo "ERROR: Unsupported architecture for Go: $ARCH"
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$GO_ARCH" ]; then
        GO_DEST="/pkgs/go/${GO_VERSION}"
        mkdir -p "$GO_DEST"
        rm -f "$GO_DEST/.package-installed"
        GO_INSTALLED=false

        GO_URL="https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
        cd /tmp
        if curl -fsSL "$GO_URL" -o go.tgz; then
            if tar -xzf go.tgz --strip-components=1 -C "$GO_DEST"; then
                rm -f go.tgz

                ACTUAL_GO_VERSION="$("$GO_DEST/bin/go" version | awk '{print $3}' | sed 's/^go//')"
                if [ "$ACTUAL_GO_VERSION" = "$GO_VERSION" ]; then
                    GO_INSTALLED=true
                else
                    echo "ERROR: Go version mismatch (expected ${GO_VERSION}, got ${ACTUAL_GO_VERSION})"
                    INSTALL_FAILED=true
                fi
            else
                echo "ERROR: Failed to extract Go archive"
                rm -f go.tgz
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download Go"
            INSTALL_FAILED=true
        fi

        if [ "$GO_INSTALLED" = true ]; then
            cat > "$GO_DEST/pkg-info.json" << EOF
{
    "language": "go",
    "version": "${GO_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["golang"],
    "limit_overrides": {
        "run_timeout": 60000,
        "run_cpu_time": 60000
    }
}
EOF

            cat > "$GO_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -eq 0 ]; then
    echo "go: no source file provided" >&2
    exit 2
fi
ENTRY="$1"
shift
mkdir -p /mnt/data/.gocache /mnt/data/.gotmp /mnt/data/.gopath 2>/dev/null || true
if [ -f "${ENTRY}" ] && [[ "${ENTRY}" != *.go ]]; then
    RUNTMP="$(dirname "${ENTRY}")/.gorun"
    mkdir -p "${RUNTMP}" 2>/dev/null || true
    if [ -d "${RUNTMP}" ]; then
        cp -f "${ENTRY}" "${RUNTMP}/entry.go" && ENTRY="${RUNTMP}/entry.go"
    fi
fi
exec "${SCRIPT_DIR}/bin/go" run "${ENTRY}" "$@"
EOF
            chmod +x "$GO_DEST/run"

            cat > "$GO_DEST/.env" << EOF
PATH=${GO_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
GOTOOLCHAIN=local
GOCACHE=/mnt/data/.gocache
GOTMPDIR=/mnt/data/.gotmp
GOPATH=/mnt/data/.gopath
EOF
            touch "$GO_DEST/.exec-workspace"
            echo "$(date +%s)000" > "$GO_DEST/.package-installed"

            echo "Go ${GO_VERSION} installed: $($GO_DEST/bin/go version)"
        fi
    fi
else
    echo "Skipping Go (GO_VERSION empty)"
fi

# ==============================
# Install Java (Temurin)
# ==============================
echo ""
echo "=============================================="
echo "  Installing Java ${JAVA_VERSION} (Temurin)"
echo "=============================================="
echo ""

if [ -n "${JAVA_VERSION}" ]; then
    ADOPTIUM_ARCH=""
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ADOPTIUM_ARCH="x64" ;;
        aarch64|arm64) ADOPTIUM_ARCH="aarch64" ;;
        *)
            echo "ERROR: Unsupported architecture for Java: $ARCH"
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$ADOPTIUM_ARCH" ]; then
        JAVA_DEST="/pkgs/java/${JAVA_VERSION}"
        mkdir -p "$JAVA_DEST"
        rm -f "$JAVA_DEST/.package-installed"
        JAVA_INSTALLED=false

        JDK_URL="https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE_VERSION}/ga/linux/${ADOPTIUM_ARCH}/jdk/hotspot/normal/eclipse"
        cd /tmp
        if curl -fsSL "$JDK_URL" -o jdk.tgz; then
            if tar -xzf jdk.tgz --strip-components=1 -C "$JAVA_DEST"; then
                rm -f jdk.tgz

                ACTUAL_JAVA_VERSION="$("$JAVA_DEST/bin/java" --version | head -n 1 | sed -nE 's/[^0-9]*([0-9]+[.][0-9]+[.][0-9]+).*/\1/p')"
                if [ "$ACTUAL_JAVA_VERSION" = "$JAVA_VERSION" ]; then
                    JAVA_INSTALLED=true
                else
                    echo "ERROR: Java version mismatch (expected ${JAVA_VERSION}, got ${ACTUAL_JAVA_VERSION})"
                    INSTALL_FAILED=true
                fi
            else
                echo "ERROR: Failed to extract Java archive"
                rm -f jdk.tgz
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download Java"
            INSTALL_FAILED=true
        fi

        if [ "$JAVA_INSTALLED" = true ]; then
            cat > "$JAVA_DEST/pkg-info.json" << EOF
{
    "language": "java",
    "version": "${JAVA_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["openjdk", "jdk"]
}
EOF

            cat > "$JAVA_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -eq 0 ]; then
    echo "java: no source file provided" >&2
    exit 2
fi
ENTRY="$1"
shift
if [ -f "${ENTRY}" ] && [[ "${ENTRY}" != *.java ]]; then
    DIR="$(dirname "${ENTRY}")"
    BASE="$(basename "${ENTRY}")"
    BASE="${BASE%.*}"
    if [ -z "${BASE}" ]; then
        BASE="entry"
    fi
    cp -f "${ENTRY}" "${DIR}/.${BASE}.java" && ENTRY="${DIR}/.${BASE}.java"
fi
exec "${SCRIPT_DIR}/bin/java" "${ENTRY}" "$@"
EOF
            chmod +x "$JAVA_DEST/run"

            cat > "$JAVA_DEST/.env" << EOF
PATH=${JAVA_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
JAVA_HOME=${JAVA_DEST}
JDK_JAVA_OPTIONS=-Xmx256m -XX:MaxMetaspaceSize=192m -XX:CompressedClassSpaceSize=192m -XX:ReservedCodeCacheSize=96m
EOF

            echo "$(date +%s)000" > "$JAVA_DEST/.package-installed"

            echo "Java ${JAVA_VERSION} installed: $($JAVA_DEST/bin/java --version | head -n 1)"
        fi
    fi
else
    echo "Skipping Java (JAVA_VERSION empty)"
fi

# ==============================
# Install Rust
# ==============================
echo ""
echo "=============================================="
echo "  Installing Rust ${RUST_VERSION}"
echo "=============================================="
echo ""

if [ -n "${RUST_VERSION}" ]; then
    RUST_TARGET=""
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) RUST_TARGET="x86_64-unknown-linux-gnu" ;;
        aarch64|arm64) RUST_TARGET="aarch64-unknown-linux-gnu" ;;
        *)
            echo "ERROR: Unsupported architecture for Rust: $ARCH"
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$RUST_TARGET" ]; then
        RUST_DEST="/pkgs/rust/${RUST_VERSION}"
        mkdir -p "$RUST_DEST"
        rm -f "$RUST_DEST/.package-installed"
        RUST_INSTALLED=false

        cd /tmp
        if curl -fsSL -o rustup-init "https://static.rust-lang.org/rustup/dist/${RUST_TARGET}/rustup-init"; then
            chmod +x rustup-init
            if RUSTUP_HOME="${RUST_DEST}/rustup" CARGO_HOME="${RUST_DEST}/cargo" ./rustup-init -y \
                --no-modify-path \
                --profile minimal \
                --default-toolchain "${RUST_VERSION}"; then
                rm -f rustup-init

                RUST_TOOLCHAIN_DIR="$(ls -d "${RUST_DEST}/rustup/toolchains/"* 2>/dev/null | head -n 1)"
                if [ -n "$RUST_TOOLCHAIN_DIR" ] && [ -x "$RUST_TOOLCHAIN_DIR/bin/rustc" ]; then
                    ACTUAL_RUST_VERSION="$("$RUST_TOOLCHAIN_DIR/bin/rustc" --version | awk '{print $2}')"
                    if [ "$ACTUAL_RUST_VERSION" = "$RUST_VERSION" ] && [ -x "$RUST_TOOLCHAIN_DIR/bin/cargo" ]; then
                        RUST_INSTALLED=true
                    else
                        echo "ERROR: Rust version mismatch (expected ${RUST_VERSION}, got ${ACTUAL_RUST_VERSION})"
                        INSTALL_FAILED=true
                    fi
                else
                    echo "ERROR: Rust toolchain not found after rustup install"
                    INSTALL_FAILED=true
                fi
            else
                echo "ERROR: rustup-init failed"
                rm -f rustup-init
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download rustup-init"
            INSTALL_FAILED=true
        fi

        if [ "$RUST_INSTALLED" = true ]; then
            cat > "$RUST_DEST/pkg-info.json" << EOF
{
    "language": "rust",
    "version": "${RUST_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["rustc"],
    "limit_overrides": {
        "run_timeout": 60000,
        "run_cpu_time": 60000
    }
}
EOF

            cat > "$RUST_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLCHAIN_BIN="$(ls -d "${SCRIPT_DIR}"/rustup/toolchains/*/bin 2>/dev/null | head -n 1)"
if [ -z "${TOOLCHAIN_BIN}" ] || [ ! -x "${TOOLCHAIN_BIN}/rustc" ]; then
    echo "rust: toolchain not found in ${SCRIPT_DIR}/rustup/toolchains" >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then
    echo "rust: no source file provided" >&2
    exit 2
fi
ENTRY="$1"
shift
if [ -f "${ENTRY}" ] && [ "$(basename "${ENTRY}")" = "Cargo.toml" ]; then
    mkdir -p /mnt/data/.cargo 2>/dev/null || true
    cd "$(dirname "${ENTRY}")" || exit 1
    exec "${TOOLCHAIN_BIN}/cargo" run --offline "$@"
fi
if [ -f "${ENTRY}" ] && [[ "${ENTRY}" != *.rs ]]; then
    DIR="$(dirname "${ENTRY}")"
    BASE="$(basename "${ENTRY}")"
    BASE="${BASE%.*}"
    if [ -z "${BASE}" ]; then
        BASE="entry"
    fi
    cp -f "${ENTRY}" "${DIR}/.${BASE}.rs" && ENTRY="${DIR}/.${BASE}.rs"
fi
OUT_DIR=/mnt/data/.rust-build
mkdir -p "${OUT_DIR}" 2>/dev/null || OUT_DIR=/tmp
mkdir -p /mnt/data/.rust-tmp 2>/dev/null || true
"${TOOLCHAIN_BIN}/rustc" --edition "${RUSTC_EDITION:-2021}" -o "${OUT_DIR}/app" "${ENTRY}" || exit 1
exec "${OUT_DIR}/app" "$@"
EOF
            chmod +x "$RUST_DEST/run"

            cat > "$RUST_DEST/.env" << EOF
PATH=${RUST_TOOLCHAIN_DIR}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
CARGO_HOME=/mnt/data/.cargo
RUSTC_EDITION=2024
TMPDIR=/mnt/data/.rust-tmp
EOF
            touch "$RUST_DEST/.exec-workspace"
            echo "$(date +%s)000" > "$RUST_DEST/.package-installed"

            echo "Rust ${RUST_VERSION} installed: $($RUST_TOOLCHAIN_DIR/bin/rustc --version)"
        fi
    fi
else
    echo "Skipping Rust (RUST_VERSION empty)"
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
BASH_DEST="/pkgs/bash/${BASH_PACKAGE_VERSION}"
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

cat > "$BASH_DEST/run" << 'EOF'
#!/bin/bash
bash "$@"
EOF
chmod +x "$BASH_DEST/run"

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
