# Seccomp Profile for NsJail Sandbox

This directory contains a custom seccomp profile that restricts syscalls for the NsJail sandbox container.

## Overview

The `nsjail.json` profile uses a whitelist approach - only explicitly allowed syscalls can be executed. This significantly reduces the kernel attack surface compared to `seccomp=unconfined`.

## Allowed Syscall Categories

1. **Base syscalls** (~280 syscalls) - Standard operations for file I/O, networking, memory management, process control, etc.

2. **NsJail namespace operations** - `clone`, `clone3`, `setns`, `unshare`, `sethostname`, `setdomainname`

3. **NsJail mount operations** - `mount`, `umount`, `umount2`, `pivot_root`

4. **NsJail chroot** - `chroot`

5. **NsJail ptrace** - `ptrace`, `process_vm_readv`, `process_vm_writev`

6. **Personality** - Limited to reading current personality or setting to 0

## Blocked Syscalls (Examples)

The following dangerous syscalls are NOT in the whitelist and will return EPERM:

- `socket(AF_ALG)` - Linux userspace crypto API used by Copy Fail (CVE-2026-31431)
- `socket(AF_RXRPC)` - RxRPC socket family used by Dirty Frag (CVE-2026-43500)
- `kexec_load`, `kexec_file_load` - Kernel replacement
- `init_module`, `finit_module`, `delete_module` - Kernel module loading
- `reboot` - System reboot
- `swapon`, `swapoff` - Swap manipulation
- `acct` - Process accounting
- `settimeofday`, `clock_settime` - Time manipulation
- `ioperm`, `iopl` - I/O port access
- `bpf` - BPF program loading (except via seccomp itself)

## Usage

### Docker Compose

```yaml
services:
    sandbox:
        security_opt:
            - seccomp=./seccomp/nsjail.json
```

### Kubernetes

For Kubernetes, the seccomp profile must be available on each node. The `RuntimeDefault` profile is too restrictive for NsJail (blocks `pivot_root`), so you need to deploy the custom profile.

#### Quick Start (Minikube)

```bash
# Extract profile from ConfigMap and copy to node
kubectl get configmap codeapi-seccomp-profile -o jsonpath='{.data.nsjail\.json}' > /tmp/nsjail.json
minikube cp /tmp/nsjail.json /var/lib/kubelet/seccomp/profiles/nsjail.json

# Enable seccomp in Helm values
helm upgrade codeapi ./helm/codeapi --set workerSandbox.seccomp.enabled=true
```

#### Production Deployment

For production clusters with multiple nodes, use one of these approaches:

**Option 1: Node Configuration Management**

Use your cluster's node configuration tool (e.g., Ansible, Puppet, cloud-init) to copy the profile to `/var/lib/kubelet/seccomp/profiles/nsjail.json` on each node before deploying.

**Option 2: DaemonSet Installer**

Create a privileged DaemonSet that copies the profile to each node:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
    name: seccomp-profile-installer
spec:
    selector:
        matchLabels:
            app: seccomp-installer
    template:
        metadata:
            labels:
                app: seccomp-installer
        spec:
            initContainers:
                - name: install-profile
                  image: busybox:1.36.1
                  command:
                      - sh
                      - -c
                      - |
                          mkdir -p /host/var/lib/kubelet/seccomp/profiles
                          cp /profiles/nsjail.json /host/var/lib/kubelet/seccomp/profiles/
                  volumeMounts:
                      - name: host-seccomp
                        mountPath: /host/var/lib/kubelet/seccomp
                      - name: profiles
                        mountPath: /profiles
                  securityContext:
                      privileged: true
            containers:
                - name: pause
                  image: gcr.io/google_containers/pause:3.2
                  resources:
                      requests:
                          cpu: 1m
                          memory: 1Mi
            volumes:
                - name: host-seccomp
                  hostPath:
                      path: /var/lib/kubelet/seccomp
                      type: DirectoryOrCreate
                - name: profiles
                  configMap:
                      name: codeapi-seccomp-profile
            tolerations:
                - operator: Exists
```

#### Helm Configuration

When `workerSandbox.seccomp.enabled=true`, the Helm chart:

1. Creates a ConfigMap with the seccomp profile
2. Configures sandbox pods to use `Localhost` seccomp with `profiles/nsjail.json`

You must ensure the profile is installed on nodes before enabling this option.

## Testing

After applying the profile, run the test suite:

```bash
./test-sandbox-docker.sh
```

All tests should pass. If NsJail fails with "Operation not permitted", check the logs for which syscall is being blocked and add it to the whitelist if necessary.

## Security Impact

| Metric                | Without Seccomp | With Seccomp |
| --------------------- | --------------- | ------------ |
| Allowed syscalls      | ~450            | ~300         |
| Kernel attack surface | High            | Reduced      |
| Module loading        | Possible        | Blocked      |
| Time manipulation     | Possible        | Blocked      |
| BPF loading           | Possible        | Blocked      |
