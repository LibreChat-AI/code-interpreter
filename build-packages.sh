#!/usr/bin/env bash
#
# Package builder for Code Interpreter API
# Installs Python, Node, Bun, and Bash runtime packages for the NsJail sandbox.
# Works on both arm64 (Apple Silicon) and amd64 (Linux/WSL).
#
# Usage:
#   ./build-packages.sh              # Build all packages
#
# Environment Variables:
#   PYTHON_VERSION=3.14.4    # Python version to install
#   NODE_VERSION=24.22.1     # Node.js version to install
#   BUN_VERSION=1.4.4       # Bun version to install
#   BASH_PACKAGE_VERSION=5.2.0 # Bash package registration version (semver-like x.y.z)
#   SKIP_PYTHON_PACKAGES=1   # Skip Python pip packages
#   SKIP_JS_PACKAGES=1       # Skip JavaScript npm packages for Node/Bun
#   SKIP_NODE=1              # Skip Node.js installation
#   SKIP_BUN=1               # Skip Bun installation
#   SKIP_PYTHON=1            # Skip Python installation
#   FORCE_REBUILD=1          # Delete existing packages first
#   BUN_PACKAGE_BATCH_SIZE=4 # Positive integer number of direct JS packages per Bun install batch
#   SKIP_GO=1               # Skip Go installation
#   SKIP_JAVA=1             # Skip Java installation
#   SKIP_RUST=1             # Skip Rust installation
#   GO_VERSION=1.27.4       # Go version to install
#   JAVA_FEATURE_VERSION=27 # Temurin feature release used for the download URL
#   JAVA_VERSION=27.0.1     # Temurin version to install (must match the GA build of the feature)
#   RUST_VERSION=1.100.0    # Rust version to install
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_VERSION="${PYTHON_VERSION:-3.14.4}"
NODE_VERSION="${NODE_VERSION:-24.22.1}"
BUN_VERSION="${BUN_VERSION:-1.4.4}"
GO_VERSION="${GO_VERSION:-1.27.4}"
JAVA_FEATURE_VERSION="${JAVA_FEATURE_VERSION:-27}"
JAVA_VERSION="${JAVA_VERSION:-27.0.1}"
RUST_VERSION="${RUST_VERSION:-1.100.0}"
PACKAGES_DIR="./data/pkgs"
JS_PACKAGE_MANIFEST="${JS_PACKAGE_MANIFEST:-${SCRIPT_DIR}/javascript-packages.txt}"

