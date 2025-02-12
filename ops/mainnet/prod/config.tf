locals {
  poller_env_vars = {
    INVOICE_AGE                   = var.invoice_age
    SIGNER_URL                    = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS                = var.signer_address
    REDIS_HOST                    = module.cache.redis_instance_address
    REDIS_PORT                    = module.cache.redis_instance_port
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
    CHAIN_1_ASSETS                = "WETH,0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,18,0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8,FALSE,800000000000000000;USDC,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,6,0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa,FALSE,4000000000;USDT,0xdAC17F958D2ee523a2206206994597C13D831ec7,6,0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0,FALSE,2000000000"
    
    CHAIN_10_PROVIDERS            = "https://optimism-mainnet.blastapi.io/${var.blast_key}, https://opt-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_10_ASSETS               = "WETH,0x4200000000000000000000000000000000000006,18,0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8,FALSE,1600000000000000000;USDC,0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85,6,0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa,FALSE,4000000000;USDT,0x94b008aA00579c1307B0EF2c499aD98a8ce58e58,6,0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0,FALSE,400000000"
    
    CHAIN_56_PROVIDERS            = "https://bsc-mainnet.blastapi.io/${var.blast_key}, https://bnb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_56_ASSETS               = "WETH,0x2170Ed0880ac9A755fd29B2688956BD959F933F8,18,0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8,FALSE,0;USDC,0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d,18,0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa,FALSE,2000000000000000000000;USDT,0x55d398326f99059fF775485246999027B3197955,18,0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0,FALSE,4000000000000000000000"
    
    CHAIN_137_PROVIDERS           = "https://polygon-mainnet.blastapi.io/${var.blast_key}, https://polygon-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_8453_PROVIDERS          = "https://base-mainnet.blastapi.io/${var.blast_key}, https://base-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_8453_ASSETS             = "WETH,0x4200000000000000000000000000000000000006,18,0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8,FALSE,1600000000000000000;USDC,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,6,0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa,FALSE,4000000000;USDT,0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2,6,0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0,FALSE,0"
    
    CHAIN_33139_PROVIDERS         = "https://apechain-mainnet.blastapi.io/${var.blast_key}, https://apechain-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_42161_PROVIDERS         = "https://arbitrum-one.blastapi.io/${var.blast_key}, https://arb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    CHAIN_42161_ASSETS            = "WETH,0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,18,0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8,FALSE,1600000000000000000;USDC,0xaf88d065e77c8cC2239327C5EDb3A432268e5831,6,0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa,FALSE,4000000000;USDT,0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9,6,0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0,FALSE,1000000000"
    
    CHAIN_43114_PROVIDERS         = "https://ava-mainnet.blastapi.io/${var.blast_key}/ext/bc/C/rpc, https://avalanche-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_48900_PROVIDERS         = "https://zircuit1-mainnet.p2pify.com, https://lb.drpc.org/ogrpc?network=zircuit-mainnet&dkey=${var.drpc_key}"

    CHAIN_59144_PROVIDERS         = "https://linea-mainnet.blastapi.io/${var.blast_key}, https://linea-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_81457_PROVIDERS         = "https://lb.drpc.org/ogrpc?network=blast&dkey=${var.drpc_key}, https://blastl2-mainnet.public.blastapi.io"

    CHAIN_167000_PROVIDERS        = "https://lb.drpc.org/ogrpc?network=taiko&dkey=${var.drpc_key}"

    CHAIN_534352_PROVIDERS        = "https://scroll-mainnet.blastapi.io/${var.blast_key}, https://scroll-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
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
