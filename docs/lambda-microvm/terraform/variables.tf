variable "region" {
  description = "AWS region to provision into. Lambda MicroVMs must be available here."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for all created resource names (roles, buckets, log groups)."
  type        = string
  default     = "codeapi-microvm"
}

variable "hosted_app_image_arn" {
  description = "Optional dedicated app-host image ARN; grants hosted lifecycle and suspended-launch recovery permissions only on this image."
  type        = string
  default     = ""
  validation {
    condition     = var.hosted_app_image_arn == "" || can(regex("^arn:[a-z0-9-]+:lambda:[a-z0-9-]+:[0-9]{12}:microvm-image:[A-Za-z0-9_-]+$", var.hosted_app_image_arn))
    error_message = "hosted_app_image_arn must be empty or an exact MicroVM image ARN without wildcards."
  }
}

variable "image_name" {
  description = <<-EOT
    Name of the MicroVM image you will create with the SDK/CLI helper. Only used
    to pre-create the build log group at the exact path Lambda writes to
    (`/aws/lambda-microvms/<image_name>`). Must match the `--name` you pass to
    create-microvm-image.
  EOT
  type        = string
  default     = "codeapi-session"
}

variable "create_artifact_bucket" {
  description = <<-EOT
    Create an S3 bucket to hold the code-artifact zip that
    `scripts/build-lambda-microvm-artifact.sh` uploads. Set false to reuse an
    existing bucket via `artifact_bucket_name`.
  EOT
  type        = bool
  default     = true
}

variable "artifact_bucket_name" {
  description = "Existing artifact bucket name when create_artifact_bucket = false."
  type        = string
  default     = ""

  # Reject an empty name when reusing an existing bucket, else the build-role
  # policy resolves to `arn:aws:s3:::/*` and the build can't read the artifact.
  validation {
    condition     = var.create_artifact_bucket || length(var.artifact_bucket_name) > 0
    error_message = "artifact_bucket_name must be set when create_artifact_bucket is false."
  }
}

variable "artifact_retention_days" {
  description = "Days to retain uploaded MicroVM build artifacts in the managed artifact bucket."
  type        = number
  default     = 30

  validation {
    condition     = var.artifact_retention_days > 0 && floor(var.artifact_retention_days) == var.artifact_retention_days
    error_message = "artifact_retention_days must be a positive whole number."
  }
}

variable "artifact_force_destroy" {
  description = "Allow terraform destroy to remove a non-empty managed artifact bucket. Opt in only for disposable dev stacks."
  type        = bool
  default     = false
}

variable "checkpoint_retention_days" {
  description = <<-EOT
    Days to keep session-workspace checkpoints in the checkpoint bucket before
    lifecycle expiration. Checkpoints are a resumable cache, not a system of
    record, so a short window is fine.
  EOT
  type        = number
  default     = 14

  validation {
    condition     = var.checkpoint_retention_days > 0 && floor(var.checkpoint_retention_days) == var.checkpoint_retention_days
    error_message = "checkpoint_retention_days must be a positive whole number."
  }
}

variable "checkpoint_noncurrent_retention_days" {
  description = <<-EOT
    Days to keep a noncurrent checkpoint object version after S3 replaces or
    expires its current version. This is separate from
    checkpoint_retention_days so bucket versioning does not silently double the
    intended resumable-cache retention window.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.checkpoint_noncurrent_retention_days > 0 && floor(var.checkpoint_noncurrent_retention_days) == var.checkpoint_noncurrent_retention_days
    error_message = "checkpoint_noncurrent_retention_days must be a positive whole number."
  }
}

variable "checkpoint_force_destroy" {
  description = "Allow terraform destroy to remove a non-empty checkpoint bucket. Opt in only for disposable dev stacks."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the build + runtime log groups."
  type        = number
  default     = 30
}

variable "private_ecr" {
  description = <<-EOT
    Grant the build role permission to pull the runner container image from a
    private ECR repo in this account. Required when the code-artifact Dockerfile
    uses `FROM <acct>.dkr.ecr...`. Leave false for public base images.
  EOT
  type        = bool
  default     = true
}

variable "create_ecr_repository" {
  description = "Create the private ECR repository used by the runner image build."
  type        = bool
  default     = true
}

variable "ecr_repository_name" {
  description = "Private ECR repository containing the arm64 CodeAPI runner image."
  type        = string
  default     = "codeapi-microvm-runner"
}

variable "ecr_force_delete" {
  description = "Allow terraform destroy to remove a non-empty runner ECR repository. Opt in only for disposable dev stacks."
  type        = bool
  default     = false
}

variable "ecr_max_image_count" {
  description = "Maximum number of runner images retained by the managed ECR repository."
  type        = number
  default     = 30

  validation {
    condition     = var.ecr_max_image_count > 0 && floor(var.ecr_max_image_count) == var.ecr_max_image_count
    error_message = "ecr_max_image_count must be a positive whole number."
  }
}

variable "codeapi_worker_role_name" {
  description = <<-EOT
    Existing CodeAPI worker/task IAM role name. When set, Terraform attaches
    both the MicroVM control-plane policy and checkpoint S3 policy. Leave empty
    to consume the two policy ARN outputs in your deployment stack.
  EOT
  type        = string
  default     = ""
}

variable "create_checkpoint_access_user" {
  description = <<-EOT
    Create an IAM user + access key with read/write on the checkpoint bucket, for
    the CodeAPI service's MinIO-compatible checkpoint client (MINIO_ACCESS_KEY /
    MINIO_SECRET_KEY). Prefer an ECS task role, EC2 instance profile, or IRSA;
    create static credentials only for a deployment that cannot use a role.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every created resource."
  type        = map(string)
  default     = {}
}
