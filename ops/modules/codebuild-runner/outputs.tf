output "project_name" {
  description = "Name of the CodeBuild project"
  value       = aws_codebuild_project.github_runner.name
}

output "project_arn" {
  description = "ARN of the CodeBuild project"
  value       = aws_codebuild_project.github_runner.arn
}

output "webhook_url" {
  description = "Webhook URL for GitHub"
  value       = aws_codebuild_webhook.github_runner.payload_url
  sensitive   = true
}

output "runner_label" {
  description = "Label to use in GitHub Actions workflow"
  value       = var.runner_label
}

output "security_group_id" {
  description = "Security group ID for the CodeBuild project"
  value       = aws_security_group.codebuild.id
}