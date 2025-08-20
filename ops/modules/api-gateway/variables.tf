variable "environment" {
  description = "Environment name"
  type        = string
}

variable "stage" {
  description = "Stage name"
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
  default     = 300
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

variable "domain" {
  description = "Base domain name for the custom domain"
  type        = string
}

variable "certificate_arn" {
  description = "ARN of the ACM certificate for the custom domain"
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone ID for DNS record creation"
  type        = string
}

variable "bot_name" {
  description = "Bot name for API gateway domain naming"
  type        = string
} 