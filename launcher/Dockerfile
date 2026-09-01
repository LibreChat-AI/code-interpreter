# ============================================================================
# MicroVM Sandbox Launcher
#
# Boots the sandbox server inside a libkrun microVM with its own kernel.
# Only requires /dev/kvm on the host — no privileged mode, no capabilities.
#
# Build:
#   docker build -f launcher/Dockerfile -t sandbox-microvm ./
#
# The build context must be the codeapi directory (parent of launcher/)
# so we can reference the api/ Dockerfile for the sandbox rootfs stage.
# ============================================================================

# ============================================================================
# Stage 1: Build the sandbox image (reuses existing Dockerfile verbatim)
# ============================================================================
FROM buildpack-deps:bookworm AS nsjail-builder

WORKDIR /nsjail

RUN apt-get update && apt-get install -y --no-install-recommends \
    bison \
    flex \
    libprotobuf-dev \
    libnl-route-3-dev \
    protobuf-compiler \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone -b master --single-branch https://github.com/google/nsjail.git . \
    && git checkout dccf911fd2659e7b08ce9507c25b2b38ec2c5800

RUN make -j$(nproc)

COPY api/src/spec-guard.c /tmp/spec-guard.c
RUN gcc -O2 -static -o /usr/local/bin/spec-guard /tmp/spec-guard.c \
    && chmod 0111 /usr/local/bin/spec-guard

# Build RTK against the same Debian bookworm glibc baseline as the sandbox.
FROM rust:1.91-bookworm AS rtk-builder

ARG RTK_COMMIT=b34be37caf3796b69a50952a28e60e32b5daad43
RUN git clone --depth 1 --branch v0.45.0 https://github.com/rtk-ai/rtk.git /rtk \
    && cd /rtk \
    && git checkout "$RTK_COMMIT" \
    && test "$(git rev-parse HEAD)" = "$RTK_COMMIT" \
    && cargo build --locked --release \
    && ./target/release/rtk --version

FROM oven/bun:1.3.14-debian AS sandbox-build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    coreutils \
    util-linux \
    bsdextrautils \
    locales \
    procps \
    iptables \
    socat \
    libnl-route-3-200 \
    libprotobuf32 \
    libffi8 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && libffi=$(find /usr/lib -name 'libffi.so.8' -print -quit) \
    && { [ -n "$libffi" ] || { echo "libffi.so.8 not found" >&2; exit 1; }; } \
    && ln -sf "$libffi" "${libffi%.so.8}.so.6"

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

COPY --from=nsjail-builder /nsjail/nsjail /usr/sbin/nsjail
COPY --from=nsjail-builder /usr/local/bin/spec-guard /usr/local/bin/spec-guard
COPY --from=rtk-builder /rtk/target/release/rtk /usr/local/bin/rtk
RUN chmod +x /usr/sbin/nsjail

WORKDIR /sandbox_api

COPY api/package.json ./
RUN bun install

COPY api/tsconfig.json ./
COPY api/src ./src
COPY shared /shared
COPY api/config ./config

RUN bun run build

RUN mkdir -p /pkgs /tmp/sandbox

RUN find / -xdev -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true

RUN rm -f /usr/bin/nsenter /usr/bin/unshare /usr/bin/chroot /usr/sbin/chroot \
         /usr/bin/perl* /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg \
         /usr/sbin/adduser /usr/sbin/useradd /usr/sbin/usermod \
         /usr/sbin/groupadd /usr/sbin/groupmod \
         /usr/bin/su \
         /usr/bin/chfn /usr/bin/chsh /usr/bin/gpasswd /usr/bin/newgrp \
         /usr/bin/passwd /usr/bin/sg \
         /usr/bin/chage /usr/bin/expiry /usr/sbin/unix_chkpwd \
    2>/dev/null || true

COPY api/src/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# ============================================================================
# Stage 2: Build the launcher binary on Fedora (libkrun is packaged there)
# ============================================================================
FROM fedora:43 AS launcher-builder

RUN dnf install -y \
    rust cargo \
    libkrun-devel \
    gcc \
    && dnf clean all

WORKDIR /launcher
COPY launcher/Cargo.toml launcher/build.rs ./
COPY launcher/src/ ./src/

RUN cargo build --release

# ============================================================================
# Stage 3: Final launcher image (Fedora-based for libkrun ABI compatibility)
# ============================================================================
FROM fedora:43

RUN dnf install -y --setopt=install_weak_deps=False \
    libkrun \
    socat \
    util-linux \
    grep \
    gawk \
    findutils \
    ca-certificates \
    && dnf clean all

COPY --from=launcher-builder /launcher/target/release/sandbox-launcher /usr/local/bin/launcher

COPY --from=sandbox-build / /sandbox-rootfs/

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg

RUN mkdir -p /host-packages

COPY launcher/entrypoint.sh /usr/local/bin/launcher-entrypoint.sh
COPY docker/start-direct-sandbox.sh /usr/local/bin/start-direct-sandbox.sh
COPY docker/sandbox-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/launcher-entrypoint.sh /usr/local/bin/start-direct-sandbox.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
