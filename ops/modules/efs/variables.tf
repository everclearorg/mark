variable "environment" {
  description = "Environment name"
  type = string
}

variable "stage" {
  description = "Stage name"
  type = string
}

variable "domain" {
  description = "Domain name"
  type = string
}

variable "subnet_ids" {
  description = "List of subnet IDs where EFS mount targets should be created"
  type        = list(string)
}

variable "efs_security_group_id" {
  description = "Security group ID for EFS mount targets"
  type        = string
}