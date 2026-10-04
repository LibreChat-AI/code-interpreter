# Sandbox security maintenance

The default boundary is NsJail inside a libkrun guest. Direct NsJail mode
shares the host kernel and is for trusted development, not hostile workloads.

## Verify deployed patches

Repository dependencies do not establish production kernel patch status.
Inventory each runner node and deployed runner image:

- Host OS and running kernel release (`uname -r` on the node).
- Container runtime version and runner image digest.
- Installed `libkrun` and `libkrunfw` packages
  (`rpm -q libkrun libkrunfw` inside the runner image).
- Bundled guest kernel release, from an operator-controlled guest inspection.
- Guest-visible nested virtualization features and exposed virtual devices.

Match kernel packages against distro security advisories, including backports.
Patch both the host kernel and bundled guest kernel. Rebuild and replace runner
images after guest-kernel updates; reboot or use the vendor-supported livepatch
procedure for host fixes. A container rebuild does not update host KVM.

Priority 2026 checks:

| Boundary | Advisory |
|---|---|
| Guest kernel; host kernel in direct mode | Bad Epoll, CVE-2026-46242 |
| Guest and host kernels | GhostLock, CVE-2026-43499 |
| x86 host KVM | CVE-2026-46113, CVE-2026-53359, CVE-2026-64561 |
| ARM host KVM, when virtual ITS is exposed | CVE-2026-46316 |

PI-futex filtering reduces the GhostLock surface but does not replace patches.
Do not disable ordinary futex or epoll operations: language runtimes use them.
Do not expose nested virtualization to untrusted guests. Confirm the installed
VMM's behavior rather than assuming current upstream defaults match its build.

The October 2026 Vercel KVM report has no disclosed root cause or affected-version
matrix at the time of this change. These controls are not a verified fix for it.

## Preserve host-side confinement

- Run sandbox runners on isolated nodes, separate from credential-bearing
  control-plane workloads, with least-privilege node IAM.
- Keep hardened startup, signed manifests, egress controls, network policies,
  and disabled runner service-account token mounting.
- The launcher refuses to boot if its host-side seccomp filter cannot install.
- Internal authenticated HTTP requests reject redirects. Configure their final
  endpoints directly; do not depend on HTTP-to-HTTPS redirects.

## Dependency checks

Run `bun audit --cwd api` and `bun audit --cwd service` against the lockfiles.
Distinguish development dependencies from production paths and establish the
advisory's prerequisites before claiming an application exploit. Do not force
incompatible transitive major upgrades solely to obtain a clean audit.

Remaining service audit findings at this change:

- `stream-json` (GHSA-528h-pc64-c93x): MinIO 8 uses its JSON-lines parser,
  not the affected path filters. Keep MinIO's supported major dependency;
  reassess if notifications or path filters become reachable.
- `braces` (GHSA-vfj7-8cjw-p6xm): development-only dependency with no published
  fix. Do not feed untrusted patterns to build tooling; track an upstream fix.
