# Code Interpreter API Helm Chart

Deploy the horizontally-scalable Code Interpreter API stack to Kubernetes.

## Prerequisites

- Docker Desktop with Kubernetes enabled, OR
- Minikube installed (`brew install minikube` / `choco install minikube`)
- Helm 3.x (`brew install helm` / `choco install kubernetes-helm`)
- kubectl (`brew install kubectl` / `choco install kubernetes-cli`)

## Execution manifest signing keys (required)

The service-worker signs every sandbox execute request with an Ed25519 private
key; sandbox-runner only receives the public verifier, so a runner compromise
cannot mint new manifests. The chart ships **no default keypair** —
`executionManifest.privateKey` and `executionManifest.publicKey` are empty in
`values.yaml`, and `helm install`/`helm upgrade` fails fast when
`workerSandbox.enabled=true` (the default) and either value is unset.

Generate a keypair and pass it as base64-encoded DER (or PEM with escaped
newlines):

```bash
# Generate the Ed25519 private key (PEM)
openssl genpkey -algorithm ed25519 -out manifest-signing.pem

# Extract the public key (PEM)
openssl pkey -in manifest-signing.pem -pubout -out manifest-signing.pub.pem

# base64-encoded DER values for the chart
PRIVATE_KEY=$(openssl pkey -in manifest-signing.pem -outform DER | base64)
PUBLIC_KEY=$(openssl pkey -in manifest-signing.pem -pubout -outform DER | base64)

helm install codeapi . \
  --set executionManifest.privateKey="$PRIVATE_KEY" \
  --set executionManifest.publicKey="$PUBLIC_KEY"
```

For production, prefer external secrets management (Vault, AWS Secrets
Manager, Sealed Secrets) or deploy-time `--set` over committing key material
to a values file.

`values-local.yaml` carries a **test-only keypair** for minikube local dev. It
is publicly known (the same keypair is hardcoded in the unit tests), so never
use it outside local development.

## Production deployment notes

This chart deploys the full service stack on a single cluster and is the
supported path for self-hosting. A few things are intentionally left to your
platform rather than templated here: external ingress/service mesh, KEDA-style
queue-depth autoscaling, and cloud-IAM secret delivery (the env hooks below
cover all of them).

**Pairing-fence rollbacks.** Do not use a direct `helm rollback` from a chart
revision containing the bridge pairing fence to an older revision. Helm runs
rollback hooks from the target revision, so a pre-fence target cannot stop its
own old and new API replicas from overlapping. Use the chart's fail-closed
helper instead:

```bash
helm/codeapi/scripts/safe-pairing-rollback.sh RELEASE REVISION NAMESPACE
```

The helper deletes the API HPA, scales the live fenced API deployment to zero,
waits until every API pod is gone, and only then invokes `helm rollback`. This
causes an API outage by design. If rollback fails, it leaves the API scaled to
zero rather than restarting a potentially mixed-version deployment. The
operator running it needs permission to read/scale Deployments and delete HPAs.

**Execution profile.** By default this chart leaves
`CODEAPI_EXECUTION_PROFILE` unset. Its bundled HTTP/stateless configuration is
inferred as the AWS-free `default` profile and retains the existing
`python-queue` / `other-queue` BullMQ names. Set `executionProfile: default`
explicitly when deploying it beside a stateful stack. A separate stateful
Lambda MicroVM deployment must use `executionProfile: stateful`; it then
consumes `stateful-python-queue` / `stateful-other-queue`, so both stacks may
safely share Redis without consuming each other's jobs. Do not mix API and
worker profile values within one deployment.

The chart does not provision Lambda MicroVM infrastructure. Supply its
runtime settings to both the API and worker (and AWS credentials or workload
identity to the worker) through the existing environment hooks, for example:

