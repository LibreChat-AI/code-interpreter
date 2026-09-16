# Releasing

Deployments should track a tag, not `main`. This document covers how those
tags are cut.

## Versioning

A release is named `vMAJOR.MINOR.PATCH`, optionally with a `-rcN` suffix for a
release candidate — `v1.0.0`, `v1.1.0-rc1`. This is the public repository's
release sequence and is independent from the versions of the components it
contains. The first public release is therefore `v1.0.0` even though the API,
service, and Helm chart already have their own version histories.

Component versions are deliberately independent:

- `helm/codeapi/Chart.yaml`'s `appVersion` identifies the API version deployed
  by the chart.
- `helm/codeapi/Chart.yaml`'s `version` is the **chart** version. Bump it when
  the chart's templates or values change, not when the app changes. It names
  the packaged chart attached to the release (`codeapi-<chart version>.tgz`).
- `service/package.json`'s `version` tracks the Lambda service package alone.

By convention `api/package.json`'s `version` is kept in step with `appVersion`.
Nothing enforces it.

## Automatic releases

After the full **CI** workflow succeeds for the current tip of `main`, the
release workflow examines everything since the last stable repository tag. It
cuts a release when that range changes deployable files and skips ranges that
only change documentation, GitHub workflows, or tests. If several merges land
while CI is running, the newest successful run releases them together.

The next version follows Conventional Commit intent across the unreleased
range:

- a `BREAKING CHANGE:` footer or `type!:` subject bumps the major version;
- a `feat:` subject bumps the minor version;
- every other deployable change bumps the patch version.

This makes the safe fallback a patch release even when a merge title does not
follow the convention. The workflow packages the Helm chart before creating
the tag, so a packaging failure leaves the version available for a retry. A
rerun also resumes publication if the tag was created before a later step
failed.

## Manual releases

1. Land every intended component version bump on `main` first. `main` takes no
   direct pushes (see [CONTRIBUTING.md](../CONTRIBUTING.md)), so changes arrive
   through a sync pull request from the internal monorepo or a community pull
   request. Bump the chart `version` only if the chart changed.
2. Run the **Release** workflow from the Actions tab against `main`, entering
   the next repository version (`v1.1.0`). Tick *draft* to review the generated
   notes before they go public.

Use this path when intentionally overriding the automatically selected version,
cutting a release candidate, or recovering while automatic releases are
disabled. The workflow validates the version, packages the Helm chart, then
creates the annotated tag and publishes the release.

A tag pushed by hand works as well, and takes the same path from validation
onward:

```bash
git checkout main && git pull
git tag -a v1.1.0 -m v1.1.0
git push origin v1.1.0
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
gh release delete v1.1.0 --cleanup-tag --yes
```

Republishing the same version is only safe while nobody has deployed it. Once
a tag is public, ship a new patch instead.
