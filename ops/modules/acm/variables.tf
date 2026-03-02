variable "bot_name" {
  description = "Bot name for domain generation (e.g. mark, mason, mandy, matoshi)"
  type        = string
}

variable "domain" {
  description = "Base domain name (e.g. everclear.ninja)"
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone ID for DNS validation"
  type        = string
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "stage" {
  description = "Stage name"
  type        = string
}
