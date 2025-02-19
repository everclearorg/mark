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
  type        = string
  sensitive   = true
}

variable "create_alb" {
  description = "Whether to create an ALB for this service"
  type        = bool
  default     = false
}

variable "cert_arn" {
  description = "ACM certificate ARN"
  type        = string
  default     = ""
}

variable "internal_lb" {
  description = "Whether the ALB is internal"
  type        = bool
  default     = false
}

variable "loadbalancer_port" {
  description = "Port for the load balancer"
  type        = number
  default     = 80
}

variable "timeout" {
  description = "ALB timeout"
  type        = number
  default     = 60
}

variable "ingress_cdir_blocks" {
  description = "CIDR blocks for ALB ingress"
  type        = list(string)
  default     = []
}

variable "ingress_ipv6_cdir_blocks" {
  description = "IPv6 CIDR blocks for ALB ingress"
  type        = list(string)
  default     = []
}

variable "allow_all_cdir_blocks" {
  default = ["0.0.0.0/0"]
}

variable "zone_id" {
  description = "Route 53 hosted zone ID"
  type = string
}

variable "health_check_settings" {
  description = "Custom health check settings for the target group"
  type = object({
    path                = string
    matcher             = string
    interval            = number
    timeout             = number
    healthy_threshold   = number
    unhealthy_threshold = number
  })
  default = {
    path                = "/"
    matcher             = "200,302"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

variable "command" {
  description = "Command to run in the container"
  type        = list(string)
  default     = null
}

variable "task_subnets" {
  description = "Subnets for the ECS tasks"
  type        = list(string)
}