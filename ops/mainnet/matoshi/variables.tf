variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-1"
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
  default     = "matoshi"
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
  default     = "https://api.everclear.org"
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
  default     = "1,42161,10,8453,56,130,137,43114,48900,59144,81457,167000,534352,34443,324,33139,2020,80094,100,5000,146,57073,1399811149,728126428"
}

variable "supported_asset_symbols" {
  description = "Comma-separated list of supported asset symbols"
  type        = string
  default     = "WETH,USDC,USDT"
}

variable "log_level" {
  description = "Log level (debug, info, warn, error)"
  type        = string
  default     = "debug"
}

variable "chain_ids" {
  description = "Comma-separated list of chain IDs"
  type        = string
  default     = "1,42161,10,8453,56,130,137,43114,48900,59144,81457,167000,534352,34443,324,33139,2020,80094,100,5000,146,57073,1399811149,728126428"
}
variable "zone_id" {
  description = "Route 53 hosted zone ID for the everclear.ninja domain"
  default     = "Z0605920184MNEP9DVKIX"
}

variable "cert_arn" {
  description = "ACM certificate"
  default = "arn:aws:acm:ap-southeast-1:679752396206:certificate/329da04b-3b01-49a4-b8ef-1733ec264abb"
}

variable "admin_image_uri" {
  description = "The ECR image URI for the admin API Lambda function."
  type        = string
}
