#!/bin/bash
# Builds the AWS Lambda MicroVM sandbox-runner artifacts.
#
# The Lambda MicroVM image pipeline is: zip(Dockerfile) -> S3 ->
# CreateMicrovmImage builds it on the AL2023 MicroVM base image. Our
# Dockerfile is a single FROM pointing at the prebuilt arm64 runner image
# in a same-account ECR repo (Lambda's build infra can pull it there).
#
# Stages (each optional, in order):
#   build   docker buildx the selected arm64 MicroVM target (no AWS)
#   push    push to ECR (needs AWS_PROFILE + repo)
#   zip     render the code-artifact Dockerfile and zip it (no AWS)
#   upload  upload the zip to S3 (needs AWS_PROFILE + bucket)
#
# Usage:
#   scripts/build-lambda-microvm-artifact.sh build
#   scripts/build-lambda-microvm-artifact.sh build push zip upload
#
# Env:
#   ECR_URI        e.g. 951834775723.dkr.ecr.us-east-2.amazonaws.com/codeapi-microvm-runner
#   IMAGE_TAG      default: git short sha
#   IMAGE_DIGEST   sha256 digest for a separately-invoked zip stage (normally
#                  captured automatically by push)
#   S3_URI         e.g. s3://codeapi-microvm-artifacts/runner
#   AWS_PROFILE    e.g. librechat-dev
#   AWS_REGION     required for push/upload
#   MICROVM_IMAGE_TARGET  lambda-microvm-runner (default) or
#                         lambda-microvm-app-host
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${IMAGE_TAG:-}" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "IMAGE_TAG is required when the worktree is dirty; use an explicit unique dev tag." >&2
    exit 1
  fi
  IMAGE_TAG="$(git rev-parse --short HEAD)"
fi
ECR_URI="${ECR_URI:-}"
S3_URI="${S3_URI:-}"
MICROVM_IMAGE_TARGET="${MICROVM_IMAGE_TARGET:-lambda-microvm-runner}"
case "$MICROVM_IMAGE_TARGET" in
  lambda-microvm-runner)
    ARTIFACT_KIND="runner"
    PUBLISHED_TAG="$IMAGE_TAG"
    DEFAULT_OUT_DIR=".build-lambda-microvm"
    ;;
  lambda-microvm-app-host)
    ARTIFACT_KIND="app-host"
    PUBLISHED_TAG="app-host-${IMAGE_TAG}"
    DEFAULT_OUT_DIR=".build-lambda-microvm-app-host"
    ;;
  *)
    echo "MICROVM_IMAGE_TARGET must be lambda-microvm-runner or lambda-microvm-app-host" >&2
    exit 1
    ;;
esac
OUT_DIR="${OUT_DIR:-$DEFAULT_OUT_DIR}"
LOCAL_TAG="codeapi-${MICROVM_IMAGE_TARGET}:${IMAGE_TAG}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"

