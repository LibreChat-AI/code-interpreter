#!/usr/bin/env bash

# Resolves which version a release run publishes, or decides that it publishes
# nothing, and records the decision in $GITHUB_OUTPUT. Extracted from
# .github/workflows/release.yml so the four entry paths — an automatic release
# after CI, a rerun resuming a release whose tag was already cut, a dispatch,
# and a pushed tag — are covered by tests/release-version-resolution.sh.
#
# Inputs arrive as environment variables, mirroring the workflow's env block:
#
#   EVENT_NAME     github.event_name
#   HEAD_SHA       github.event.workflow_run.head_sha
#   INPUT_VERSION  github.event.inputs.version
#   INPUT_DRAFT    github.event.inputs.draft
#   REF_NAME       github.ref_name
#   REF_TYPE       github.ref_type
#   GH_TOKEN       a token `gh release view` can read releases with
#
# Outputs: skip, and for a real release version, app_version, chart_version,
# prerelease, latest, draft. Run from the repository root; the chart fields are
# read from helm/codeapi/Chart.yaml relative to it.

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
HEAD_SHA="${HEAD_SHA:-}"
INPUT_VERSION="${INPUT_VERSION:-}"
INPUT_DRAFT="${INPUT_DRAFT:-}"
REF_NAME="${REF_NAME:-}"
REF_TYPE="${REF_TYPE:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:?GITHUB_OUTPUT must name the step output file}"

STABLE_TAG_PATTERN='^v[0-9]+[.][0-9]+[.][0-9]+$'

# `grep` exits 1 when nothing matches, and under `pipefail` that would abort the
# step. A commit with no stable tag is the ordinary state of `main`, so a
# no-match reads as an empty answer while a genuine grep failure — exit 2 and
# above — still fails the release.
select_stable_tags() {
  local status=0
  grep -E "$STABLE_TAG_PATTERN" || status=$?
  [ "$status" -le 1 ]
}

# Highest stable tag among those `git tag` selects, empty when there are none.
newest_stable_tag() {
  git tag "$@" | select_stable_tags | sort -V | tail -n 1
}

# The commit a tag resolves to. The caller first verifies that the ref exists,
# so a failure here means the tag ultimately names a non-commit object.
tag_commit() {
  git rev-parse -q --verify "refs/tags/$1^{commit}"
}

SKIP=false
VERSION=""
HEAD_COMMIT=""

if [ "$EVENT_NAME" = "workflow_run" ]; then
  HEAD_COMMIT="$(git rev-parse HEAD)"
  if [ "$HEAD_COMMIT" != "$HEAD_SHA" ]; then
    echo "::error::Checked out SHA does not match the successful CI run"
    exit 1
  fi

  REMOTE_MAIN_SHA="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  if [ -z "$REMOTE_MAIN_SHA" ]; then
    echo "::error::Could not resolve the current main branch tip"
    exit 1
  fi
  if [ "$REMOTE_MAIN_SHA" != "$HEAD_SHA" ]; then
    echo "main advanced after this CI run; the newer successful run will release the combined changes"
    SKIP=true
  fi

  # A rerun after tag creation but before release publication resumes the
  # missing release rather than incrementing the version again.
  EXACT_TAG="$(newest_stable_tag --points-at HEAD)"
  if [ "$SKIP" = "false" ] && [ -n "$EXACT_TAG" ]; then
    if gh release view "$EXACT_TAG" >/dev/null 2>&1; then
      echo "$EXACT_TAG already publishes this commit; nothing to do"
      SKIP=true
    else
      VERSION="$EXACT_TAG"
    fi
  elif [ "$SKIP" = "false" ]; then
    PREVIOUS_TAG="$(newest_stable_tag --merged HEAD)"
    if [ -z "$PREVIOUS_TAG" ]; then
      echo "::error::Automatic releases require an existing stable vMAJOR.MINOR.PATCH tag"
      exit 1
    fi
    VERSION="$(.github/scripts/next-release-version.sh "$PREVIOUS_TAG" "$PREVIOUS_TAG..HEAD")"
    if [ -z "$VERSION" ]; then
      echo "Only documentation, workflow, or test files changed since $PREVIOUS_TAG; no release needed"
      SKIP=true
    fi
  fi
elif [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  # Releases describe what shipped to main. Dispatching from a topic branch
  # would tag a commit that is not on the release line.
  if [ "$REF_TYPE" != "branch" ] || [ "$REF_NAME" != "main" ]; then
    echo "::error::Releases must be cut from main; this run is on '$REF_NAME'"
    exit 1
  fi
  VERSION="$INPUT_VERSION"
else
  VERSION="$REF_NAME"
fi

if [ "$SKIP" = "true" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

# A bare "2.0.0" typed into the dispatch box is accepted; everything downstream
# works with the v-prefixed form the tag actually uses.
case "$VERSION" in
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac

if [[ ! "$VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+(-rc[0-9]+)?$ ]]; then
  echo "::error::Release tags must be v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-rcN, for example v1.0.0 or v1.1.0-rc1 (got '$VERSION')"
  exit 1
fi

if [ "$EVENT_NAME" = "workflow_run" ]; then
  # A tag already pointing at this commit is the resumed release above, and the
  # publish steps tolerate it. Only a tag on some other commit is a collision.
  if git show-ref --verify --quiet "refs/tags/$VERSION"; then
    if ! EXISTING_TAG_COMMIT="$(tag_commit "$VERSION")"; then
      echo "::error::Calculated tag $VERSION already exists but does not point to a commit"
      exit 1
    fi
    if [ "$EXISTING_TAG_COMMIT" != "$HEAD_COMMIT" ]; then
      echo "::error::Calculated tag $VERSION already exists on a different commit"
      exit 1
    fi
  fi
fi

read_chart_field() {
  grep -m1 "^$1:" helm/codeapi/Chart.yaml \
    | sed -E "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*//; s/^[\"']//; s/[\"']\$//"
}
APP_VERSION="$(read_chart_field appVersion)"
CHART_VERSION="$(read_chart_field version)"

if [ "$EVENT_NAME" = "workflow_dispatch" ] \
   && git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "::error::Tag $VERSION already exists. Pick a new version, or delete the tag if it was cut in error."
  exit 1
fi

case "$VERSION" in
  *-rc*) PRERELEASE=true ;;
  *) PRERELEASE=false ;;
esac

# `latest` moves only when this is the highest stable version, so re-cutting an
# older patch cannot drag it backwards. The tag under dispatch does not exist
# yet, hence adding it to the comparison.
LATEST=false
if [ "$PRERELEASE" = "false" ]; then
  HIGHEST_STABLE="$(
    {
      git tag --list 'v[0-9]*'
      printf '%s\n' "$VERSION"
    } \
      | select_stable_tags \
      | sort -V \
      | tail -n 1
  )"
  if [ "$HIGHEST_STABLE" = "$VERSION" ]; then
    LATEST=true
  fi
fi

DRAFT=false
if [ "$INPUT_DRAFT" = "true" ]; then
  DRAFT=true
fi

{
  echo "skip=false"
  echo "version=$VERSION"
  echo "app_version=$APP_VERSION"
  echo "chart_version=$CHART_VERSION"
  echo "prerelease=$PRERELEASE"
  echo "latest=$LATEST"
  echo "draft=$DRAFT"
} >> "$GITHUB_OUTPUT"

echo "Releasing $VERSION (chart $CHART_VERSION, appVersion $APP_VERSION, prerelease=$PRERELEASE, latest=$LATEST, draft=$DRAFT)"
