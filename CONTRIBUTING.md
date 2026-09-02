# Contributing

Thanks for your interest in Code Interpreter!

## How this repository is maintained

This repository is published from an internal ClickHouse monorepo, which is
the source of truth. Internal changes that are not already public are mirrored
here as a snapshot commit on the `sync/main` branch (spot them by the
`Source: ClickHouse/ai@<sha>` trailer); a maintainer merges the resulting sync
pull request to release it to `main`.

Practical consequences:

- **Pull requests are welcome.** CI runs on every PR. After a maintainer merges
  your change here, an automated bridge opens a matching internal pull request
  from the exact landed range. The internal review and CI gates still apply,
  and attribution is preserved with a `Co-authored-by:` trailer.
- **`main` accepts no direct pushes.** It advances through reviewed community
  pull requests and automated sync pull requests; branch rules enforce this
  with no exceptions.
- **History is snapshot-based.** Commits here intentionally do not mirror the
  internal commit history.

## Releases

Tagged releases are cut from `main` as `vMAJOR.MINOR.PATCH` (with `-rcN` for
release candidates), and each one carries the packaged Helm chart. The version
comes from `helm/codeapi/Chart.yaml`'s `appVersion`, so a version bump lands on
`main` through the pull request flow above before it can be released. See
[docs/RELEASING.md](docs/RELEASING.md) for the full process.

## Development

See the [README](README.md) for the architecture overview and
`docker compose up --build` for a local stack. Component-level docs live in
`api/`, `service/`, and `helm/codeapi/`.

## Reporting issues

Open a GitHub issue with reproduction steps. For suspected security issues,
please do not open a public issue — contact the maintainers instead.
