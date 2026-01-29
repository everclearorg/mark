variable "gcp_project_id" {
  description = "GCP project ID for storing Shamir Share 2 secrets"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g., mainnet, testnet)"
  type        = string
}

variable "stage" {
  description = "Deployment stage (e.g., production, staging)"
  type        = string
  default     = "production"
}

variable "service_name" {
  description = "Name of the service (e.g., mark, mandy)"
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID for Workload Identity Federation"
  type        = string
}

variable "aws_role_name" {
  description = "AWS IAM role name that will access GCP secrets"
  type        = string
  default     = "ecs-task-role"
}

variable "secrets" {
  description = "Map of secret configurations. Key is the secret suffix, value is the config."
  type = map(object({
    description = optional(string, "Shamir Share 2 for key sharding")
    labels      = optional(map(string), {})
  }))
  default = {}
}

variable "gcp_region" {
  description = "GCP region for resources"
  type        = string
  default     = "us-central1"
}
