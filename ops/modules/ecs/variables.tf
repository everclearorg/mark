variable "environment" {
  description = "Environment name"
  type        = string
}

variable "stage" {
  description = "Stage name"
  type        = string
}

variable "domain" {
  description = "Domain name"
  type        = string
}

variable "ecs_cluster_name_prefix" {
  description = "Prefix for the ECS cluster name"
  type        = string
  default     = "mark"
}