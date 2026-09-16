#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${EXPECTED_AWS_ACCOUNT:?Set EXPECTED_AWS_ACCOUNT}"

ECR_REPOSITORY="${ECR_REPOSITORY:-librechat/codeapi}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=7 HEAD)}"
DOCKER_BIN="${DOCKER_BIN:-/usr/local/bin/docker}"
export DOCKER_BUILDKIT=1
ACCOUNT="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

if [[ "$ACCOUNT" != "$EXPECTED_AWS_ACCOUNT" ]]; then
  echo "Expected AWS account $EXPECTED_AWS_ACCOUNT, got $ACCOUNT" >&2
  exit 1
fi

DOCKER_PLUGIN_DIR="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
ln -s "$DOCKER_PLUGIN_DIR" "$DOCKER_CONFIG/cli-plugins"

if ! aws ecr describe-repositories \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi

REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
REPOSITORY_URI="$REGISTRY/$ECR_REPOSITORY"
ECR_PASSWORD="$(aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION")"
ECR_AUTH="$(printf 'AWS:%s' "$ECR_PASSWORD" | base64 | tr -d '\n')"
jq -n --arg registry "$REGISTRY" --arg auth "$ECR_AUTH" \
  '{auths: {($registry): {auth: $auth}}}' > "$DOCKER_CONFIG/config.json"
unset ECR_PASSWORD ECR_AUTH

build() {
  local component="$1"
  local dockerfile="$2"
  local target="$3"
  shift 3
  local tag="$IMAGE_TAG-$component"

  if aws ecr describe-images \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-ids "imageTag=$tag" >/dev/null 2>&1; then
    echo "$tag already exists"
    return
  fi

  "$DOCKER_BIN" build \
    --platform linux/amd64 \
    --file "$dockerfile" \
    --target "$target" \
    --tag "$REPOSITORY_URI:$tag" \
    "$@" \
    .
  "$DOCKER_BIN" push "$REPOSITORY_URI:$tag"
}

build api service/Dockerfile api
build worker service/Dockerfile worker
build file-server service/Dockerfile production
build tool-call-server service/Dockerfile.tool-call-server production
build egress-gateway service/Dockerfile egress-gateway
build worker-sandbox docker/Dockerfile.worker-sandbox worker-sandbox-true
build worker-sandbox-direct docker/Dockerfile.worker-sandbox-direct direct \
  --build-arg "BASE_IMAGE=$REPOSITORY_URI:$IMAGE_TAG-worker-sandbox"

aws ecr describe-images \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --repository-name "$ECR_REPOSITORY" \
  --query "imageDetails[?imageTags && starts_with(imageTags[0], '$IMAGE_TAG-')].{tags:imageTags,digest:imageDigest}" \
  --output table
