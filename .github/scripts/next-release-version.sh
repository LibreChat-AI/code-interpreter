#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <current-vMAJOR.MINOR.PATCH> <git-revision-range>" >&2
  exit 2
fi

CURRENT_TAG="$1"
REVISION_RANGE="$2"

if [[ ! "$CURRENT_TAG" =~ ^v([0-9]+)[.]([0-9]+)[.]([0-9]+)$ ]]; then
  echo "current release must be a stable vMAJOR.MINOR.PATCH tag (got '$CURRENT_TAG')" >&2
  exit 2
fi

# Documentation, workflow, and test-only changes remain auditable in git but do
# not produce a deployable release. Any unrecognised path is treated as
# deployable so a newly added runtime component cannot silently miss a release.
DEPLOYABLE=false
while IFS= read -r path; do
  case "$path" in
    .github/*|docs/*|tests/*|*.md|*/README|*/README.*|*.test.*|*.spec.*)
      ;;
    *)
      DEPLOYABLE=true
      break
      ;;
  esac
done < <(git diff --name-only "$REVISION_RANGE")

if [ "$DEPLOYABLE" = "false" ]; then
  exit 0
fi

COMMIT_MESSAGES="$(git log --format='%s%n%b' "$REVISION_RANGE")"
BUMP=patch

if grep -Eq '^[[:alnum:]_-]+(\([^)]*\))?!:' <<<"$COMMIT_MESSAGES" \
   || grep -Eq '^BREAKING([ -])CHANGE:' <<<"$COMMIT_MESSAGES"; then
  BUMP=major
elif grep -Eq '^feat(\([^)]*\))?:' <<<"$COMMIT_MESSAGES"; then
  BUMP=minor
fi

VERSION="${CURRENT_TAG#v}"
IFS=. read -r MAJOR MINOR PATCH <<<"$VERSION"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

printf 'v%s.%s.%s\n' "$MAJOR" "$MINOR" "$PATCH"
