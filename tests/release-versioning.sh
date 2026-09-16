#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="$ROOT/.github/scripts/next-release-version.sh"
TEST_REPO="$(mktemp -d)"
trap 'rm -rf "$TEST_REPO"' EXIT

git -C "$TEST_REPO" init -q
git -C "$TEST_REPO" config user.name test
git -C "$TEST_REPO" config user.email test@example.com

commit_file() {
  local path="$1"
  local content="$2"
  local message="$3"

  mkdir -p "$TEST_REPO/$(dirname "$path")"
  printf '%s\n' "$content" > "$TEST_REPO/$path"
  git -C "$TEST_REPO" add "$path"
  git -C "$TEST_REPO" commit -q -m "$message"
}

assert_version() {
  local expected="$1"
  local actual
  actual="$(cd "$TEST_REPO" && bash "$RESOLVER" v1.2.3 v1.2.3..HEAD)"
  if [ "$actual" != "$expected" ]; then
    echo "expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

commit_file api/runtime.ts initial 'chore: initial release'
git -C "$TEST_REPO" tag v1.2.3

commit_file docs/guide.md docs 'docs: clarify deployment'
assert_version ''

commit_file api/runtime.ts fix 'fix: repair execution'
assert_version v1.2.4

git -C "$TEST_REPO" reset -q --hard v1.2.3
commit_file api/runtime.ts feature 'feat: add execution mode'
assert_version v1.3.0

git -C "$TEST_REPO" reset -q --hard v1.2.3
commit_file api/runtime.ts breaking 'feat!: replace execution protocol'
assert_version v2.0.0

git -C "$TEST_REPO" reset -q --hard v1.2.3
commit_file service/config.ts config 'chore: tune runtime defaults'
assert_version v1.2.4

echo 'release versioning tests passed'