```yaml
executionProfile: stateful
api:
  extraEnv:
    - name: CODEAPI_RUNTIME_SESSION_MODE
      value: affinity
workerSandbox:
  extraEnv:
    - name: CODEAPI_SANDBOX_BACKEND
      value: lambda-microvm
    - name: CODEAPI_RUNTIME_SESSION_MODE
      value: affinity
    - name: LAMBDA_MICROVM_IMAGE_ARN
      value: arn:aws:lambda:REGION:ACCOUNT:microvm-image:NAME
    - name: LAMBDA_MICROVM_IMAGE_VERSION
      value: "VERSION"
```

The worker also needs the remaining Lambda networking, checkpoint-store, and
hardening variables documented in `docs/lambda-microvm/README.md`. This chart
still renders its bundled sandbox-runner, though a Lambda worker does not call
it; a platform-specific stateful deployment may omit that component.

For an existing affinity/strict deployment from before execution profiles,
first roll the new binary to API and worker pods with
`CODEAPI_EXECUTION_PROFILE` still unset. The inferred stateful compatibility
mode deliberately retains the legacy queues, so old and new binaries can
overlap. Then create a replacement deployment with the profile explicitly set
to `stateful`, verify its API and workers together, switch the stateful ingress,
and drain the legacy deployment. Roll back by switching ingress to the legacy
deployment before removing the replacement. Never share Redis between the
inferred compatibility deployment and a default deployment: both consume the
legacy queues.

**Authentication.** Outside local mode the API verifies JWTs. Configure the
verifier through environment variables on the api component, e.g.:

```yaml
api:
  extraEnv:
    - name: CODEAPI_AUTH_PROVIDER
      value: librechat-jwt
    - name: CODEAPI_JWT_PUBLIC_KEY     # single PEM/base64-DER verifier key
      valueFrom:
        secretKeyRef:
          name: codeapi-jwt-verifier
          key: public-key
    - name: CODEAPI_JWT_KID
      value: my-key-id
```

`CODEAPI_JWT_PUBLIC_KEYS_DIR` (a mounted directory of PEM files) and
`CODEAPI_JWT_JWKS_JSON` (inline JWKS) are also supported for key rotation.
For development only, `LOCAL_MODE=true` bypasses authentication — see
`values-local.yaml`.

**TLS to Redis.** Set `REDIS_TLS=true` via `extraEnv` on each component when
your Redis (e.g. a managed cache) requires TLS.

**Package delivery.** KVM deployments default to
`workerSandbox.packages.source=image`. Build and publish the baked runner target
under the existing `workerSandbox.sandboxImage` repository and tag:

```bash
docker build \
  --target sandbox-runner-baked \
  -t codeapi-sandbox-runner:latest \
  -f api/Dockerfile .
```

That image boots the guest and its `/pkgs` tree from a read-only ext4 block
image. It intentionally does not expose `/host-packages` through virtio-fs,
which prevents package imports from pinning host-side launcher file
descriptors. Set `workerSandbox.packages.source=pvc` only for compatibility with
runtime package rebuilds; Kubernetes will then use the FD-aware liveness probe
to recycle the runner before descriptor exhaustion.

When upgrading from chart 0.2.x, rebuild the configured `sandboxImage` from the
baked target before enabling the 0.3.x default. To keep an existing
directory-root image during migration, set
`workerSandbox.packages.source=pvc`; the established image repository/tag
override remains unchanged in either mode.

## Quick Start (Local Development)

### 1. Start Minikube
```bash
minikube start --cpus=4 --memory=8192
```

### 2. Build Images Inside Minikube
```bash
# Point docker to minikube's daemon
eval $(minikube docker-env)

# Build all images, from the codeapi root
docker build -t codeapi-api:latest -f service/Dockerfile.api .
docker build -t codeapi-worker:latest -f service/Dockerfile.worker .
docker build --target sandbox-runner -t codeapi-sandbox-runner:latest -f api/Dockerfile .
docker build -t codeapi-file-server:latest -f service/Dockerfile --target production .
docker build -t codeapi-tool-call-server:latest -f service/Dockerfile.tool-call-server --target production .
docker build -t codeapi-package-init:latest -f docker/Dockerfile.package-init .
```

