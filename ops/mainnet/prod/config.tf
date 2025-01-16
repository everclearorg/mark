locals {
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