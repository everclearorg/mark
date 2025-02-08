locals {
  poller_env_vars = {
    INVOICE_AGE                   = var.invoice_age
    SIGNER_URL                    = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS                = var.signer_address
    EVERCLEAR_API_URL             = var.everclear_api_url
    RELAYER_URL                   = var.relayer_url
    RELAYER_API_KEY               = var.relayer_api_key
    SUPPORTED_SETTLEMENT_DOMAINS  = var.supported_settlement_domains
    SUPPORTED_ASSETS              = var.supported_assets
    LOG_LEVEL                     = var.log_level
    ENVIRONMENT                   = var.environment
    STAGE                         = var.stage
    CHAIN_IDS                     = var.chain_ids
    DD_LOGS_ENABLED               = true
    DD_ENV                        = "${var.environment}-${var.stage}"
    DD_API_KEY                    = var.dd_api_key
    DD_LAMBDA_HANDLER             = "packages/poller/dist/index.handler"
    CHAIN_1_PROVIDERS             = "https://eth-mainnet.blastapi.io/${var.blast_key}, https://eth-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_10_PROVIDERS            = "https://optimism-mainnet.blastapi.io/${var.blast_key}, https://opt-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_56_PROVIDERS            = "https://bsc-mainnet.blastapi.io/${var.blast_key}, https://bnb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_8453_PROVIDERS          = "https://base-mainnet.blastapi.io/${var.blast_key}, https://base-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_42161_PROVIDERS         = "https://arbitrum-one.blastapi.io/${var.blast_key}, https://arb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_48900_PROVIDERS         = "https://zircuit1-mainnet.p2pify.com, https://lb.drpc.org/ogrpc?network=zircuit-mainnet&dkey=${var.drpc_key}"
    CHAIN_59144_PROVIDERS         = "https://linea-mainnet.blastapi.io/${var.blast_key}, https://linea-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_137_PROVIDERS           = "https://polygon-mainnet.blastapi.io/${var.blast_key}, https://polygon-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_43114_PROVIDERS         = "https://ava-mainnet.blastapi.io/${var.blast_key}/ext/bc/C/rpc, https://avalanche-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_81457_PROVIDERS         = "https://lb.drpc.org/ogrpc?network=blast&dkey=${var.drpc_key}, https://blastl2-mainnet.public.blastapi.io"
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
