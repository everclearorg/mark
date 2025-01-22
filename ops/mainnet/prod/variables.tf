variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "mainnet"
}

variable "stage" {
  description = "Stage name"
  type        = string
  default     = "prod"
}

variable "domain" {
  description = "Domain name"
  type        = string
  default     = "mark"
}

variable "cidr_block" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "web3_signer_private_key" {
  description = "Private key for web3signer"
  type        = string
  sensitive   = true
}

variable "image_uri" {
  description = "Full image name for the poller container (from CI pipeline)"
  type        = string
}