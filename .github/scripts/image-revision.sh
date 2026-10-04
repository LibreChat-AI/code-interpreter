#!/usr/bin/env bash
# Prints the org.opencontainers.image.revision label of an image reference.
# Used by .github/workflows/images.yml, which must tell a missing tag apart
# from a registry that cannot answer.
#
# Exit 0  the revision was printed.
# Exit 3  the tag does not exist, or this token may not read it (a token that
#         may not read a repository may not write to it either).
# Exit 1  the registry did not answer after retries, or the image has no
#         revision label.
set -uo pipefail

ref=${1:?usage: image-revision.sh REF}
attempts=${IMAGE_REVISION_ATTEMPTS:-3}
err=$(mktemp)
trap 'rm -f "$err"' EXIT

for attempt in $(seq 1 "$attempts"); do
  if json=$(docker buildx imagetools inspect "$ref" --format '{{ json .Image }}' 2>"$err"); then
    if jq -er 'if has("config") then . else .["linux/amd64"] end
      | .config.Labels["org.opencontainers.image.revision"]' <<<"$json"; then
      exit 0
    fi
    echo "$ref has no revision label" >&2
    exit 1
  fi
  if grep -qiE ': not found$|denied|\b40[134]\b' "$err"; then
    exit 3
  fi
  cat "$err" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep $(( attempt * 5 ))
  fi
done
exit 1
