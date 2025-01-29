variable "environment" {
  description = "Environment name"
  type        = string
}

variable "stage" {
  description = "Stage name"
  type        = string
}

variable "container_family" {
  description = "Name of the lambda function family"
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the Lambda execution role"
  type        = string
}

variable "memory_size" {
  description = "Amount of memory in MB for the function"
  type        = number
  default     = 1024
}

variable "timeout" {
  description = "Timeout for the function in seconds"
  type        = number
  default     = 900
}

variable "schedule_expression" {
  description = "CloudWatch Events schedule expression"
  type        = string
  default     = "rate(5 minutes)"
}

variable "subnet_ids" {
  description = "List of subnet IDs for the Lambda function"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID for the Lambda function"
  type        = string
}

variable "container_env_vars" {
  description = "Environment variables for the Lambda function"
  type        = map(string)
  default     = {}
}

variable "image_uri" {
  description = "Full URI of the container image"
  type        = string
}