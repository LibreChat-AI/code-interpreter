# Terraform: Lambda MicroVM prerequisites

Provisions the static AWS resources the CodeAPI Lambda MicroVM backend needs. The
MicroVM image and running VMs themselves are **not** Terraform-managed — the
`lambda-microvms` service has no TF resource yet, so those are created with
[`service/scripts/create-microvm-image.ts`](../../../service/scripts/create-microvm-image.ts)
and by the backend at runtime. See [../README.md](../README.md) for the full
walkthrough.

## What it creates

- **Checkpoint S3 bucket** — encrypted (SSE-S3), versioned, public-access
  blocked, with current and noncurrent versions lifecycle-expired separately
  (`checkpoint_retention_days` and
  `checkpoint_noncurrent_retention_days`).
- **Artifact S3 bucket** — for the code-artifact zip (optional; reuse an existing
  one with `create_artifact_bucket = false` + `artifact_bucket_name`), with
  lifecycle cleanup after `artifact_retention_days`.
- **Private ECR repository** — for the arm64 runner image (optional; reuse an
  existing repository with `create_ecr_repository = false`), retaining the
  newest `ecr_max_image_count` images.
- **Build role** — assumed by Lambda during `create/update-microvm-image`. Trust
  includes `sts:TagSession`; permissions include writes to the exact build log
  group, `s3:GetObject` on the artifact bucket, and (optional) scoped
  private-ECR pull. Getting this wrong yields a build failure with an empty
  `stateReason`.
- **Execution role** — logging-only least-privilege, for `RunMicrovm`.
- **Worker control policy** — `Run/Get/TerminateMicrovm`,
  `CreateMicrovmAuthToken`, and the dependent `iam:PassRole` /
  `lambda:PassNetworkConnector` permissions required by `RunMicrovm`. The
  ordinary runner policy does not grant `SuspendMicrovm` or `ResumeMicrovm`.
  Set `hosted_app_image_arn` to the dedicated `LAMBDA_MICROVM_APP_IMAGE_ARN`
  when enabling hosted apps. A separate image-scoped statement permits its
  lifecycle operations and `ResumeMicrovm` for same-token suspended-launch recovery.
- **CloudWatch log groups** — build (`/aws/lambda-microvms/<image_name>`) and
  runtime.
- **Checkpoint access** — an IAM policy for task-role/instance-profile/IRSA
  credentials (preferred), or an optional IAM user + access key
  (`create_checkpoint_access_user = true`) for non-role deployments.

## Usage

The example targets disposable AIML-dev and explicitly enables destructive
teardown; change the three `*_force_*` values to `false` before applying it to a
retained environment.

```bash
cp terraform.tfvars.example terraform.tfvars   # edit
terraform init -lockfile=readonly
terraform apply
terraform output
```

## Notes

- Commit `.terraform.lock.hcl` (this module does) and keep
  `terraform init -lockfile=readonly` in automation so an AWS provider release
  cannot silently change a previously reviewed plan.
- Set `image_name` to match the `--name` you pass to `create-microvm-image.ts`,
  so the build log group is pre-created at the exact path Lambda writes to.
- Set `codeapi_worker_role_name` to attach the MicroVM and checkpoint policies
  directly to an existing task role; otherwise attach both output policy ARNs
  in the deployment that owns that role.
- `runner_ecr_repository_url` is the `ECR_URI` consumed by the build script.
- `private_ecr = false` is only for a code-artifact Dockerfile that already
  references a public image. It makes `runner_ecr_repository_url` null; the
  provided build/push helper and hardened runbook use private ECR.
- `create_checkpoint_access_user = true` exposes `checkpoint_access_key_id` and
  the sensitive `checkpoint_secret_access_key` outputs — use as `MINIO_ACCESS_KEY`
  / `MINIO_SECRET_KEY`. The checkpoint client now loads ECS/EC2/IRSA credentials,
  so prefer a role. A `sensitive` output is still stored in plaintext Terraform
  state; use an encrypted, access-controlled remote backend and never copy state
  into logs or artifacts.
- Managed artifacts expire after `artifact_retention_days`; ECR keeps the newest
  `ecr_max_image_count` images. Use a unique `IMAGE_TAG` for every push because
  the ECR repository is immutable, and retain every version needed for rollback.
- `artifact_force_destroy`, `checkpoint_force_destroy`, and `ecr_force_delete`
  default to `false`, so a destroy cannot silently empty buckets or the image
  repository. The checked-in `terraform.tfvars.example` is specifically an
  AIML-dev/disposable-stack example and explicitly opts all three into
  destructive teardown; do not copy those overrides to retained environments.
- Current checkpoint versions expire after `checkpoint_retention_days`; when
  `hosted_app_image_arn` is configured, only `codeapi-retention=rolling` objects expire.
  Noncurrent S3 versions expire independently after
  `checkpoint_noncurrent_retention_days` (one day by default), so bucket
  versioning does not unexpectedly retain replaced checkpoint data for another
  full current-version window.
- Hosted snapshots and immutable revision manifests use `codeapi-retention=hosted`
  and are excluded from automatic current/noncurrent expiry. The checkpoint IAM
  policy grants `s3:PutObjectTagging` for these writes and server-side copies.
  Apply this lifecycle policy before enabling hosted apps. Legacy untagged objects
  no longer expire automatically: tag only verified ordinary rolling checkpoints
  during migration, never hosted snapshots or revision manifests. Runtime rolling
  checkpoint pruning continues to delete superseded ordinary checkpoints.
- Workers tag ordinary checkpoints only when hosted apps are enabled, so the
  disabled/default deployment does not acquire a new tagging-permission requirement.
  Never clear `hosted_app_image_arn` while retained hosted data remains: doing so
  restores the ordinary bucket-wide expiry policy.
