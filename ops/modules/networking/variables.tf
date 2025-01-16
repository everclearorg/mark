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

variable "cidr_block" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}