locals {
  prometheus_config = <<-EOT
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'prometheus'
        static_configs:
          - targets: ['localhost:9090']

      - job_name: 'pushgateway'
        honor_labels: true
        static_configs:
          - targets: ['mark-pushgateway-${var.environment}-${var.stage}.mark.internal:9091']

      - job_name: 'mark-poller'
        honor_labels: true
        metrics_path: /metrics
        static_configs:
          - targets: ['mark-pushgateway-${var.environment}-${var.stage}.mark.internal:9091']
    EOT

  prometheus_env_vars = [
    {
      name  = "PROMETHEUS_CONFIG"
      value = local.prometheus_config
    },
    {
      name  = "ENVIRONMENT"
      value = var.environment
    },
    {
      name  = "STAGE"
      value = var.stage
    },
    {
      name  = "PROMETHEUS_STORAGE_PATH"
      value = "/prometheus"
    },
    {
      name  = "PROMETHEUS_LOG_LEVEL"
      value = "debug"
    }
  ]

  pushgateway_env_vars = [
    {
      name  = "ENVIRONMENT"
      value = var.environment
    },
    {
      name  = "STAGE"
      value = var.stage
    }
  ]

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
    SUPPORTED_ASSET_SYMBOLS       = var.supported_asset_symbols
    LOG_LEVEL                     = var.log_level
    ENVIRONMENT                   = var.environment
    STAGE                         = var.stage
    CHAIN_IDS                     = var.chain_ids
    PUSH_GATEWAY_URL              = "http://mark-pushgateway-${var.environment}-${var.stage}.mark.internal:9091"
    PROMETHEUS_URL                = "http://mark-prometheus-${var.environment}-${var.stage}.mark.internal:9090"
    PROMETHEUS_ENABLED            = true
    DD_LOGS_ENABLED               = true
    DD_ENV                        = "${var.environment}-${var.stage}"
    DD_API_KEY                    = var.dd_api_key
    DD_LAMBDA_HANDLER             = "packages/poller/dist/index.handler"
    
    CHAIN_1_PROVIDERS             = "https://eth-mainnet.blastapi.io/${var.blast_key}, https://eth-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    WETH_1_THRESHOLD              = "800000000000000000"
    USDC_1_THRESHOLD              = "4000000000"
    USDT_1_THRESHOLD              = "2000000000"
    
    CHAIN_10_PROVIDERS            = "https://optimism-mainnet.blastapi.io/${var.blast_key}, https://opt-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    WETH_10_THRESHOLD             = "1600000000000000000"
    USDC_10_THRESHOLD             = "4000000000"
    USDT_10_THRESHOLD             = "400000000"
    
    CHAIN_56_PROVIDERS            = "https://bsc-mainnet.blastapi.io/${var.blast_key}, https://bnb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    USDC_56_THRESHOLD             = "2000000000000000000000"
    USDT_56_THRESHOLD             = "4000000000000000000000"
    
    CHAIN_137_PROVIDERS           = "https://polygon-mainnet.blastapi.io/${var.blast_key}, https://polygon-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_8453_PROVIDERS          = "https://base-mainnet.blastapi.io/${var.blast_key}, https://base-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    WETH_8453_THRESHOLD           = "1600000000000000000"
    USDC_8453_THRESHOLD           = "4000000000"
    
    CHAIN_33139_PROVIDERS         = "https://apechain-mainnet.blastapi.io/${var.blast_key}, https://apechain-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_42161_PROVIDERS         = "https://arbitrum-one.blastapi.io/${var.blast_key}, https://arb-mainnet.g.alchemy.com/v2/${var.alchemy_key}"
    WETH_42161_THRESHOLD          = "1600000000000000000"
    USDC_42161_THRESHOLD          = "4000000000"
    USDT_42161_THRESHOLD          = "1000000000"
    
    CHAIN_43114_PROVIDERS         = "https://ava-mainnet.blastapi.io/${var.blast_key}/ext/bc/C/rpc, https://avax-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_48900_PROVIDERS         = "https://zircuit1-mainnet.p2pify.com, https://lb.drpc.org/ogrpc?network=zircuit-mainnet&dkey=${var.drpc_key}"

    CHAIN_59144_PROVIDERS         = "https://linea-mainnet.blastapi.io/${var.blast_key}, https://linea-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_81457_PROVIDERS         = "https://lb.drpc.org/ogrpc?network=blast&dkey=${var.drpc_key}, https://blastl2-mainnet.public.blastapi.io"

    CHAIN_167000_PROVIDERS        = "https://lb.drpc.org/ogrpc?network=taiko&dkey=${var.drpc_key}"

    CHAIN_534352_PROVIDERS        = "https://scroll-mainnet.g.alchemy.com/v2/${var.alchemy_key}"

    CHAIN_34443_PROVIDERS         = "https://mode-mainnet.blastapi.io/${var.blast_key}, https://mainnet.mode.network"

    CHAIN_324_PROVIDERS           = "https://zksync-mainnet.g.alchemy.com/v2/${var.alchemy_key}, https://mainnet.era.zksync.io"

    CHAIN_130_PROVIDERS           = "https://unichain-mainnet.g.alchemy.com/v2/${var.alchemy_key}, https://mainnet.unichain.org"
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
