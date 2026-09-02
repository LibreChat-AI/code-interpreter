# Releasing

Deployments should track a tag, not `main`. This document covers how those
tags are cut.

## Versioning

A release is named `vMAJOR.MINOR.PATCH`, optionally with a `-rcN` suffix for a
release candidate — `v2.0.0`, `v2.1.0-rc1`. That version is the **app
version**: `helm/codeapi/Chart.yaml`'s `appVersion` is its source of truth, and
the release workflow refuses any tag that disagrees with it. A release
candidate carries the version it is a candidate for, so `v2.1.0-rc1` also
requires `appVersion: "2.1.0"`.

Two other version numbers are deliberately independent:

- `helm/codeapi/Chart.yaml`'s `version` is the **chart** version. Bump it when
  the chart's templates or values change, not when the app changes. It names
  the packaged chart attached to the release (`codeapi-<chart version>.tgz`).
- `service/package.json`'s `version` tracks the Lambda service package alone.

By convention `api/package.json`'s `version` is kept in step with `appVersion`,
so the API package and the tag agree. Nothing enforces it.

## Cutting a release

1. Land the `appVersion` bump on `main` first. `main` takes no direct pushes
   (see [CONTRIBUTING.md](../CONTRIBUTING.md)), so it arrives through a sync
   pull request from the internal monorepo or a community pull request. Bump
   the chart `version` too if the chart changed.
2. Run the **Release** workflow from the Actions tab against `main`, entering
   the version (`v2.1.0`). Tick *draft* to review the generated notes before
   they go public.

The workflow validates the version, packages the Helm chart, then creates the
annotated tag and publishes the release. Packaging runs before tagging so a
failure — a rate-limited subchart pull, most likely — leaves the version
unused and the run safe to retry.

A tag pushed by hand works as well, and takes the same path from validation
onward:

```bash
git checkout main && git pull
git tag -a v2.1.0 -m v2.1.0
git push origin v2.1.0
```

## What the release contains

- The tag, so a deployment can pin a commit.
- Notes: a preamble on pinning and installing, followed by the merged
  pull requests since the previous tag, categorised per
  [.github/release.yml](../.github/release.yml).
- `codeapi-<chart version>.tgz`, the packaged Helm chart with its Redis and
  MinIO subcharts vendored, so it installs without adding chart repositories.

Release candidates are marked as pre-releases. The *Latest* badge moves only
when the release is stable **and** is the highest stable version in the
repository, so re-cutting an older patch cannot drag it backwards.

## If a release goes wrong

Delete the release and its tag, then re-run the workflow:

```bash
gh release delete v2.1.0 --cleanup-tag --yes
```

Republishing the same version is only safe while nobody has deployed it. Once
a tag is public, ship a new patch instead.
