#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${EXPECTED_AWS_ACCOUNT:?Set EXPECTED_AWS_ACCOUNT}"

JWT_SECRET_NAME="${JWT_SECRET_NAME:-LibreChat/group-dev/codeapi/jwt-key}"
MANIFEST_SECRET_NAME="${MANIFEST_SECRET_NAME:-LibreChat/group-dev/codeapi/execution-manifest-key}"
PUBLIC_KEY_FILE="${PUBLIC_KEY_FILE:-.build-lambda-microvm/manifest-public-key}"
ACCOUNT="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

if [[ "$ACCOUNT" != "$EXPECTED_AWS_ACCOUNT" ]]; then
  echo "Expected AWS account $EXPECTED_AWS_ACCOUNT, got $ACCOUNT" >&2
  exit 1
fi

if aws secretsmanager describe-secret --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --secret-id "$JWT_SECRET_NAME" >/dev/null 2>&1 || \
  aws secretsmanager describe-secret --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --secret-id "$MANIFEST_SECRET_NAME" >/dev/null 2>&1; then
  echo 'One or both CodeAPI key secrets already exist; no keys were changed.' >&2
  exit 1
fi

KEY_DIR="$(mktemp -d)"
ORIGINAL_UMASK="$(umask)"
trap 'rm -rf "$KEY_DIR"; umask "$ORIGINAL_UMASK"' EXIT
umask 077

openssl genpkey -algorithm ED25519 -out "$KEY_DIR/jwt-private.pem"
openssl pkey -in "$KEY_DIR/jwt-private.pem" -pubout -out "$KEY_DIR/jwt-public.pem"
jq -n \
  --arg privateKeyBase64 "$(base64 < "$KEY_DIR/jwt-private.pem" | tr -d '\n')" \
  --rawfile publicKey "$KEY_DIR/jwt-public.pem" \
  '{privateKeyBase64: $privateKeyBase64, publicKey: $publicKey}' > "$KEY_DIR/jwt.json"

openssl genpkey -algorithm ED25519 -out "$KEY_DIR/manifest-private.pem"
jq -n \
  --arg privateKey "$(openssl pkey -in "$KEY_DIR/manifest-private.pem" -outform DER | base64 | tr -d '\n')" \
  '{privateKey: $privateKey}' > "$KEY_DIR/manifest.json"

aws secretsmanager create-secret --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --name "$JWT_SECRET_NAME" --secret-string "file://$KEY_DIR/jwt.json" >/dev/null
aws secretsmanager create-secret --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --name "$MANIFEST_SECRET_NAME" --secret-string "file://$KEY_DIR/manifest.json" >/dev/null

mkdir -p "$(dirname "$PUBLIC_KEY_FILE")"
openssl pkey -in "$KEY_DIR/manifest-private.pem" -pubout -outform DER \
  | base64 | tr -d '\n' > "$PUBLIC_KEY_FILE"

echo "Created $JWT_SECRET_NAME and $MANIFEST_SECRET_NAME."
echo "Wrote the non-secret manifest verifier to $PUBLIC_KEY_FILE."
