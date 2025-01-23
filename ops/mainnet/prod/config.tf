locals {
  poller_env_vars = {
    INVOICE_AGE                  = var.invoice_age
    SIGNER_URL                   = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS              = var.signer_address
    EVERCLEAR_API_URL           = var.everclear_api_url
    RELAYER_URL                 = var.relayer_url
    RELAYER_API_KEY             = var.relayer_api_key
    SUPPORTED_SETTLEMENT_DOMAINS = var.supported_settlement_domains
    SUPPORTED_ASSETS            = var.supported_assets
    LOG_LEVEL                   = var.log_level
    ENVIRONMENT                 = var.environment
    STAGE                       = var.stage
    CHAIN_IDS                   = var.chain_ids
  }

  web3signer_env_vars = [
    {
      name  = "WEB3_SIGNER_PRIVATE_KEY"
      value = var.web3_signer_private_key
    },
    {
      name  = "WEB3SIGNER_HTTP_HOST_ALLOWLIST"
      value = "*"
    },
    {
      name  = "ENVIRONMENT"
      value = var.environment
    },
    {
      name  = "STAGE"
      value = var.stage
    }
  ]
}