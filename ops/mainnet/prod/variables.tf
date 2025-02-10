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

variable "image_uri" {
  description = "Full image name for the poller container (from CI pipeline)"
  type        = string
}

variable "web3_signer_private_key" {
  description = "Private key for web3signer"
  type        = string
  sensitive   = true
}

# Poller-specific variables
variable "invoice_age" {
  description = "Maximum age of invoices to process (in seconds)"
  type        = string
  default     = "600"
}

variable "signer_address" {
  description = "Ethereum address of the signer"
  type        = string
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
  default     = "1,10,56,8453,42161,48900,59144,137,43114,81457"
}

variable "supported_assets" {
  description = "Comma-separated list of supported assets"
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
  default     = "1,10,56,8453,42161,48900,59144,137,43114,81457"
}

variable "dd_api_key" {
  description = "Datadog API KEY"
  type      = string
  sensitive = true
}

variable "blast_key" {
  description = "Blast API KEY"
  type      = string
  sensitive = true
}

variable "drpc_key" {
  description = "DRPC API KEY"
  type      = string
  sensitive = true
}

variable "alchemy_key" {
  description = "Alchemy API KEY"
  type      = string
  sensitive = true
}
