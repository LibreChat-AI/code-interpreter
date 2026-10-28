#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
command -v helm >/dev/null

# Like block_root_package_delivery.sh, render only this chart's templates so
# tests do not download Redis or MinIO dependencies or contact a cluster.
mkdir "$TMP_DIR/chart"
cp "$ROOT/helm/codeapi/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$ROOT/helm/codeapi/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' "$ROOT/helm/codeapi/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"

render() {
    helm template telemetry "$TMP_DIR/chart" \
        --set executionManifest.privateKey=test \
        --set executionManifest.publicKey=test "$@"
}

resource() {
    local file="$1" kind="$2" name="$3"
    awk -v kind="$kind" -v name="$name" '
        function emit() { if (foundKind && foundName) printf "%s", document }
        /^---$/ { emit(); document=""; foundKind=0; foundName=0; next }
        { document=document $0 "\n" }
        $0 == "kind: " kind { foundKind=1 }
        $0 == "  name: " name { foundName=1 }
        END { emit() }
    ' "$file"
}

contains() {
    if ! grep -Fq -- "$2" "$1"; then
        echo "Missing '$2' in $(basename "$1")" >&2
        exit 1
    fi
}

check_monitor() {
    local rendered="$1" component="$2" port="$3"
    local monitor="$TMP_DIR/$component-monitor.yaml"
    resource "$rendered" PodMonitor "telemetry-codeapi-$component" > "$monitor"
    contains "$monitor" '    - path: /metrics'
    contains "$monitor" "      port: $port"
    contains "$monitor" '      interval: 17s'
    contains "$monitor" '      scrapeTimeout: 7s'
    # Exact selectors must match the corresponding Deployment's pod labels,
    # including this release, and not accidentally select the service worker.
    sed -n '/^  selector:/,$p' "$monitor" > "$TMP_DIR/selector.yaml"
    contains "$TMP_DIR/selector.yaml" '      app.kubernetes.io/name: codeapi'
    contains "$TMP_DIR/selector.yaml" '      app.kubernetes.io/instance: telemetry'
    contains "$TMP_DIR/selector.yaml" "      app.kubernetes.io/component: $component"
    resource "$rendered" Deployment "telemetry-codeapi-$component" > "$TMP_DIR/deployment.yaml"
    contains "$TMP_DIR/deployment.yaml" "        app.kubernetes.io/component: $component"
    contains "$TMP_DIR/deployment.yaml" "            - name: $port"
}

render > "$TMP_DIR/default.yaml"
if grep -q '^kind: PodMonitor$' "$TMP_DIR/default.yaml"; then
    echo 'metrics.enabled=false must not create PodMonitors' >&2
    exit 1
fi

render --set metrics.enabled=true --set metrics.interval=17s --set metrics.scrapeTimeout=7s \
    --set workerSandbox.sandbox.port=2345 > "$TMP_DIR/enabled.yaml"
check_monitor "$TMP_DIR/enabled.yaml" sandbox-runner sandbox
check_monitor "$TMP_DIR/enabled.yaml" service-worker health
contains "$TMP_DIR/deployment.yaml" '        app.kubernetes.io/instance: telemetry'
resource "$TMP_DIR/enabled.yaml" Deployment telemetry-codeapi-sandbox-runner > "$TMP_DIR/runner.yaml"
contains "$TMP_DIR/runner.yaml" '              containerPort: 2345'

# Enabling metrics must not silently weaken sandbox isolation.
resource "$TMP_DIR/default.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/default-policy.yaml"
resource "$TMP_DIR/enabled.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/enabled-policy.yaml"
# Use the same configured runner port when comparing policies.
sed 's/port: 2345/port: 2000/' "$TMP_DIR/enabled-policy.yaml" > "$TMP_DIR/normalized-policy.yaml"
cmp "$TMP_DIR/default-policy.yaml" "$TMP_DIR/normalized-policy.yaml"

cat > "$TMP_DIR/scraper.yaml" <<'YAML'
metrics:
  sandboxRunner:
    ingressFrom:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: metrics-test
        podSelector:
          matchLabels:
            app.kubernetes.io/name: prometheus-test
YAML
render --set metrics.enabled=true --set workerSandbox.sandbox.port=2345 \
    -f "$TMP_DIR/scraper.yaml" > "$TMP_DIR/scraper-render.yaml"
