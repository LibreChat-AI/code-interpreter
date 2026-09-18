#!/usr/bin/env bash

# Covers .github/scripts/resolve-release-version.sh: the version a release run
# publishes, and the runs that have to skip or fail instead. Every case builds a
# throwaway repository with an `origin` the resolver can query and a stubbed
# `gh`, so nothing here reaches the network or the real repository.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The resolver is deliberately kept outside each throwaway checkout. That
# mirrors release.yml preserving the workflow revision in RUNNER_TEMP before a
# workflow_run checks out the possibly historical release commit.
RESOLVER="$ROOT/.github/scripts/resolve-release-version.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
ORIGIN="$WORK/origin.git"
OUTPUT="$WORK/github_output"
LOG="$WORK/log"
CASE=''
STATUS=0
FAILURES=0

# `gh release view` is the only gh call the resolver makes. PUBLISHED lists the
# releases that already exist; anything else must not be invoked at all.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = 'release' ] && [ "$2" = 'view' ]; then
  for published in ${PUBLISHED:-}; do
    if [ "$published" = "$3" ]; then
      exit 0
    fi
  done
  exit 1
fi
echo "unexpected gh invocation: $*" >&2
exit 2
STUB
chmod +x "$WORK/bin/gh"
PATH="$WORK/bin:$PATH"

git_repo() {
  git -C "$REPO" "$@"
}

# A fresh repository whose layout matches what the resolver reads from the
# checkout: the version bump script it shells out to, and the chart it takes the
# app and chart versions from, trailing comments and quotes included.
new_case() {
  CASE="$1"
  rm -rf "$REPO" "$ORIGIN"
  git init -q --bare "$ORIGIN"
  git init -q -b main "$REPO"
  git_repo config user.name test
  git_repo config user.email test@example.com
  git_repo remote add origin "$ORIGIN"
  mkdir -p "$REPO/.github/scripts" "$REPO/helm/codeapi"
  cp "$ROOT/.github/scripts/next-release-version.sh" "$REPO/.github/scripts/"
  cat > "$REPO/helm/codeapi/Chart.yaml" <<'CHART'
apiVersion: v2
name: codeapi
version: 0.3.1       # Chart version
appVersion: "2.0.0"  # App version
CHART
  commit api/runtime.ts initial 'chore: initial import'
  publish_main
}

commit() {
  local path="$1" content="$2" message="$3"
  mkdir -p "$REPO/$(dirname "$path")"
  printf '%s\n' "$content" > "$REPO/$path"
  git_repo add "$path"
  git_repo commit -q -m "$message"
}

publish_main() {
  git_repo push -q origin main
}

head_sha() {
  git_repo rev-parse HEAD
}

# Runs the resolver in the throwaway repository. Arguments are KEY=VALUE pairs
# standing in for the workflow's env block.
resolve() {
  : > "$OUTPUT"
  set +e
  (cd "$REPO" && env GITHUB_OUTPUT="$OUTPUT" "$@" bash "$RESOLVER") > "$LOG" 2>&1
  STATUS=$?
  set -e
}

fail() {
  echo "FAIL [$CASE] $1" >&2
  sed 's/^/  | /' "$LOG" >&2
  FAILURES=$((FAILURES + 1))
}

expect_status() {
  if [ "$STATUS" != "$1" ]; then
    fail "exit status: expected $1, got $STATUS"
  fi
}

expect_output() {
  local actual
  actual="$(sed -n "s/^$1=//p" "$OUTPUT" | tail -n 1)"
  if [ "$actual" != "$2" ]; then
    fail "output $1: expected '$2', got '$actual'"
  fi
}

expect_log() {
  if ! grep -qF "$1" "$LOG"; then
    fail "expected log to mention: $1"
  fi
}

# An untagged tip of main is the ordinary automatic-release path: the version
# comes from Conventional Commit intent since the last stable tag. Filtering
# tags with `grep` used to abort the step here, because no match under
# `pipefail` looks like a command failure.
new_case 'automatic release from an untagged commit'
git_repo tag v1.2.3
commit api/runtime.ts repaired 'fix: repair execution'
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 0
expect_output skip false
expect_output version v1.2.4
expect_output app_version 2.0.0
expect_output chart_version 0.3.1
expect_output prerelease false
expect_output latest true
expect_output draft false