require_ecr() {
  [ -n "$ECR_URI" ] || { echo "ECR_URI is required for this stage" >&2; exit 1; }
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

resolve_image_digest() {
  if [ -z "$IMAGE_DIGEST" ] && [ -f "$OUT_DIR/image-digest" ]; then
    local cached_repository cached_tag
    cached_repository="$(sed -n '1p' "$OUT_DIR/image-repository" 2>/dev/null || true)"
    cached_tag="$(sed -n '1p' "$OUT_DIR/image-tag" 2>/dev/null || true)"
    if [ "$cached_repository" != "$ECR_URI" ] || [ "$cached_tag" != "$PUBLISHED_TAG" ]; then
      echo "Cached image digest does not belong to ECR_URI=$ECR_URI PUBLISHED_TAG=$PUBLISHED_TAG; run push first or set IMAGE_DIGEST explicitly." >&2
      exit 1
    fi
    IMAGE_DIGEST="$(sed -n '1p' "$OUT_DIR/image-digest")"
  fi
  local digest_hex="${IMAGE_DIGEST#sha256:}"
  if [ "$digest_hex" = "$IMAGE_DIGEST" ] \
    || [ "${#digest_hex}" -ne 64 ] \
    || [[ "$digest_hex" == *[!0-9a-f]* ]]; then
      echo "An immutable ECR IMAGE_DIGEST is required (run push first or set it explicitly)." >&2
      exit 1
  fi
}

do_build() {
  local tags=(-t "$LOCAL_TAG")
  if [ -n "$ECR_URI" ]; then
    tags+=(-t "$ECR_URI:$PUBLISHED_TAG")
  fi
  echo ">> buildx arm64 ${MICROVM_IMAGE_TARGET} (${LOCAL_TAG})"
  docker buildx build \
    --platform linux/arm64 \
    --target "$MICROVM_IMAGE_TARGET" \
    -f api/Dockerfile \
    "${tags[@]}" \
    --load \
    .
}

do_push() {
  require_ecr
  mkdir -p "$OUT_DIR"
  echo ">> pushing $ECR_URI:$PUBLISHED_TAG"
  aws ecr get-login-password --region "${AWS_REGION:?AWS_REGION required}" \
    | docker login --username AWS --password-stdin "${ECR_URI%%/*}"
  # `build` is intentionally usable without AWS/ECR configuration. Tag here as
  # well so a later, separately invoked `push` stage still has the remote tag.
  docker image tag "$LOCAL_TAG" "$ECR_URI:$PUBLISHED_TAG"
  docker push "$ECR_URI:$PUBLISHED_TAG" | tee "$OUT_DIR/push.log"
  IMAGE_DIGEST="$(sed -n 's/^.*digest: \(sha256:[0-9a-f]\{64\}\).*$/\1/p' "$OUT_DIR/push.log" | tail -n 1)"
  [ -n "$IMAGE_DIGEST" ] || {
    echo "Could not determine the pushed ECR digest; refusing to render a mutable artifact." >&2
    exit 1
  }
  printf '%s\n' "$IMAGE_DIGEST" > "$OUT_DIR/image-digest"
  printf '%s\n' "$ECR_URI" > "$OUT_DIR/image-repository"
  printf '%s\n' "$PUBLISHED_TAG" > "$OUT_DIR/image-tag"
  echo ">> immutable ${ARTIFACT_KIND} ref: $ECR_URI@$IMAGE_DIGEST"
}

do_zip() {
  require_ecr
  mkdir -p "$OUT_DIR"
  resolve_image_digest
  cat > "$OUT_DIR/Dockerfile" <<EOF
FROM ${ECR_URI}@${IMAGE_DIGEST}
EOF
  (cd "$OUT_DIR" && rm -f artifact.zip && zip -q artifact.zip Dockerfile)
  printf '%s\n' "$ECR_URI" > "$OUT_DIR/artifact-image-repository"
  printf '%s\n' "$PUBLISHED_TAG" > "$OUT_DIR/artifact-image-tag"
  printf '%s\n' "$IMAGE_DIGEST" > "$OUT_DIR/artifact-image-digest"
  file_sha256 "$OUT_DIR/artifact.zip" > "$OUT_DIR/artifact-sha256"
  echo ">> wrote $OUT_DIR/artifact.zip (FROM ${ECR_URI}@${IMAGE_DIGEST})"
}

do_upload() {
  require_ecr
  [ -n "$S3_URI" ] || { echo "S3_URI is required for upload" >&2; exit 1; }
  resolve_image_digest
  if ! {
    [ -f "$OUT_DIR/artifact.zip" ] \
      && [ -f "$OUT_DIR/artifact-image-repository" ] \
      && [ -f "$OUT_DIR/artifact-image-tag" ] \
      && [ -f "$OUT_DIR/artifact-image-digest" ] \
      && [ -f "$OUT_DIR/artifact-sha256" ]
  }; then
    echo "No provenance-bound artifact found; run the zip stage first." >&2
    exit 1
  fi
  local artifact_repository artifact_tag artifact_digest artifact_hash actual_hash
  artifact_repository="$(sed -n '1p' "$OUT_DIR/artifact-image-repository")"
  artifact_tag="$(sed -n '1p' "$OUT_DIR/artifact-image-tag")"
  artifact_digest="$(sed -n '1p' "$OUT_DIR/artifact-image-digest")"
  artifact_hash="$(sed -n '1p' "$OUT_DIR/artifact-sha256")"
  actual_hash="$(file_sha256 "$OUT_DIR/artifact.zip")"
  if [ "$artifact_repository" != "$ECR_URI" ] \
    || [ "$artifact_tag" != "$PUBLISHED_TAG" ] \
    || [ "$artifact_digest" != "$IMAGE_DIGEST" ] \
    || [ "$artifact_hash" != "$actual_hash" ]; then
      echo "artifact.zip provenance does not match the current repository, tag, digest, or bytes; run zip again before upload." >&2
      exit 1
  fi
  local key="$S3_URI/${ARTIFACT_KIND}-${IMAGE_TAG}.zip"
  aws s3 cp "$OUT_DIR/artifact.zip" "$key" --region "${AWS_REGION:?AWS_REGION required}"
  echo ">> uploaded $key"
  cat <<EOF

Next:
  cd service
  AWS_PROFILE=... bun scripts/create-microvm-image.ts \\
    --name codeapi-${ARTIFACT_KIND} \\
    --artifact "$key" \\
    --build-role <build-role-with-s3+ecr-read> \\
    --region \${AWS_REGION} \\
    --env-json "\$MICROVM_IMAGE_ENV_JSON"

Notes:
- env vars (SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY, SANDBOX_REQUIRE_EGRESS_MANIFEST,
  EGRESS_GATEWAY_URL, SANDBOX_ALLOWED_LOCAL_NETWORK_PORT, SANDBOX_FORWARD_TARGET)
  are image-build-time config: pass them through MICROVM_IMAGE_ENV_JSON or
  --env-json on the helper.
- Build the image HOOKLESS (no --hooks). Lambda's image build hooks only route
  on the snapshot-compatible Lambda base container image, and enabling any
  runtime hook forces the /ready build hook, which never reaches a stock
  container's listener (builds then fail at the ready timeout). Session mode is
  delivered per-request via the X-Runtime-Session-Id header instead; idle
  suspend/resume is handled by RunMicrovm's native idlePolicy.
EOF
}

for stage in "$@"; do
  case "$stage" in
    build) do_build ;;
    push) do_push ;;
    zip) do_zip ;;
    upload) do_upload ;;
    *) echo "Unknown stage: $stage (expected build|push|zip|upload)" >&2; exit 1 ;;
  esac
done

[ $# -gt 0 ] || { echo "No stages given. Usage: $0 build [push] [zip] [upload]" >&2; exit 1; }