resource "$TMP_DIR/scraper-render.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/scraper-policy.yaml"
contains "$TMP_DIR/scraper-policy.yaml" 'kubernetes.io/metadata.name: metrics-test'
contains "$TMP_DIR/scraper-policy.yaml" 'app.kubernetes.io/name: prometheus-test'
contains "$TMP_DIR/scraper-policy.yaml" 'app.kubernetes.io/component: service-worker'
# The namespace and pod selectors must be ANDed in ONE peer, not two ORed peers.
contains "$TMP_DIR/scraper-policy.yaml" '      - namespaceSelector:'
contains "$TMP_DIR/scraper-policy.yaml" '        podSelector:'
[[ "$(grep -Fc '          port: 2345' "$TMP_DIR/scraper-policy.yaml")" == 2 ]]
# Scraping changes only ingress, never the sandbox egress boundary.
sed -n '/^  egress:/,$p' "$TMP_DIR/scraper-policy.yaml" > "$TMP_DIR/scraper-egress.yaml"
sed -n '/^  egress:/,$p' "$TMP_DIR/default-policy.yaml" > "$TMP_DIR/default-egress.yaml"
cmp "$TMP_DIR/default-egress.yaml" "$TMP_DIR/scraper-egress.yaml"

render -f "$TMP_DIR/scraper.yaml" > "$TMP_DIR/disabled-scraper.yaml"
resource "$TMP_DIR/disabled-scraper.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/disabled-scraper-policy.yaml"
cmp "$TMP_DIR/default-policy.yaml" "$TMP_DIR/disabled-scraper-policy.yaml"

render --set metrics.enabled=true --set workerSandbox.enabled=false \
    -f "$TMP_DIR/scraper.yaml" > "$TMP_DIR/no-workers.yaml"
[[ -z "$(resource "$TMP_DIR/no-workers.yaml" PodMonitor telemetry-codeapi-sandbox-runner)" ]]
[[ -z "$(resource "$TMP_DIR/no-workers.yaml" PodMonitor telemetry-codeapi-service-worker)" ]]
resource "$TMP_DIR/no-workers.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/no-workers-policy.yaml"
if grep -q prometheus-test "$TMP_DIR/no-workers-policy.yaml"; then
    echo 'disabled workerSandbox must not enable scrape ingress' >&2
    exit 1
fi

# Older values may omit the new subtree; this must remain worker-only ingress.
render --set metrics.enabled=true --set metrics.sandboxRunner=null > "$TMP_DIR/old-values.yaml"
resource "$TMP_DIR/old-values.yaml" NetworkPolicy telemetry-codeapi-sandbox-runner > "$TMP_DIR/old-values-policy.yaml"
cmp "$TMP_DIR/default-policy.yaml" "$TMP_DIR/old-values-policy.yaml"

render --set metrics.enabled=true --set api.enabled=false > "$TMP_DIR/no-api.yaml"
[[ -n "$(resource "$TMP_DIR/no-api.yaml" PodMonitor telemetry-codeapi-sandbox-runner)" ]]
[[ -z "$(resource "$TMP_DIR/no-api.yaml" PodMonitor telemetry-codeapi-api)" ]]

render --set metrics.enabled=true --set metrics.interval= --set metrics.scrapeTimeout= > "$TMP_DIR/no-timing.yaml"
resource "$TMP_DIR/no-timing.yaml" PodMonitor telemetry-codeapi-sandbox-runner > "$TMP_DIR/no-timing-monitor.yaml"
if grep -Eq 'interval:|scrapeTimeout:' "$TMP_DIR/no-timing-monitor.yaml"; then
    echo 'empty scrape timing overrides must defer to Prometheus defaults' >&2
    exit 1
fi

render --set metrics.enabled=true --set networkPolicy.enabled=false \
    -f "$TMP_DIR/scraper.yaml" > "$TMP_DIR/no-policy.yaml"
[[ -n "$(resource "$TMP_DIR/no-policy.yaml" PodMonitor telemetry-codeapi-sandbox-runner)" ]]
if grep -q '^kind: NetworkPolicy$' "$TMP_DIR/no-policy.yaml"; then
    echo 'networkPolicy.enabled=false must not create NetworkPolicies' >&2
    exit 1
fi

helm lint "$TMP_DIR/chart" --set executionManifest.privateKey=test --set executionManifest.publicKey=test \
    --set metrics.enabled=true -f "$TMP_DIR/scraper.yaml"
echo 'Sandbox runner metrics chart regressions passed'