### 3. Install Dependencies & Deploy
```bash
cd helm/codeapi

# Download chart dependencies (Redis)
helm dependency update

# Deploy! Override internalServiceAuth.token for any shared/prod cluster.
# values-local.yaml supplies a TEST-ONLY executionManifest keypair; without it
# (or your own keypair) the install fails fast — see "Execution manifest
# signing keys" above.
helm install codeapi . -f values-local.yaml
```

### 4. Language Packages (Local PVC Mode)

`values-local.yaml` disables KVM and selects the legacy PVC package source. In
that mode the chart includes a **package-init Job** that runs as a Helm
`pre-install` hook. It compiles Python, downloads Node/Bun, installs offline
package sets, and registers Bash into the packages PVC before the worker pods
start.

This happens automatically on `helm install`. To force a rebuild:

```bash
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true
```

To check init job status:

```bash
kubectl get jobs -l app.kubernetes.io/component=package-init
kubectl logs job/codeapi-package-init
```

When deploying the `/pkgs` package-root migration, update sandbox env values to
`SANDBOX_PACKAGES_DIRECTORY=/pkgs` and force a package rebuild on the first rollout
so generated Python/Node/Bun paths are recreated under `/pkgs`:

```bash
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true
```

To manually populate packages instead (e.g., from a pre-built directory):

```bash
kubectl run pvc-populator --image=alpine --command -- sleep 3600 \
  --overrides='{"spec":{"containers":[{"name":"pvc-populator","image":"alpine","command":["sleep","3600"],"volumeMounts":[{"name":"packages","mountPath":"/packages"}]}],"volumes":[{"name":"packages","persistentVolumeClaim":{"claimName":"codeapi-packages"}}]}}'

kubectl wait --for=condition=ready pod/pvc-populator --timeout=60s
kubectl cp ./data/pkgs/. pvc-populator:/packages/
kubectl delete pod pvc-populator
kubectl rollout restart deployment/codeapi-sandbox-runner
```

### 5. Access the API
```bash
# Port forward (in another terminal)
kubectl port-forward svc/codeapi-api 3112:3112

# Test
curl http://localhost:3112/v1/health
```

---

## Commands Reference

### Startup
```bash
# Start minikube
minikube start

# Deploy local direct mode (package-init job runs automatically)
helm install codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml

# Port forward
kubectl port-forward svc/codeapi-api 3112:3112
```

### Check Status
```bash
# View all pods
kubectl get pods

# View logs
kubectl logs deployment/codeapi-api
kubectl logs deployment/codeapi-service-worker
kubectl logs deployment/codeapi-sandbox-runner

# Describe pod (for debugging)
kubectl describe pod <pod-name>
```

### Scaling
```bash
# Scale the sandbox execution tier
kubectl scale deployment/codeapi-sandbox-runner --replicas=10

# Or via Helm upgrade
helm upgrade codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml \
  --set workerSandbox.sandboxRunner.replicaCount=10
```

### Update After Code Changes
```bash
# Rebuild images (must be in minikube docker env)
eval $(minikube docker-env)
docker build -t codeapi-worker:latest -f service/Dockerfile.worker .
docker build --target sandbox-runner -t codeapi-sandbox-runner:latest -f api/Dockerfile .

# Restart deployments to pick up new images
kubectl rollout restart deployment/codeapi-service-worker
kubectl rollout restart deployment/codeapi-sandbox-runner
```

### Teardown
```bash
# Uninstall the Helm release (removes all K8s resources)
helm uninstall codeapi

# Stop minikube (preserves state for next time)
minikube stop

# OR: Delete minikube entirely (full reset)
minikube delete
```

---

## Testing

### Health Check
```bash
curl http://localhost:3112/v1/health
# Expected: OK
```

### Execute Python Code
```bash
curl -X POST http://localhost:3112/v1/exec \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{"lang": "py", "code": "print(\"Hello from K8s!\")"}'
```

