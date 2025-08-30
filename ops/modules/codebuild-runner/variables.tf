variable "project_name" {
  description = "Name of the CodeBuild project"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g., staging, production)"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository URL"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where CodeBuild will run"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for CodeBuild"
  type        = list(string)
}

variable "rds_security_group_id" {
  description = "Security group ID of the RDS instance"
  type        = string
}

variable "rds_port" {
  description = "Port number for RDS"
  type        = number
  default     = 5432
}

variable "runner_label" {
  description = "Label for the GitHub Actions runner"
  type        = string
}

variable "database_url" {
  description = "PostgreSQL connection URL for database migrations"
  type        = string
  sensitive   = true
}

variable "compute_type" {
  description = "CodeBuild compute type"
  type        = string
  default     = "BUILD_GENERAL1_SMALL"
}

variable "build_image" {
  description = "Docker image for CodeBuild environment"
  type        = string
  default     = "aws/codebuild/standard:7.0"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}