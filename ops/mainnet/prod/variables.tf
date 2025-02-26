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
  default     = "42161,1,10,8453,56,137,43114,130,48900,59144,81457,167000,534352,34443,324,130,33139"
}

variable "supported_asset_symbols" {
  description = "Comma-separated list of supported asset symbols"
  type        = string
  default     = "USDC,USDT,WETH"
}

variable "log_level" {
  description = "Log level (debug, info, warn, error)"
  type        = string
  default     = "debug"
}

variable "chain_ids" {
  description = "Comma-separated list of chain IDs"
  type        = string
  default     = "42161,1,10,8453,56,137,43114,130,48900,59144,81457,167000,534352,34443,324,130,33139"
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


variable "zone_id" {
  description = "Route 53 hosted zone ID for the everclear.ninja domain"
  default     = "Z0605920184MNEP9DVKIX"
}

variable "cert_arn" {
  description = "ACM certificate"
  default = "arn:aws:acm:ap-northeast-1:679752396206:certificate/0c43e36e-702c-4623-94d1-4d2a1cdfa302"
}