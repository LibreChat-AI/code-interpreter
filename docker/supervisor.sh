#!/bin/bash
# Supervisor script for Worker-Sandbox container
# Runs the sandbox (via libkrun microVM when KVM_ENABLED=true, or directly via
# unshare --mount when KVM_ENABLED=false) alongside the worker process.
#
# KVM_ENABLED=true  (default): libkrun microVM + NsJail — full isolation
# KVM_ENABLED=false:           private mount namespace + NsJail — nsjail isolation, no guest kernel
#
# The no-KVM path uses unshare --mount (NOT chroot) because the Linux kernel
# explicitly blocks clone(CLONE_NEWUSER) for processes inside a chroot jail —
# and NsJail requires user namespaces for its sandbox isolation.  By creating a
# private mount namespace instead, CLONE_NEWUSER succeeds while the Debian rootfs
# paths are still presented to NsJail via bind-mounts over the Fedora base dirs.
#
# cgroup v2 delegation: supervisor drains all processes out of the root cgroup
# into an 'init/' sub-cgroup (including PID 1) and enables +memory +pids on the
# root cgroup.subtree_control.  entrypoint.sh then moves the sandbox API process
# to its own 'sandbox_api/' sub-cgroup, and NsJail creates per-execution cgroups
# under sandbox_api/ using the inherited +memory +pids controllers.

KVM_ENABLED="${KVM_ENABLED:-true}"

if [ "$KVM_ENABLED" = "true" ]; then
    echo "Starting Worker-Sandbox container (microVM mode)..."
else
    echo "Starting Worker-Sandbox container (direct mode, KVM disabled)..."
fi

CLEANUP_IN_PROGRESS=false

cleanup() {
    if [ "$CLEANUP_IN_PROGRESS" = true ]; then
        return
    fi
    CLEANUP_IN_PROGRESS=true

    trap - SIGTERM SIGINT

    echo "Received shutdown signal, stopping processes..."

    if [ -n "$SANDBOX_PID" ]; then
        kill -TERM "$SANDBOX_PID" 2>/dev/null || true
    fi
    if [ -n "$WORKER_PID" ]; then
        kill -TERM "$WORKER_PID" 2>/dev/null || true
    fi

    wait

    # No-KVM bind-mounts live inside a private mount namespace (unshare --mount).
    # The kernel tears them all down automatically when that namespace's last
    # process exits, so there is nothing to umount here.

    echo "All processes stopped"
    exit 0
}

trap cleanup SIGTERM SIGINT

# ============================================================================
# Start Sandbox
# ============================================================================
if [ "$KVM_ENABLED" = "true" ]; then
    # --- microVM path ---
    echo "Starting Sandbox (microVM + NsJail) on port 2000..."
    /usr/local/bin/launcher-entrypoint.sh &
    SANDBOX_PID=$!
    echo "Sandbox launcher started with PID $SANDBOX_PID"
else
    # --- Direct path (no KVM) ---
    env \
        -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
        -u AWS_EXECUTION_ENV \
        -u AWS_REGION \
        -u CODEAPI_AUTH_PROVIDER \
        -u CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY \
        -u CODEAPI_EXECUTION_PROFILE \
        -u CODEAPI_INTERNAL_SERVICE_TOKEN \
        -u CODEAPI_RUNTIME_SESSION_MODE \
        -u CODEAPI_SANDBOX_BACKEND \
        -u FILE_SERVER_URL \
        -u REDIS_HOST \
        -u REDIS_PASSWORD \
        -u REDIS_PORT \
        -u REDIS_TLS \
        -u REDIS_USE_ALTERNATIVE_DNS_LOOKUP \
        -u TOOL_CALL_SERVER_URL \
        /usr/local/bin/start-direct-sandbox.sh &
    SANDBOX_PID=$!
    echo "Sandbox started (direct) with PID $SANDBOX_PID"
fi

# Wait for sandbox to be ready
if [ "$KVM_ENABLED" = "true" ]; then
    echo "Waiting for sandbox to be ready (microVM boot may take a few seconds)..."
else
    echo "Waiting for sandbox to be ready..."
fi
for i in $(seq 1 60); do
    if curl -s http://localhost:2000/api/v2/runtimes > /dev/null 2>&1; then
        echo "Sandbox is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "ERROR: Sandbox failed to start within 60 seconds"
        exit 1
    fi
    sleep 1
done

# ============================================================================
# Start Worker
# ============================================================================
echo "Starting Worker on health port ${WORKER_HEALTH_PORT:-3113}..."
cd /worker

export SANDBOX_ENDPOINT="${SANDBOX_ENDPOINT:-http://localhost:2000/api/v2}"

node .build/worker-server.js &
WORKER_PID=$!
echo "Worker started with PID $WORKER_PID"

echo "Waiting for worker to be ready..."
for i in $(seq 1 120); do
    if curl -s http://localhost:${WORKER_HEALTH_PORT:-3113}/health > /dev/null 2>&1; then
        echo "Worker is ready!"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "ERROR: Worker failed to start within 120 seconds"
        exit 1
    fi
    sleep 1
done

echo "============================================"
echo "Worker-Sandbox container is fully started"
if [ "$KVM_ENABLED" = "true" ]; then
    echo "  Sandbox: http://localhost:2000 (microVM + NsJail)"
else
    echo "  Sandbox: http://localhost:2000 (direct NsJail, no microVM)"
fi
echo "  Worker health: http://localhost:${WORKER_HEALTH_PORT:-3113}/health"
echo "  PYTHON_CONCURRENCY: ${PYTHON_CONCURRENCY:-1}"
echo "  OTHER_CONCURRENCY: ${OTHER_CONCURRENCY:-8}"
echo "============================================"

wait -n
EXIT_CODE=$?

if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then
    echo "Sandbox process (PID $SANDBOX_PID) exited with code $EXIT_CODE"
elif ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "Worker process (PID $WORKER_PID) exited with code $EXIT_CODE"
else
    echo "Unknown process exited with code $EXIT_CODE"
fi

echo "Initiating shutdown..."
cleanup