new_case 'documentation-only range releases nothing'
git_repo tag v1.2.3
commit docs/guide.md docs 'docs: clarify deployment'
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 0
expect_output skip true
expect_output version ''
expect_log 'no release needed'

new_case 'a repository without a stable tag reports why'
commit api/runtime.ts repaired 'fix: repair execution'
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 1
expect_log 'Automatic releases require an existing stable'

# The rerun-to-publish recovery path: a previous run created the tag and then
# failed before the release existed.
new_case 'a rerun resumes the tag that already points at HEAD'
git_repo tag v1.2.3
commit api/runtime.ts repaired 'fix: repair execution'
git_repo tag v1.2.4
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)" PUBLISHED=''
expect_status 0
expect_output skip false
expect_output version v1.2.4
expect_output latest true

new_case 'a published tag at HEAD releases nothing twice'
git_repo tag v1.2.3
commit api/runtime.ts repaired 'fix: repair execution'
git_repo tag v1.2.4
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)" PUBLISHED='v1.2.4'
expect_status 0
expect_output skip true
expect_log 'already publishes this commit'

new_case 'a calculated tag held by another commit is a collision'
git_repo tag v1.2.3
git_repo checkout -q -b elsewhere
commit api/runtime.ts diverged 'fix: unrelated work'
git_repo tag v1.2.4
git_repo checkout -q main
commit api/runtime.ts repaired 'fix: repair execution'
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 1
expect_log 'already exists on a different commit'

new_case 'a calculated tag held by a non-commit object is a collision'
git_repo tag v1.2.3
blob="$(printf 'not a commit\n' | git_repo hash-object -w --stdin)"
git_repo update-ref refs/tags/v1.2.4 "$blob"
commit api/runtime.ts repaired 'fix: repair execution'
publish_main
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 1
expect_log 'already exists but does not point to a commit'

new_case 'a stale CI run defers to the newer tip'
git_repo tag v1.2.3
commit api/runtime.ts repaired 'fix: repair execution'
publish_main
commit api/runtime.ts advanced 'fix: land more work'
resolve EVENT_NAME=workflow_run HEAD_SHA="$(head_sha)"
expect_status 0
expect_output skip true
expect_log 'main advanced after this CI run'

new_case 'a dispatched version may omit the v prefix'
git_repo tag v1.2.3
resolve EVENT_NAME=workflow_dispatch REF_TYPE=branch REF_NAME=main \
  INPUT_VERSION=2.0.0 INPUT_DRAFT=true
expect_status 0
expect_output version v2.0.0
expect_output prerelease false
expect_output latest true
expect_output draft true

new_case 'a release candidate is a prerelease and never latest'
git_repo tag v1.2.3
resolve EVENT_NAME=workflow_dispatch REF_TYPE=branch REF_NAME=main \
  INPUT_VERSION=v1.3.0-rc1
expect_status 0
expect_output version v1.3.0-rc1
expect_output prerelease true
expect_output latest false

new_case 'dispatching from a topic branch is refused'
resolve EVENT_NAME=workflow_dispatch REF_TYPE=branch REF_NAME=feature/x \
  INPUT_VERSION=v1.3.0
expect_status 1
expect_log 'Releases must be cut from main'

new_case 'dispatching an existing version is refused'
git_repo tag v1.2.3
resolve EVENT_NAME=workflow_dispatch REF_TYPE=branch REF_NAME=main \
  INPUT_VERSION=v1.2.3
expect_status 1
expect_log 'already exists'

new_case 'a malformed version is refused'
resolve EVENT_NAME=workflow_dispatch REF_TYPE=branch REF_NAME=main \
  INPUT_VERSION=1.2
expect_status 1
expect_log 'Release tags must be'

new_case 'a pushed older patch tag does not become latest'
git_repo tag v9.9.9
resolve EVENT_NAME=push REF_TYPE=tag REF_NAME=v1.0.1
expect_status 0
expect_output version v1.0.1
expect_output prerelease false
expect_output latest false

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES release version resolution assertion(s) failed" >&2
  exit 1
fi

echo 'release version resolution tests passed'