### Verify Horizontal Scaling
```bash
# Check which service-worker processed the job
kubectl logs deployment/codeapi-service-worker --tail=5

# Each pod has a unique ID - jobs are distributed across all workers
```

---

## Architecture

```
+---------------------------------------------------------------------+
|                         Kubernetes Cluster                           |
|                                                                      |
|  +--------------+                                                    |
|  |  API Pod     |  <-- Scale independently for HTTP traffic          |
|  |  (HTTP)      |                                                    |
|  +------+-------+                                                    |
|         |                                                            |
|         v                                                            |
|   +-----------+                                                      |
|   |   Redis   |  <-- Global shared job queue                         |
|   |  (queue)  |                                                      |
|   +-----+-----+                                                      |
|         |                                                            |
|         +----------------+----------------+                          |
|         v                v                v                          |
|  +--------------+  +--------------+  +--------------+                |
|  | Worker-      |  | Worker-      |  | Worker-      |  <-- Scale by  |
|  | Sandbox 1    |  | Sandbox 2    |  | Sandbox 3    |     queue depth |
|  | +----------+ |  | +----------+ |  | +----------+ |                |
|  | | Worker   | |  | | Worker   | |  | | Worker   | |                |
|  | | (conc:1) | |  | | (conc:1) | |  | | (conc:1) | |                |
|  | +----+-----+ |  | +----+-----+ |  | +----+-----+ |                |
|  |      |        |  |      |        |  |      |        |                |
|  | +----v-----+ |  | +----v-----+ |  | +----v-----+ |                |
|  | | Sandbox  | |  | | Sandbox  | |  | | Sandbox  | |                |
|  | | (NsJail) | |  | | (NsJail) | |  | | (NsJail) | |                |
|  | +----------+ |  | +----------+ |  | +----------+ |                |
|  +--------------+  +--------------+  +--------------+                |
|                                                                      |
|  +---------------------------------------------------------------+   |
|  |                 Package delivery                               |   |
|  |  KVM default: /pkgs in each baked ext4 block-root image        |   |
|  |  Direct mode: shared package PVC populated by package-init     |   |
|  +---------------------------------------------------------------+   |
|                                                                      |
|  Total sandbox capacity: 3 pods x 8 concurrent jobs = 24 jobs        |
+----------------------------------------------------------------------+
```

---

## Troubleshooting

### Pod stuck in `ErrImageNeverPull`
```bash
# Images must be built inside minikube's docker
eval $(minikube docker-env)
docker build -t <image-name>:latest ...
kubectl rollout restart deployment/<deployment-name>
```

### Pod stuck in `CrashLoopBackOff`
```bash
# Check logs
kubectl logs <pod-name> --previous
kubectl describe pod <pod-name>
```

### "runtime is unknown" error
```bash
# In source=pvc mode, check whether the package-init job populated the PVC:
kubectl get jobs -l app.kubernetes.io/component=package-init
kubectl logs job/codeapi-package-init

# Force a rebuild:
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true

# Then restart sandbox-runner pods
kubectl rollout restart deployment/codeapi-sandbox-runner
```

In the default `source=image` mode, rebuild and publish
`workerSandbox.sandboxImage` from the `sandbox-runner-baked` target instead; no
package-init Job or packages PVC is rendered.

### Connection refused on port 3112
```bash
# Make sure port-forward is running
kubectl port-forward svc/codeapi-api 3112:3112
```

### MinIO `ImagePullBackOff` (production values)
```bash
# The Bitnami MinIO chart may reference unavailable image tags.
# For local dev, values-local.yaml uses minio.useSimple=true which
# deploys the official minio/minio:latest image instead.
#
# If you see this in production, either:
# 1. Use minio.useSimple=true
# 2. Or specify a valid Bitnami image tag in values.yaml
```

---

## AWS / Cloud Deployment

For production AWS deployment, see the section below.