load_js_packages() {
    if [ ! -f "$JS_PACKAGE_MANIFEST" ]; then
        echo "Missing JavaScript package manifest: $JS_PACKAGE_MANIFEST"
        exit 1
    fi

    JS_PACKAGES=()
    while IFS= read -r package_spec || [ -n "$package_spec" ]; do
        [[ "$package_spec" =~ ^[[:space:]]*(#|$) ]] && continue
        JS_PACKAGES+=("$package_spec")
    done < "$JS_PACKAGE_MANIFEST"
    if [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "JavaScript package manifest is empty: $JS_PACKAGE_MANIFEST"
        exit 1
    fi
}

should_load_js_packages() {
    [ "${SKIP_JS_PACKAGES:-}" != "1" ] &&
        { [ "${SKIP_NODE:-}" != "1" ] || [ "${SKIP_BUN:-}" != "1" ]; }
}

validate_bun_package_batch_size() {
    local batch_size="${BUN_PACKAGE_BATCH_SIZE:-4}"
    if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: BUN_PACKAGE_BATCH_SIZE must be a positive integer (got: ${batch_size})" >&2
        return 1
    fi
    printf '%s\n' "$batch_size"
}

if should_load_js_packages; then
    load_js_packages
else
    JS_PACKAGES=()
fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  BUN_ARCH="x64"; NODE_ARCH="x64"; echo "Detected: amd64 (Linux/WSL)" ;;
    arm64|aarch64) BUN_ARCH="aarch64"; NODE_ARCH="arm64"; echo "Detected: arm64 (Apple Silicon)" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [ "${FORCE_REBUILD:-}" = "1" ]; then
    echo "Force rebuild requested, cleaning existing packages..."
    docker run --rm -v "$PWD/data/pkgs:/pkgs" alpine sh -c "rm -rf /pkgs/*" 2>/dev/null || rm -rf "$PACKAGES_DIR"/*
fi

mkdir -p "$PACKAGES_DIR"

CONTAINER_NAME="pkg-builder-$$"
cleanup() {
    echo "Cleaning up..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

install_python() {
    if [ "${SKIP_PYTHON:-}" = "1" ]; then
        echo "Skipping Python (SKIP_PYTHON=1)"
        return 0
    fi

    local pkg_dest="/pkgs/python/${PYTHON_VERSION}"
    local python_minor="${PYTHON_VERSION%.*}"

    echo "=============================================="
    echo "  Installing Python ${PYTHON_VERSION}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        wget -q https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz
        tar xf Python-${PYTHON_VERSION}.tar.xz
        cd Python-${PYTHON_VERSION}
        ./configure --prefix=${pkg_dest} --enable-optimizations 2>/dev/null
        make -j\$(nproc)
        make install
        rm -rf /tmp/Python-${PYTHON_VERSION}*
    "

    docker cp "$SCRIPT_DIR/docker/python-runtime" "$CONTAINER_NAME:/tmp/python-runtime"
    docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/python3" /tmp/python-runtime/install.py

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"python\",
    \"version\": \"${PYTHON_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"py\", \"py3\", \"python3\", \"python${python_minor}\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
\"\${SCRIPT_DIR}/bin/python3\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
    "

    if [ "${SKIP_PYTHON_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/python3" -m pip install --upgrade pip 2>/dev/null || true

    echo "Python ${PYTHON_VERSION} installed"
}

install_python_packages() {
    if [ "${SKIP_PYTHON:-}" = "1" ] || [ "${SKIP_PYTHON_PACKAGES:-}" = "1" ]; then
        echo "Skipping Python packages (SKIP_PYTHON=1 or SKIP_PYTHON_PACKAGES=1)"
        return 0
    fi

    local pip_path="/pkgs/python/${PYTHON_VERSION}/bin/pip3"

    echo "=============================================="
    echo "  Installing Python packages"
    echo "=============================================="

    # MarkItDown 0.1.x initializes Magika/ONNX at import time; the aarch64
    # onnxruntime wheel segfaults under NsJail. 0.0.2 still supports PPTX via
    # python-pptx without that native dependency.
    local python_packages_installed=false
    if docker exec "$CONTAINER_NAME" "$pip_path" install \
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
        python_packages_installed=true
    else
        echo "ERROR: Python package installation failed"
        return 1
    fi

    docker exec "$CONTAINER_NAME" "$pip_path" install --upgrade six 2>/dev/null || true
    if [ "$python_packages_installed" = true ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > /pkgs/python/${PYTHON_VERSION}/.package-installed"
    fi

    echo "Installed Python packages:"
    docker exec "$CONTAINER_NAME" "$pip_path" list 2>/dev/null | head -20
}

install_node() {
    if [ "${SKIP_NODE:-}" = "1" ]; then
        echo "Skipping Node.js (SKIP_NODE=1)"
        return 0
    fi

    local pkg_dest="/pkgs/node/${NODE_VERSION}"

    echo "=============================================="
    echo "  Installing Node.js ${NODE_VERSION}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz
        tar -xJf node.tar.xz --strip-components=1 -C ${pkg_dest}
        rm -f node.tar.xz
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"node\",
    \"version\": \"${NODE_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"nodejs\", \"node-js\", \"node-javascript\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
MODULE_DIR=\"\${SCRIPT_DIR}/node_modules\"
if [ -d \"\${MODULE_DIR}\" ]; then
    if [ -L /mnt/data/node_modules ]; then
        LINK_TARGET=\"\$(readlink -m /mnt/data/node_modules)\"
        if [ \"\${LINK_TARGET}\" != \"\${MODULE_DIR}\" ]; then
            case \"\${LINK_TARGET}\" in
                \"\${SCRIPT_DIR%/*/*}/\"*/node_modules)
                    ln -sfnT \"\${MODULE_DIR}\" /mnt/data/node_modules ;;
            esac
        fi
    elif [ ! -e /mnt/data/node_modules ]; then
        ln -s \"\${MODULE_DIR}\" /mnt/data/node_modules 2>/dev/null || true
    fi
fi
\"\${SCRIPT_DIR}/bin/node\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
        echo 'NODE_PATH=${pkg_dest}/node_modules' >> ${pkg_dest}/.env
    "

    if [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    echo "Node.js ${NODE_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/node" --version)"
}

install_node_packages() {
    if [ "${SKIP_NODE:-}" = "1" ] || [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        echo "Skipping Node.js packages (SKIP_NODE=1 or SKIP_JS_PACKAGES=1)"
        return 0
    fi

    local pkg_dest="/pkgs/node/${NODE_VERSION}"
    local npm_path="${pkg_dest}/bin/npm"

    echo "=============================================="
    echo "  Installing Node.js packages"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" install \
        --prefix "$pkg_dest" \
        --omit=dev \
        --no-audit \
        --no-fund \
        --save-exact \
        --package-lock=false \
        "${JS_PACKAGES[@]}"

    # Mirror the manifest into npm's global tree (${pkg_dest}/lib/node_modules
    # + bin shims on PATH) so `npm list -g`, `npm root -g`, and CLI shims work
    # as LLMs expect. The local tree above is still what feeds the
    # /mnt/data/node_modules symlink used by `require()` from user code.
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" install -g \
        --prefix "$pkg_dest" \
        --omit=dev \
        --no-audit \
        --no-fund \
        --save-exact \
        "${JS_PACKAGES[@]}"

    docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"

    echo "Installed Node.js packages (local):"
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" ls --prefix "$pkg_dest" --depth=0 2>/dev/null | head -40 || true

    echo "Installed Node.js packages (global):"
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" ls -g --prefix "$pkg_dest" --depth=0 2>/dev/null | head -40 || true
}

install_bun() {
    if [ "${SKIP_BUN:-}" = "1" ]; then
        echo "Skipping Bun (SKIP_BUN=1)"
        return 0
    fi

    local pkg_dest="/pkgs/bun/${BUN_VERSION}"

    echo "=============================================="
    echo "  Installing Bun ${BUN_VERSION}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip
        unzip -o bun.zip
        mv bun-linux-${BUN_ARCH}/bun ${pkg_dest}/bun
        chmod +x ${pkg_dest}/bun
        rm -rf bun.zip bun-linux-${BUN_ARCH}
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"bun\",
    \"version\": \"${BUN_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"provides\": [
        { \"language\": \"typescript\", \"aliases\": [\"bun-ts\"] },
        { \"language\": \"javascript\", \"aliases\": [\"bun-js\"] }
    ]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
MODULE_DIR=\"\${SCRIPT_DIR}/node_modules\"
if [ -d \"\${MODULE_DIR}\" ]; then
    if [ -L /mnt/data/node_modules ]; then
        LINK_TARGET=\"\$(readlink -m /mnt/data/node_modules)\"
        if [ \"\${LINK_TARGET}\" != \"\${MODULE_DIR}\" ]; then
            case \"\${LINK_TARGET}\" in
                \"\${SCRIPT_DIR%/*/*}/\"*/node_modules)
                    ln -sfnT \"\${MODULE_DIR}\" /mnt/data/node_modules ;;
            esac
        fi
    elif [ ! -e /mnt/data/node_modules ]; then
        ln -s \"\${MODULE_DIR}\" /mnt/data/node_modules 2>/dev/null || true
    fi
fi
\"\${SCRIPT_DIR}/bun\" run \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:${pkg_dest}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
        echo 'NODE_PATH=${pkg_dest}/node_modules' >> ${pkg_dest}/.env
        echo 'BUN_INSTALL=${pkg_dest}' >> ${pkg_dest}/.env
    "

    if [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    echo "Bun ${BUN_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bun" --version)"
}

install_bun_packages() {
    if [ "${SKIP_BUN:-}" = "1" ] || [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        echo "Skipping Bun packages (SKIP_BUN=1 or SKIP_JS_PACKAGES=1)"
        return 0
    fi

    local pkg_dest="/pkgs/bun/${BUN_VERSION}"
    local batch_size
    batch_size="$(validate_bun_package_batch_size)"
    local batch_index=1
    local batch_count=$(( (${#JS_PACKAGES[@]} + batch_size - 1) / batch_size ))

    echo "=============================================="
    echo "  Installing Bun packages"
    echo "=============================================="

    for ((i = 0; i < ${#JS_PACKAGES[@]}; i += batch_size)); do
        local batch_packages
        printf -v batch_packages "%q " "${JS_PACKAGES[@]:i:batch_size}"
        echo "Installing Bun package batch ${batch_index}/${batch_count}"
        docker exec "$CONTAINER_NAME" bash -c "
            set -e
            cd ${pkg_dest}
            BUN_CONFIG_MAX_HTTP_REQUESTS=${BUN_CONFIG_MAX_HTTP_REQUESTS:-8} ./bun add --exact ${batch_packages}
        "
        batch_index=$((batch_index + 1))
    done

    # Mirror the manifest into bun's global tree (BUN_INSTALL=${pkg_dest} ->
    # ${pkg_dest}/install/global/node_modules) so `bun pm ls -g`, `bun add -g`,
    # and global CLI shims at ${pkg_dest}/install/global/bin work as LLMs
    # expect. The local tree above is still what feeds the
    # /mnt/data/node_modules symlink used by `import` from user code.
    batch_index=1
    for ((i = 0; i < ${#JS_PACKAGES[@]}; i += batch_size)); do
        local batch_packages
        printf -v batch_packages "%q " "${JS_PACKAGES[@]:i:batch_size}"
        echo "Installing global Bun package batch ${batch_index}/${batch_count}"
        docker exec "$CONTAINER_NAME" bash -c "
            set -e
            cd ${pkg_dest}
            BUN_CONFIG_MAX_HTTP_REQUESTS=${BUN_CONFIG_MAX_HTTP_REQUESTS:-8} BUN_INSTALL=${pkg_dest} ./bun install -g --exact ${batch_packages}
        "
        batch_index=$((batch_index + 1))
    done

    docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"

    echo "Installed Bun packages (local):"
    docker exec "$CONTAINER_NAME" bash -c "cd ${pkg_dest} && ./bun pm ls --depth 0 2>/dev/null | head -40" || true

    echo "Installed Bun packages (global):"
    docker exec "$CONTAINER_NAME" bash -c "cd ${pkg_dest} && BUN_INSTALL=${pkg_dest} ./bun pm ls -g 2>/dev/null | head -40" || true
}

install_go() {
    if [ "${SKIP_GO:-}" = "1" ] || [ -z "${GO_VERSION}" ]; then
        echo "Skipping Go (SKIP_GO=1 or GO_VERSION empty)"
        return 0
    fi

    local pkg_arch
    pkg_arch="$(docker exec "$CONTAINER_NAME" uname -m)"
    local go_arch
    case "$pkg_arch" in
        x86_64) go_arch="amd64" ;;
        arm64|aarch64) go_arch="arm64" ;;
        *) echo "Unsupported architecture for Go: ${pkg_arch}"; return 1 ;;
    esac

    local pkg_dest="/pkgs/go/${GO_VERSION}"

    echo "=============================================="
    echo "  Installing Go ${GO_VERSION}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o go.tgz https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz
        tar -xzf go.tgz --strip-components=1 -C ${pkg_dest}
        rm -f go.tgz
    "

    local actual_version
    actual_version="$(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/go" version | awk '{print $3}' | sed 's/^go//')"
    if [ "${actual_version}" != "${GO_VERSION}" ]; then
        echo "ERROR: Go version mismatch (expected ${GO_VERSION}, got ${actual_version})"
        return 1
    fi

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"go\",
    \"version\": \"${GO_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"golang\"],
    \"limit_overrides\": {
        \"run_timeout\": 60000,
        \"run_cpu_time\": 60000
    }
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
if [ \"\$#\" -eq 0 ]; then
    echo \"go: no source file provided\" >&2
    exit 2
fi
ENTRY=\"\$1\"
shift
mkdir -p /mnt/data/.gocache /mnt/data/.gotmp /mnt/data/.gopath 2>/dev/null || true
if [ -f \"\${ENTRY}\" ] && [[ \"\${ENTRY}\" != *.go ]]; then
    RUNTMP=\"\$(dirname \"\${ENTRY}\")/.gorun\"
    mkdir -p \"\${RUNTMP}\" 2>/dev/null || true
    if [ -d \"\${RUNTMP}\" ]; then
        cp -f \"\${ENTRY}\" \"\${RUNTMP}/entry.go\" && ENTRY=\"\${RUNTMP}/entry.go\"
    fi
fi
exec \"\${SCRIPT_DIR}/bin/go\" run \"\${ENTRY}\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        cat > ${pkg_dest}/.env <<EOF
PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
GOTOOLCHAIN=local
GOCACHE=/mnt/data/.gocache
GOTMPDIR=/mnt/data/.gotmp
GOPATH=/mnt/data/.gopath
EOF
        touch ${pkg_dest}/.exec-workspace
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Go ${GO_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/go" version)"
}

install_java() {
    if [ "${SKIP_JAVA:-}" = "1" ] || [ -z "${JAVA_VERSION}" ]; then
        echo "Skipping Java (SKIP_JAVA=1 or JAVA_VERSION empty)"
        return 0
    fi

    local pkg_arch
    pkg_arch="$(docker exec "$CONTAINER_NAME" uname -m)"
    local adoptium_arch
    case "$pkg_arch" in
        x86_64) adoptium_arch="x64" ;;
        arm64|aarch64) adoptium_arch="aarch64" ;;
        *) echo "Unsupported architecture for Java: ${pkg_arch}"; return 1 ;;
    esac

    local pkg_dest="/pkgs/java/${JAVA_VERSION}"
    local jdk_url="https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE_VERSION}/ga/linux/${adoptium_arch}/jdk/hotspot/normal/eclipse"

    echo "=============================================="
    echo "  Installing Java ${JAVA_VERSION} (Temurin)"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o jdk.tgz '${jdk_url}'
        tar -xzf jdk.tgz --strip-components=1 -C ${pkg_dest}
        rm -f jdk.tgz
    "

    local actual_version
    actual_version="$(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/java" --version | head -n 1 | sed -nE 's/[^0-9]*([0-9]+[.][0-9]+[.][0-9]+).*/\1/p')"
    if [ "${actual_version}" != "${JAVA_VERSION}" ]; then
        echo "ERROR: Java version mismatch (expected ${JAVA_VERSION}, got ${actual_version})"
        return 1
    fi

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"java\",
    \"version\": \"${JAVA_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"openjdk\", \"jdk\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
if [ \"\$#\" -eq 0 ]; then
    echo \"java: no source file provided\" >&2
    exit 2
fi
ENTRY=\"\$1\"
shift
if [ -f \"\${ENTRY}\" ] && [[ \"\${ENTRY}\" != *.java ]]; then
    DIR=\"\$(dirname \"\${ENTRY}\")\"
    BASE=\"\$(basename \"\${ENTRY}\")\"
    BASE=\"\${BASE%.*}\"
    if [ -z \"\${BASE}\" ]; then
        BASE=\"entry\"
    fi
    cp -f \"\${ENTRY}\" \"\${DIR}/.\${BASE}.java\" && ENTRY=\"\${DIR}/.\${BASE}.java\"
fi
exec \"\${SCRIPT_DIR}/bin/java\" \"\${ENTRY}\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        cat > ${pkg_dest}/.env <<EOF
PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
JAVA_HOME=${pkg_dest}
JDK_JAVA_OPTIONS=-Xmx256m -XX:MaxMetaspaceSize=192m -XX:CompressedClassSpaceSize=192m -XX:ReservedCodeCacheSize=96m
EOF
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Java ${JAVA_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/java" --version | head -n 1)"
}

install_rust() {
    if [ "${SKIP_RUST:-}" = "1" ] || [ -z "${RUST_VERSION}" ]; then
        echo "Skipping Rust (SKIP_RUST=1 or RUST_VERSION empty)"
        return 0
    fi

    local pkg_arch
    pkg_arch="$(docker exec "$CONTAINER_NAME" uname -m)"
    local rust_target
    case "$pkg_arch" in
        x86_64) rust_target="x86_64-unknown-linux-gnu" ;;
        arm64|aarch64) rust_target="aarch64-unknown-linux-gnu" ;;
        *) echo "Unsupported architecture for Rust: ${pkg_arch}"; return 1 ;;
    esac

    local pkg_dest="/pkgs/rust/${RUST_VERSION}"

    echo "=============================================="
    echo "  Installing Rust ${RUST_VERSION}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o rustup-init https://static.rust-lang.org/rustup/dist/${rust_target}/rustup-init
        chmod +x rustup-init
        RUSTUP_HOME=${pkg_dest}/rustup CARGO_HOME=${pkg_dest}/cargo ./rustup-init -y \
            --no-modify-path \
            --profile minimal \
            --default-toolchain ${RUST_VERSION}
        rm -f rustup-init
    "

    local toolchain_dir
    toolchain_dir="$(docker exec "$CONTAINER_NAME" bash -c "ls -d ${pkg_dest}/rustup/toolchains/* | head -n 1")"
    if [ -z "${toolchain_dir}" ] || ! docker exec "$CONTAINER_NAME" test -x "${toolchain_dir}/bin/rustc"; then
        echo "ERROR: Rust toolchain not found after rustup install"
        return 1
    fi

    local actual_version
    actual_version="$(docker exec "$CONTAINER_NAME" "${toolchain_dir}/bin/rustc" --version | awk '{print $2}')"
    if [ "${actual_version}" != "${RUST_VERSION}" ]; then
        echo "ERROR: Rust version mismatch (expected ${RUST_VERSION}, got ${actual_version})"
        return 1
    fi
    if ! docker exec "$CONTAINER_NAME" test -x "${toolchain_dir}/bin/cargo"; then
        echo "ERROR: cargo not found in toolchain ${toolchain_dir}"
        return 1
    fi

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"rust\",
    \"version\": \"${RUST_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"rustc\"],
    \"limit_overrides\": {
        \"run_timeout\": 60000,
        \"run_cpu_time\": 60000
    }
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
TOOLCHAIN_BIN=\"\$(ls -d \"\${SCRIPT_DIR}\"/rustup/toolchains/*/bin 2>/dev/null | head -n 1)\"
if [ -z \"\${TOOLCHAIN_BIN}\" ] || [ ! -x \"\${TOOLCHAIN_BIN}/rustc\" ]; then
    echo \"rust: toolchain not found in \${SCRIPT_DIR}/rustup/toolchains\" >&2
    exit 1
fi
if [ \"\$#\" -eq 0 ]; then
    echo \"rust: no source file provided\" >&2
    exit 2
fi
ENTRY=\"\$1\"
shift
if [ -f \"\${ENTRY}\" ] && [ \"\$(basename \"\${ENTRY}\")\" = \"Cargo.toml\" ]; then
    mkdir -p /mnt/data/.cargo 2>/dev/null || true
    cd \"\$(dirname \"\${ENTRY}\")\" || exit 1
    exec \"\${TOOLCHAIN_BIN}/cargo\" run --offline \"\$@\"
fi
if [ -f \"\${ENTRY}\" ] && [[ \"\${ENTRY}\" != *.rs ]]; then
    DIR=\"\$(dirname \"\${ENTRY}\")\"
    BASE=\"\$(basename \"\${ENTRY}\")\"
    BASE=\"\${BASE%.*}\"
    if [ -z \"\${BASE}\" ]; then
        BASE=\"entry\"
    fi
    cp -f \"\${ENTRY}\" \"\${DIR}/.\${BASE}.rs\" && ENTRY=\"\${DIR}/.\${BASE}.rs\"
fi
OUT_DIR=/mnt/data/.rust-build
mkdir -p \"\${OUT_DIR}\" 2>/dev/null || OUT_DIR=/tmp
mkdir -p /mnt/data/.rust-tmp 2>/dev/null || true
\"\${TOOLCHAIN_BIN}/rustc\" --edition \"\${RUSTC_EDITION:-2021}\" -o \"\${OUT_DIR}/app\" \"\${ENTRY}\" || exit 1
exec \"\${OUT_DIR}/app\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        cat > ${pkg_dest}/.env <<EOF
PATH=${toolchain_dir}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
CARGO_HOME=/mnt/data/.cargo
RUSTC_EDITION=2024
TMPDIR=/mnt/data/.rust-tmp
EOF
        touch ${pkg_dest}/.exec-workspace
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Rust ${RUST_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${toolchain_dir}/bin/rustc" --version)"
}

install_bash() {
    local bash_package_version
    bash_package_version="${BASH_PACKAGE_VERSION:-5.2.0}"
    local system_bash_version
    system_bash_version=$(docker exec "$CONTAINER_NAME" bash --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
    local pkg_dest="/pkgs/bash/${bash_package_version}"

    echo "=============================================="
    echo "  Registering Bash ${bash_package_version}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        mkdir -p ${pkg_dest}
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'PKGEOF'
{
    \"language\": \"bash\",
    \"version\": \"${bash_package_version}\",
    \"build_platform\": \"docker-debian\",
    \"system_version\": \"${system_bash_version}\",
    \"aliases\": [\"sh\"]
}
PKGEOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'RUNEOF'
#!/bin/bash
bash \"\$@\"
RUNEOF
chmod +x ${pkg_dest}/run"

    # Surface node + bun toolchains and their global trees on PATH so bash
    # tool invocations (which is how LLMs typically reach for `npm list -g`,
    # `bun pm ls -g`, `handlebars`, etc.) discover the manifest packages.
    # BUN_INSTALL points bun at the bun runtime's BUN_INSTALL root so
    # `bun pm ls -g` resolves the offline globals instead of falling back
    # to ~/.bun/install/global.
    docker exec "$CONTAINER_NAME" bash -c "
        cat > ${pkg_dest}/.env <<EOF
PATH=/pkgs/bun/${BUN_VERSION}/bin:/pkgs/bun/${BUN_VERSION}:/pkgs/node/${NODE_VERSION}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
NODE_PATH=/pkgs/node/${NODE_VERSION}/node_modules
BUN_INSTALL=/pkgs/bun/${BUN_VERSION}
EOF
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Bash ${bash_package_version} registered (using system binary ${system_bash_version})"
}

main() {
    echo "=============================================="
    echo "  Code Interpreter API - Package Builder"
    echo "=============================================="
    echo ""

    command -v docker >/dev/null 2>&1 || { echo "Docker is required"; exit 1; }

    echo "Starting builder container..."
    docker run \
        -v "$PWD/data/pkgs:/pkgs" \
        -dit \
        --name "$CONTAINER_NAME" \
        buildpack-deps:bookworm >/dev/null

    echo "Installing system dependencies..."
    docker exec "$CONTAINER_NAME" bash -c "
        apt-get update && apt-get install -y --no-install-recommends \
            curl unzip wget ca-certificates \
            build-essential libssl-dev libffi-dev libsqlite3-dev \
            zlib1g-dev libbz2-dev libreadline-dev libncurses5-dev \
            tk-dev xz-utils libcurl4-openssl-dev libfontconfig1-dev \
            libudunits2-dev libpng-dev libxml2-dev libcairo2-dev \
            libfreetype6-dev \
        && rm -rf /var/lib/apt/lists/*
    "

    install_python
    install_python_packages
    install_node
    install_node_packages
    install_bun
    install_bun_packages
    install_go
    install_java
    install_rust
    install_bash

    echo "Setting permissions..."
    chmod -R a+rX "$PACKAGES_DIR" 2>/dev/null || true

    echo ""
    echo "=============================================="
    echo "  Build complete!"
    echo "=============================================="
    echo ""
    echo "Packages installed to: $PACKAGES_DIR"
    echo ""
    echo "Next steps:"
    echo "  1. Run: docker compose up --build"
    echo ""
}

main "$@"
