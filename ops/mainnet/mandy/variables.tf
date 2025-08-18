variable "region" {
  description = "AWS region"
  type        = string
  default     = "eu-south-2"
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

variable "bot_name" {
  description = "Bot name for API gateway and other resource naming"
  type        = string
  default     = "mandy"
}

variable "domain" {
  description = "Domain name"
  type        = string
  default     = "everclear.ninja"
}

variable "cidr_block" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "image_uri" {
  description = "Full image name for the poller container (from CI pipeline)"
  type        = string
}

# Poller-specific variables
variable "invoice_age" {
  description = "Maximum age of invoices to process (in seconds)"
  type        = string
  default     = "600"
}

variable "everclear_api_url" {
  description = "URL of the Everclear API"
  type        = string
  default     = "https://api.staging.everclear.org"
}

variable "relayer_url" {
  description = "Optional relayer URL"
  type        = string
  default     = ""
}

variable "relayer_api_key" {
  description = "Optional relayer API key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "supported_settlement_domains" {
  description = "Comma-separated list of supported settlement domains"
  type        = string
  default     = "1,42161,10,8453,56,130,137,43114,48900,59144,81457,167000,534352,34443,324,33139,2020,80094,100,5000,146,57073,1399811149"
}

variable "supported_asset_symbols" {
  description = "Comma-separated list of supported asset symbols"
  type        = string
  default     = "USDC,USDT"
}

variable "log_level" {
  description = "Log level (debug, info, warn, error)"
  type        = string
  default     = "debug"
}

variable "chain_ids" {
  description = "Comma-separated list of chain IDs"
  type        = string
  default     = "1,42161,10,8453,56,130,137,43114,48900,59144,81457,167000,534352,34443,324,33139,2020,80094,100,5000,146,57073,1399811149"
}
variable "zone_id" {
  description = "Route 53 hosted zone ID for the everclear.ninja domain"
  default     = "Z0605920184MNEP9DVKIX"
}

variable "cert_arn" {
  description = "ACM certificate"
  default = "arn:aws:acm:eu-south-2:679752396206:certificate/c017b2d9-1dee-4a39-8b12-605fd18fe211"
}

variable "admin_image_uri" {
  description = "The ECR image URI for the admin API Lambda function."
  type        = string
}
