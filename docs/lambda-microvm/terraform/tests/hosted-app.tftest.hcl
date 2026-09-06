mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
}

variables {
  region               = "us-east-2"
  name_prefix          = "hosted-test"
  image_name           = "runner"
  hosted_app_image_arn = "arn:aws:lambda:us-east-2:123456789012:microvm-image:app-host"
}

run "hosted_permissions_and_retention" {
  command = plan

  assert {
    condition = contains(one([
      for statement in data.aws_iam_policy_document.worker_microvm_control.statement : statement
      if statement.sid == "OperateHostedAppMicrovms"
    ]).actions, "lambda:ResumeMicrovm")
    error_message = "Hosted suspended-launch recovery requires ResumeMicrovm."
  }
  assert {
    condition = toset(one([
      for statement in data.aws_iam_policy_document.worker_microvm_control.statement : statement
      if statement.sid == "OperateHostedAppMicrovms"
    ]).resources) == toset([var.hosted_app_image_arn])
    error_message = "Hosted control permissions must be scoped to the dedicated image."
  }
  assert {
    condition = contains(one([
      for statement in data.aws_iam_policy_document.checkpoint_access.statement : statement
      if statement.sid == "CheckpointObjects"
    ]).actions, "s3:PutObjectTagging")
    error_message = "Checkpoint writes and retained copies require tagging permission."
  }
  assert {
    condition = one(one(one([
      for rule in aws_s3_bucket_lifecycle_configuration.checkpoint.rule : rule
      if rule.id == "expire-checkpoints"
    ]).filter).tag).value == "rolling"
    error_message = "Only tagged rolling checkpoints may expire, never hosted snapshots/manifests."
  }
  assert {
    condition = one(one(one([
      for rule in aws_s3_bucket_lifecycle_configuration.checkpoint.rule : rule
      if rule.id == "expire-checkpoints"
    ]).filter).tag).key == "codeapi-retention"
    error_message = "The expiry filter must use the runtime retention tag."
  }
}

run "ordinary_runner_has_no_hosted_permissions" {
  command = plan
  variables { hosted_app_image_arn = "" }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.worker_microvm_control.statement :
      !contains(statement.actions, "lambda:ResumeMicrovm")
    ])
    error_message = "Hosted resume permission must remain opt-in."
  }
  assert {
    condition = length(one(one([
      for rule in aws_s3_bucket_lifecycle_configuration.checkpoint.rule : rule
      if rule.id == "expire-checkpoints"
    ]).filter).tag) == 0
    error_message = "Ordinary deployments retain their existing untagged checkpoint expiry policy."
  }
}
