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

variable "region" {
  description = "AWS region"
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the ECS execution role"
  type        = string
}

variable "cluster_id" {
  description = "ID of the ECS cluster"
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC"
  type        = string
}

variable "lb_subnets" {
  description = "Subnets for the load balancer"
  type        = list(string)
}

variable "docker_image" {
  description = "Docker image to deploy"
  type        = string
}

variable "container_family" {
  description = "Family name for the container"
  type        = string
}

variable "container_port" {
  description = "Port exposed by the container"
  type        = number
  default     = 9000
}

variable "cpu" {
  description = "CPU units for the task"
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory for the task in MB"
  type        = number
  default     = 512
}

variable "instance_count" {
  description = "Number of instances to run"
  type        = number
  default     = 1
}

variable "service_security_groups" {
  description = "Security groups for the service"
  type        = list(string)
}

variable "container_env_vars" {
  description = "Environment variables for the container"
  type        = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "health_check_path" {
  description = "Path for health check endpoint"
  type        = string
  default     = "/"
}

variable "dd_api_key" {
  description = "DataDog API Key"
}