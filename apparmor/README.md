# AppArmor Security Hardening for the Code Interpreter Sandbox

This directory contains AppArmor profiles for hardening the NsJail-based sandbox container.

## Overview

The sandbox currently runs with `privileged: true` which grants full host capabilities. While NsJail provides strong isolation for executed code, the container itself has elevated privileges. AppArmor adds a second layer of defense (MAC - Mandatory Access Control) that restricts what the container can do even if NsJail is bypassed.

## Files

- `sandbox-nsjail` - AppArmor profile for the sandbox container

## Security Layers

| Layer     | Current                     | With AppArmor                        |
| --------- | --------------------------- | ------------------------------------ |
| Container | `privileged: true`          | Explicit capabilities + AppArmor MAC |
| Process   | NsJail namespaces + seccomp | NsJail + AppArmor deny rules         |
| Syscalls  | seccomp-bpf filtering       | seccomp + AppArmor restrictions      |

## Testing

### Local Testing (Docker Compose)

Capability-restricted mode is tested by overlaying the local-dev stack with a
Compose file (not shipped with this repo) that removes `privileged: true` from
the sandbox-runner service and grants the explicit capability set instead:

```bash
# Baseline (privileged: true)
docker compose -f docker-compose.local-dev.yml up -d
./test-sandbox.sh

# Capability-restricted (no privileged, explicit caps)
docker compose -f docker-compose.local-dev.yml -f your-capability-overlay.yml up -d
./test-sandbox.sh
```

**Note:** AppArmor profiles require native Linux with AppArmor enabled. WSL2 and Docker Desktop do not support AppArmor. The capability-restricted mode works without AppArmor.

### Kubernetes Testing (minikube)

```bash
# Start minikube
minikube start --cpus=4 --memory=8192

# Deploy with helm
./helm/setup-local.sh minikube

# Port forward and test
kubectl port-forward deploy/codeapi-worker-sandbox 2000:2000
./test-sandbox.sh
```

## Kubernetes Deployment with AppArmor

For production EKS deployment with AppArmor:

### 1. Load Profile on Nodes

Create a DaemonSet to load the profile:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
    name: apparmor-loader
    namespace: kube-system
spec:
    selector:
        matchLabels:
            app: apparmor-loader
    template:
        metadata:
            labels:
                app: apparmor-loader
        spec:
            hostPID: true
            containers:
                - name: loader
                  image: alpine
                  securityContext:
                      privileged: true
                  command: ['/bin/sh', '-c']
                  args:
                      - |
                          apk add --no-cache apparmor
                          cat > /etc/apparmor.d/sandbox-nsjail << 'PROFILE'
                          # Copy contents of sandbox-nsjail file here
                          PROFILE
                          apparmor_parser -r /etc/apparmor.d/sandbox-nsjail
                          echo "Profile loaded"
                          sleep infinity
                  volumeMounts:
                      - name: sys
                        mountPath: /sys
                      - name: apparmor
                        mountPath: /etc/apparmor.d
            volumes:
                - name: sys
                  hostPath:
                      path: /sys
                - name: apparmor
                  hostPath:
                      path: /etc/apparmor.d
```

### 2. Enable in Helm Values

```yaml
workerSandbox:
    securityHardening:
        enabled: true
        appArmorProfile: 'sandbox-nsjail'
```

### 3. Verify

```bash
# Check profile is loaded on nodes
kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.osImage}'

# Check pod annotation
kubectl get pod -l app.kubernetes.io/component=worker-sandbox -o jsonpath='{.items[0].metadata.annotations}'
```

## What the Profile Allows

Required for NsJail to function:

- `capability sys_admin` - Create namespaces, mount filesystems
- `capability sys_chroot` - Change root filesystem
- `mount`, `pivot_root` - Set up isolated filesystem
- `/pkgs/**`, `/tmp/**` - Sandbox working directories
- `/sys/fs/cgroup/**` - Resource limits via cgroups

## What the Profile Denies

Defense in depth if NsJail is bypassed:

- `/etc/shadow`, `/etc/gshadow` - Prevent credential theft
- `/var/run/docker.sock` - Prevent container escape via Docker API
- `/lib/modules/**` - Prevent kernel module loading
- `ptrace peer=unconfined` - Prevent tracing host processes

## Troubleshooting

### Check AppArmor Status

```bash
# On node
cat /sys/module/apparmor/parameters/enabled  # Should be Y
aa-status | grep sandbox-nsjail

# Check denials
dmesg | grep -i apparmor
```

### Debug Mode

```bash
# Set profile to complain mode (log but don't block)
aa-complain sandbox-nsjail

# Run tests, check dmesg for what would be denied
dmesg | grep -i apparmor

# Re-enable enforcement
aa-enforce sandbox-nsjail
```
