#!/bin/bash
# setup-local.sh - Set up Code Interpreter API on local Kubernetes (minikube or kind)
#
# Usage:
#   ./helm/setup-local.sh minikube   # Use minikube
#   ./helm/setup-local.sh kind       # Use kind

set -e

CLUSTER_TYPE="${1:-minikube}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 Code Interpreter API Local Kubernetes Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check KVM availability (informational only — kvmEnabled:false falls back to direct NsJail)
if [ -e /dev/kvm ]; then
    echo "✓ /dev/kvm available (microVM mode)"
else
    echo "ℹ /dev/kvm not found — will run in direct NsJail mode (kvmEnabled: false)"
fi

# Check prerequisites
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ $1 is not installed. Please install it first."
        exit 1
    fi
    echo "✓ $1 found"
}

# The chart's subchart dependencies are OCI references, which Helm only
# resolves without an experimental flag from 3.8 onward.
check_helm_version() {
    local required_major=3 required_minor=8
    local raw major minor
    raw=$(helm version --template '{{.Version}}' 2>/dev/null || true)
    if [ -z "$raw" ]; then
        echo "❌ could not determine the installed Helm version (need >= ${required_major}.${required_minor})."
        exit 1
    fi
    raw=${raw#v}
    major=${raw%%.*}
    minor=${raw#*.}
    minor=${minor%%.*}
    case "$major$minor" in
        *[!0-9]*|'')
            echo "❌ could not parse the installed Helm version '$raw' (need >= ${required_major}.${required_minor})."
            exit 1
            ;;
    esac
    if [ "$major" -lt "$required_major" ] ||
        { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then
        echo "❌ Helm $raw is too old. The chart's OCI subchart dependencies need >= ${required_major}.${required_minor}."
        exit 1
    fi
    echo "✓ helm $raw supports OCI dependencies"
}

echo "📋 Checking prerequisites..."
check_command docker
check_command helm
check_helm_version
check_command kubectl
check_command "$CLUSTER_TYPE"
echo ""

# Start or check cluster
echo "📦 Setting up $CLUSTER_TYPE cluster..."
if [ "$CLUSTER_TYPE" = "minikube" ]; then
    if ! minikube status &> /dev/null; then
        echo "Starting minikube..."
        minikube start --cpus=4 --memory=8192 --driver=docker
    else
        echo "minikube is already running"
    fi
    # Point docker to minikube's daemon for building
    eval $(minikube docker-env)
elif [ "$CLUSTER_TYPE" = "kind" ]; then
    if ! kind get clusters | grep -q "codeapi"; then
        echo "Creating kind cluster..."
        kind create cluster --name codeapi
    else
        echo "kind cluster 'codeapi' already exists"
    fi
    kubectl cluster-info --context kind-codeapi
fi
echo ""

# Build images
echo "🔨 Building Docker images..."
cd "$PROJECT_DIR"

echo "Building codeapi-api..."
docker build -f service/Dockerfile.api -t codeapi-api:latest .

echo "Building codeapi-file-server..."
docker build -f service/Dockerfile -t codeapi-file-server:latest .

echo "Building codeapi-tool-call-server..."
docker build -f service/Dockerfile.tool-call-server -t codeapi-tool-call-server:latest .

# For the worker-sandbox, we need the full context
echo "Building codeapi-worker-sandbox..."
docker build -f docker/Dockerfile.worker-sandbox -t codeapi-worker-sandbox:latest .

echo "Building codeapi-package-init..."
docker build -f docker/Dockerfile.package-init -t codeapi-package-init:latest .

echo ""

# Load images into cluster (only needed for kind)
if [ "$CLUSTER_TYPE" = "kind" ]; then
    echo "📤 Loading images into kind cluster..."
    kind load docker-image codeapi-api:latest --name codeapi
    kind load docker-image codeapi-file-server:latest --name codeapi
    kind load docker-image codeapi-tool-call-server:latest --name codeapi
    kind load docker-image codeapi-worker-sandbox:latest --name codeapi
    kind load docker-image codeapi-package-init:latest --name codeapi
    echo ""
fi

# Add Helm repos and update dependencies
echo "📚 Setting up Helm dependencies..."
# Subcharts resolve from oci://registry-1.docker.io/bitnamicharts, so no
# classic chart repository needs registering.
helm dependency update ./helm/codeapi
echo ""

# Install or upgrade the release
echo "🎯 Deploying Code Interpreter API..."
if helm status codeapi &> /dev/null; then
    echo "Upgrading existing release..."
    helm upgrade codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml
else
    echo "Installing new release..."
    helm install codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml
fi
echo ""

# Wait for package-init job (compiles Python from source — may be slow on first run)
if kubectl get job -l app.kubernetes.io/component=package-init 2>/dev/null | grep -q package-init; then
    echo "⏳ Waiting for package-init job (builds Python + pip packages)..."
    echo "   (This compiles Python from source on first run — subsequent runs are fast)"
    kubectl wait --for=condition=complete job -l app.kubernetes.io/component=package-init --timeout=900s || true
fi

# Wait for pods to be ready
echo "⏳ Waiting for pods to be ready..."
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=codeapi --timeout=300s || true
echo ""

# Show status
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
kubectl get pods -l app.kubernetes.io/instance=codeapi
echo ""
echo "To access the API:"
echo "  kubectl port-forward svc/codeapi-api 3112:3112"
echo ""
echo "Then test:"
echo "  curl http://localhost:3112/v1/health"
echo ""
echo "To view logs:"
echo "  kubectl logs -l app.kubernetes.io/component=api -f"
echo "  kubectl logs -l app.kubernetes.io/component=worker-sandbox -f"
echo ""
echo "To scale workers:"
echo "  kubectl scale deployment/codeapi-worker-sandbox --replicas=5"
echo ""
