data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  artifact_bucket = var.create_artifact_bucket ? aws_s3_bucket.artifact[0].id : var.artifact_bucket_name
  runner_repository_arn = (
    var.private_ecr && var.create_ecr_repository
    ? aws_ecr_repository.runner[0].arn
    : "arn:${data.aws_partition.current.partition}:ecr:${var.region}:${local.account_id}:repository/${var.ecr_repository_name}"
  )
  runner_repository_url = (
    var.private_ecr
    ? (
      var.create_ecr_repository
      ? aws_ecr_repository.runner[0].repository_url
      : "${local.account_id}.dkr.ecr.${var.region}.${data.aws_partition.current.dns_suffix}/${var.ecr_repository_name}"
    )
    : null
  )
  microvm_image_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${local.account_id}:microvm-image:${var.image_name}"

  base_tags = merge(var.tags, {
    "app"       = "codeapi"
    "component" = "lambda-microvm"
  })
}

# --------------------------------------------------------------------------
# ECR: arm64 runner image consumed by the Lambda MicroVM image builder
# --------------------------------------------------------------------------
resource "aws_ecr_repository" "runner" {
  count                = var.private_ecr && var.create_ecr_repository ? 1 : 0
  name                 = var.ecr_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete
  tags                 = local.base_tags

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "runner" {
  count      = var.private_ecr && var.create_ecr_repository ? 1 : 0
  repository = aws_ecr_repository.runner[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest ${var.ecr_max_image_count} runner images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_max_image_count
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# --------------------------------------------------------------------------
# S3: code-artifact bucket (the zip that create-microvm-image reads)
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "artifact" {
  count = var.create_artifact_bucket ? 1 : 0
  # Region in the name: S3 bucket names are globally unique, so applying this
  # module in a second region with the same name_prefix would otherwise collide.
  bucket        = "${var.name_prefix}-artifacts-${var.region}-${local.account_id}"
  force_destroy = var.artifact_force_destroy
  tags          = local.base_tags
}

resource "aws_s3_bucket_public_access_block" "artifact" {
  count                   = var.create_artifact_bucket ? 1 : 0
  bucket                  = aws_s3_bucket.artifact[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifact" {
  count  = var.create_artifact_bucket ? 1 : 0
  bucket = aws_s3_bucket.artifact[0].id
  rule {
    # SSE-S3 (not SSE-KMS): the Lambda build role reads the artifact with only
    # s3:GetObject, so a KMS-encrypted bucket would AccessDenied without a
    # kms:Decrypt grant. Artifacts are non-sensitive (the runner image zip);
    # upgrade to aws:kms + a kms:Decrypt statement on the build role if you need
    # a customer-managed key.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifact" {
  count  = var.create_artifact_bucket ? 1 : 0
  bucket = aws_s3_bucket.artifact[0].id
  rule {
    id     = "expire-build-artifacts"
    status = "Enabled"
    filter {}
    expiration {
      days = var.artifact_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --------------------------------------------------------------------------
# S3: session-workspace checkpoint bucket
# The CodeAPI control plane (not the MicroVM) reads/writes these. Encrypted,
# versioned for forensic history, and lifecycle-expired since checkpoints are a
# resumable cache rather than a system of record.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "checkpoint" {
  bucket        = "${var.name_prefix}-checkpoints-${var.region}-${local.account_id}"
  force_destroy = var.checkpoint_force_destroy
  tags          = local.base_tags
}

resource "aws_s3_bucket_public_access_block" "checkpoint" {
  bucket                  = aws_s3_bucket.checkpoint.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  rule {
    # SSE-S3 so the checkpoint access policy needs no kms:Decrypt /
    # kms:GenerateDataKey grant (the MinIO-compatible client reads/writes with
    # plain S3 perms). Still encrypted at rest with AWS-managed keys; switch to
    # aws:kms + KMS grants on checkpoint_access if you require a CMK.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  depends_on = [
    aws_s3_bucket_versioning.checkpoint,
  ]
  rule {
    id     = "expire-checkpoints"
    status = "Enabled"
    filter {
      tag {
        key   = "codeapi-retention"
        value = "rolling"
      }
    }
    expiration {
      days = var.checkpoint_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.checkpoint_noncurrent_retention_days
    }
  }
  rule {
    id     = "abort-incomplete-checkpoints"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --------------------------------------------------------------------------
# CloudWatch Logs
# Build logs land at the EXACT path `/aws/lambda-microvms/<image-name>` (hyphen).
# DO NOT "correct" this to the AWS docs' `/aws/lambda/microvms/...` (slash) — the
# docs are wrong. Verified empirically against a live account: every build's log
# group is the hyphen form and the slash path does not exist. Switching to it
# would stop matching the group the builder writes to and lose the build logs
# (which then surface as a `CREATE_FAILED` with an empty `stateReason` —
# undebuggable). Pre-creating it sets retention; Lambda also auto-creates it if
# absent. Runtime VM stdout needs BOTH a cloudWatch logging config on RunMicrovm
# AND an execution role, or it goes nowhere.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/lambda-microvms/${var.image_name}"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/${var.name_prefix}/runtime"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

# --------------------------------------------------------------------------
# IAM: build role (assumed by Lambda during create/update-microvm-image)
# Trust MUST include sts:TagSession, and perms MUST include writes to the exact
# pre-created build log group plus s3:GetObject or the build FAILS with an empty
# stateReason (undebuggable).
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "build_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "build" {
  name               = "${var.name_prefix}-build"
  assume_role_policy = data.aws_iam_policy_document.build_trust.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "build_perms" {
  statement {
    sid       = "ArtifactRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.artifact_bucket}/*"]
  }

  statement {
    sid     = "BuildLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    # The group is pre-created above. Stream actions need the `:*` suffix; `/*`
    # does not match log-stream ARNs.
    resources = ["${aws_cloudwatch_log_group.build.arn}:*"]
  }

  dynamic "statement" {
    for_each = var.private_ecr ? [1] : []
    content {
      sid       = "PrivateEcrAuth"
      effect    = "Allow"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.private_ecr ? [1] : []
    content {
      sid    = "PrivateEcrRepositoryPull"
      effect = "Allow"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ]
      resources = [local.runner_repository_arn]
    }
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "build"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build_perms.json
}

# --------------------------------------------------------------------------
# IAM: execution role (RunMicrovm executionRoleArn) — logging-only.
# The MicroVM never needs S3/network creds: checkpoints flow through the control
# plane over the authed proxy, so keep this role least-privilege.
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "exec_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-exec"
  assume_role_policy = data.aws_iam_policy_document.exec_trust.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "exec_perms" {
  statement {
    sid     = "RuntimeLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    # The group is Terraform-managed; the runtime may write only its streams.
    resources = ["${aws_cloudwatch_log_group.runtime.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "runtime-logs"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.exec_perms.json
}

# --------------------------------------------------------------------------
# IAM: CodeAPI worker caller policy
# RunMicrovm has two dependent permissions that are easy to miss:
# iam:PassRole for the runtime execution role and lambda:PassNetworkConnector
# for every ingress/egress connector supplied on the request.
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "worker_microvm_control" {
  dynamic "statement" {
    for_each = var.hosted_app_image_arn == "" ? [] : [var.hosted_app_image_arn]
    content {
      sid    = "OperateHostedAppMicrovms"
      effect = "Allow"
      actions = [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:TerminateMicrovm",
        "lambda:ResumeMicrovm",
      ]
      resources = [statement.value]
    }
  }
  statement {
    sid    = "OperateCodeapiMicrovms"
    effect = "Allow"
    actions = [
      "lambda:RunMicrovm",
      "lambda:GetMicrovm",
      "lambda:CreateMicrovmAuthToken",
      "lambda:TerminateMicrovm",
    ]
    resources = [local.microvm_image_arn]
  }

  statement {
    sid       = "PassMicrovmExecutionRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid     = "PassMicrovmNetworkConnectors"
    effect  = "Allow"
    actions = ["lambda:PassNetworkConnector"]
    # This permission-only action currently exposes no resource type.
    resources = ["*"]
  }
}

resource "aws_iam_policy" "worker_microvm_control" {
  name   = "${var.name_prefix}-worker-microvm-control"
  policy = data.aws_iam_policy_document.worker_microvm_control.json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "worker_microvm_control" {
  count      = var.codeapi_worker_role_name == "" ? 0 : 1
  role       = var.codeapi_worker_role_name
  policy_arn = aws_iam_policy.worker_microvm_control.arn
}

# --------------------------------------------------------------------------
# IAM policy document for the CodeAPI control plane's checkpoint access.
# Attach to your CodeAPI task role (preferred) or the optional user below.
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "checkpoint_access" {
  statement {
    sid       = "CheckpointObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.checkpoint.arn}/*"]
  }
  statement {
    sid       = "CheckpointList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.checkpoint.arn]
  }
}

resource "aws_iam_policy" "checkpoint_access" {
  name   = "${var.name_prefix}-checkpoint-access"
  policy = data.aws_iam_policy_document.checkpoint_access.json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "worker_checkpoint_access" {
  count      = var.codeapi_worker_role_name == "" ? 0 : 1
  role       = var.codeapi_worker_role_name
  policy_arn = aws_iam_policy.checkpoint_access.arn
}

resource "aws_iam_user" "checkpoint" {
  count = var.create_checkpoint_access_user ? 1 : 0
  name  = "${var.name_prefix}-checkpoint"
  tags  = local.base_tags
}

resource "aws_iam_user_policy_attachment" "checkpoint" {
  count      = var.create_checkpoint_access_user ? 1 : 0
  user       = aws_iam_user.checkpoint[0].name
  policy_arn = aws_iam_policy.checkpoint_access.arn
}

resource "aws_iam_access_key" "checkpoint" {
  count = var.create_checkpoint_access_user ? 1 : 0
  user  = aws_iam_user.checkpoint[0].name
}
