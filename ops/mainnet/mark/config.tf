locals {
  rebalanceConfig = {
    bucket = "mark-rebalance-config"
    key    = "rebalance-config.json"
    region = var.region
  }

  prometheus_config = <<-EOT
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'prometheus'
        static_configs:
          - targets: ['localhost:9090']

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
    SIGNER_URL                   = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS               = local.mark_config.signerAddress
    REDIS_HOST                   = module.cache.redis_instance_address
    REDIS_PORT                   = module.cache.redis_instance_port
    DATABASE_URL                 = module.db.database_url
    SUPPORTED_SETTLEMENT_DOMAINS = var.supported_settlement_domains
    SUPPORTED_ASSET_SYMBOLS      = var.supported_asset_symbols
    LOG_LEVEL                    = var.log_level
    ENVIRONMENT                  = var.environment
    STAGE                        = var.stage
    CHAIN_IDS                    = var.chain_ids
    PUSH_GATEWAY_URL             = "http://mark-pushgateway-${var.environment}-${var.stage}.mark.internal:9091"
    PROMETHEUS_URL               = "http://mark-prometheus-${var.environment}-${var.stage}.mark.internal:9090"
    PROMETHEUS_ENABLED           = true
    DD_LOGS_ENABLED              = true
    DD_ENV                       = "${var.environment}-${var.stage}"
    DD_API_KEY                   = local.mark_config.dd_api_key
    DD_LAMBDA_HANDLER            = "index.handler"
    DD_TRACE_ENABLED             = true
    DD_PROFILING_ENABLED         = false
    DD_MERGE_XRAY_TRACES         = true
    DD_TRACE_OTEL_ENABLED        = false
    MARK_CONFIG_SSM_PARAMETER    = "MARK_CONFIG_MAINNET"

    REBALANCE_CONFIG_S3_BUCKET = local.rebalanceConfig.bucket
    REBALANCE_CONFIG_S3_KEY    = local.rebalanceConfig.key
    REBALANCE_CONFIG_S3_REGION = local.rebalanceConfig.region

    WETH_1_THRESHOLD = "800000000000000000"
    USDC_1_THRESHOLD = "4000000000"
    USDT_1_THRESHOLD = "2000000000"

    WETH_10_THRESHOLD = "1600000000000000000"
    USDC_10_THRESHOLD = "4000000000"
    USDT_10_THRESHOLD = "400000000"

    USDC_56_THRESHOLD = "2000000000000000000000"
    USDT_56_THRESHOLD = "4000000000000000000000"


    WETH_8453_THRESHOLD = "1600000000000000000"
    USDC_8453_THRESHOLD = "4000000000"

    WETH_42161_THRESHOLD = "1600000000000000000"
    USDC_42161_THRESHOLD = "4000000000"
    USDT_42161_THRESHOLD = "1000000000"

    # TAC Chain (239) configuration
    USDT_239_THRESHOLD = "100000000" # 100 USDT threshold on TAC

    # Solana (1399811149) ptsUSDe configuration
    PTUSDE_1399811149_THRESHOLD = "5000000000" # 5 ptUSDe threshold on Solana (9 decimals)

    # TAC Network configuration (loaded from SSM if available)
    TAC_NETWORK = "mainnet"

    # TON wallet configuration for TAC bridge (from SSM)
    TON_SIGNER_ADDRESS = local.mark_config.tonSignerAddress
    TON_MNEMONIC       = local.mark_config.ton.mnemonic

    # TAC Rebalance configuration
    TAC_REBALANCE_ENABLED                          = tostring(local.mark_config.tacRebalance.enabled)
    TAC_REBALANCE_MARKET_MAKER_ADDRESS             = local.mark_config.tacRebalance.marketMaker.address
    TAC_REBALANCE_MARKET_MAKER_ON_DEMAND_ENABLED   = tostring(local.mark_config.tacRebalance.marketMaker.onDemandEnabled)
    TAC_REBALANCE_MARKET_MAKER_THRESHOLD_ENABLED   = tostring(local.mark_config.tacRebalance.marketMaker.thresholdEnabled)
    TAC_REBALANCE_MARKET_MAKER_THRESHOLD           = local.mark_config.tacRebalance.marketMaker.threshold
    TAC_REBALANCE_MARKET_MAKER_TARGET_BALANCE      = local.mark_config.tacRebalance.marketMaker.targetBalance
    TAC_REBALANCE_FILL_SERVICE_ADDRESS             = local.mark_config.tacRebalance.fillService.address
    TAC_REBALANCE_FILL_SERVICE_SENDER_ADDRESS      = local.mark_config.tacRebalance.fillService.senderAddress
    TAC_REBALANCE_FILL_SERVICE_THRESHOLD_ENABLED   = tostring(local.mark_config.tacRebalance.fillService.thresholdEnabled)
    TAC_REBALANCE_FILL_SERVICE_THRESHOLD           = local.mark_config.tacRebalance.fillService.threshold
    TAC_REBALANCE_FILL_SERVICE_TARGET_BALANCE      = local.mark_config.tacRebalance.fillService.targetBalance
    TAC_REBALANCE_FILL_SERVICE_ALLOW_CROSS_WALLET  = tostring(local.mark_config.tacRebalance.fillService.allowCrossWalletRebalancing)
    # Fill Service signer URL (only set if FS signer is deployed)
    # Note: URL is constructed here because module output isn't available at locals evaluation time
    # Service discovery name = ${container_family}-${environment}-${stage}.mark.internal
    FILL_SERVICE_SIGNER_URL                        = local.mark_config.web3_fastfill_signer_private_key != "" ? "http://${var.bot_name}-fillservice-web3signer-${var.environment}-${var.stage}.mark.internal:9000" : ""
    FILL_SERVICE_SIGNER_ADDRESS                    = local.mark_config.fillServiceSignerAddress
    TAC_REBALANCE_BRIDGE_SLIPPAGE_DBPS             = tostring(local.mark_config.tacRebalance.bridge.slippageDbps)
    TAC_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT      = local.mark_config.tacRebalance.bridge.minRebalanceAmount
    TAC_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT      = local.mark_config.tacRebalance.bridge.maxRebalanceAmount

    # METH Rebalance configuration
    METH_REBALANCE_ENABLED                          = tostring(local.mark_config.methRebalance.enabled)
    METH_REBALANCE_MARKET_MAKER_ADDRESS             = local.mark_config.methRebalance.marketMaker.address
    METH_REBALANCE_MARKET_MAKER_ON_DEMAND_ENABLED   = tostring(local.mark_config.methRebalance.marketMaker.onDemandEnabled)
    METH_REBALANCE_MARKET_MAKER_THRESHOLD_ENABLED   = tostring(local.mark_config.methRebalance.marketMaker.thresholdEnabled)
    METH_REBALANCE_MARKET_MAKER_THRESHOLD           = local.mark_config.methRebalance.marketMaker.threshold
    METH_REBALANCE_MARKET_MAKER_TARGET_BALANCE      = local.mark_config.methRebalance.marketMaker.targetBalance
    METH_REBALANCE_FILL_SERVICE_ADDRESS             = local.mark_config.methRebalance.fillService.address
    METH_REBALANCE_FILL_SERVICE_SENDER_ADDRESS      = local.mark_config.methRebalance.fillService.senderAddress
    METH_REBALANCE_FILL_SERVICE_THRESHOLD_ENABLED   = tostring(local.mark_config.methRebalance.fillService.thresholdEnabled)
    METH_REBALANCE_FILL_SERVICE_THRESHOLD           = local.mark_config.methRebalance.fillService.threshold
    METH_REBALANCE_FILL_SERVICE_TARGET_BALANCE      = local.mark_config.methRebalance.fillService.targetBalance
    METH_REBALANCE_FILL_SERVICE_ALLOW_CROSS_WALLET  = tostring(local.mark_config.methRebalance.fillService.allowCrossWalletRebalancing)
    METH_REBALANCE_BRIDGE_SLIPPAGE_DBPS             = tostring(local.mark_config.methRebalance.bridge.slippageDbps)
    METH_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT      = local.mark_config.methRebalance.bridge.minRebalanceAmount
    METH_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT      = local.mark_config.methRebalance.bridge.maxRebalanceAmount
  }

  # Solana USDC → ptUSDe rebalancing poller configuration
  # Extends base poller config with Solana-specific overrides
  solana_usdc_poller_env_vars = merge(
    local.poller_env_vars,
    {
      # Solana-specific configuration
      RUN_MODE              = "solanaUsdcOnly"
      SOLANA_PRIVATE_KEY    = local.mark_config.solana.privateKey
      SOLANA_RPC_URL        = local.mark_config.solana.rpcUrl
      SOLANA_SIGNER_ADDRESS = local.mark_config.solanaSignerAddress
      # ptUSDe SPL token mint on Solana (from SSM config)
      PTUSDE_SOLANA_MINT = local.mark_config.solana.ptUsdeMint
    }
  )

  web3signer_env_vars = [
    {
      name  = "WEB3_SIGNER_PRIVATE_KEY"
      value = local.mark_config.web3_signer_private_key
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

  # Fill Service Web3Signer env vars - uses fastfill private key
  fillservice_web3signer_env_vars = [
    {
      name  = "WEB3_SIGNER_PRIVATE_KEY"
      value = local.mark_config.web3_fastfill_signer_private_key
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
