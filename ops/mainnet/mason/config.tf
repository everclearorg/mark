locals {
  rebalanceConfig = {
    bucket = "mason-rebalance-config"
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
          - targets: ['mason-pushgateway-${var.environment}-${var.stage}.mark.internal:9091']
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

  # NOTE: TAC/METH rebalance config is loaded from SSM at runtime (not as env vars)
  # to stay under AWS Lambda's 4KB env var limit.
  # 
  # SSM-loaded config (via MARK_CONFIG_SSM_PARAMETER):
  # - tacRebalance.* (all TAC_REBALANCE_* values)
  # - methRebalance.* (all METH_REBALANCE_* values)  
  # - ton.mnemonic, tonSignerAddress
  #
  # See packages/core/src/config.ts for the fallback logic.
  
  poller_env_vars = {
    # Core infrastructure (must be env vars - runtime-determined values)
    DATABASE_URL   = module.db.database_url
    SIGNER_URL     = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS = local.mark_config.signerAddress
    REDIS_HOST     = module.cache.redis_instance_address
    REDIS_PORT     = module.cache.redis_instance_port

    # Application config
    SUPPORTED_SETTLEMENT_DOMAINS = var.supported_settlement_domains
    SUPPORTED_ASSET_SYMBOLS      = var.supported_asset_symbols
    LOG_LEVEL                    = var.log_level
    ENVIRONMENT                  = var.environment
    STAGE                        = var.stage
    CHAIN_IDS                    = var.chain_ids
    EVERCLEAR_API_URL            = "https://api.staging.everclear.org"

    # SSM Parameter for runtime config loading
    MARK_CONFIG_SSM_PARAMETER = "MASON_CONFIG_MAINNET"

    # S3 rebalance config
    REBALANCE_CONFIG_S3_BUCKET = local.rebalanceConfig.bucket
    REBALANCE_CONFIG_S3_KEY    = local.rebalanceConfig.key
    REBALANCE_CONFIG_S3_REGION = local.rebalanceConfig.region

    # Prometheus/metrics
    PUSH_GATEWAY_URL   = "http://mason-pushgateway-${var.environment}-${var.stage}.mark.internal:9091"
    PROMETHEUS_URL     = "http://mason-prometheus-${var.environment}-${var.stage}.mark.internal:9090"
    PROMETHEUS_ENABLED = true

    # DataDog (minimal set)
    DD_LOGS_ENABLED       = true
    DD_ENV                = "${var.environment}-${var.stage}"
    DD_API_KEY            = local.mark_config.dd_api_key
    DD_LAMBDA_HANDLER     = "index.handler"
    DD_TRACE_ENABLED      = true
    DD_PROFILING_ENABLED  = false
    DD_MERGE_XRAY_TRACES  = true
    DD_TRACE_OTEL_ENABLED = false

    # Fill Service signer (runtime URLs can't be in SSM)
    FILL_SERVICE_SIGNER_URL     = local.mark_config.web3_fastfill_signer_private_key != "" ? "http://${var.bot_name}-fillservice-web3signer-${var.environment}-${var.stage}.mark.internal:9000" : ""
    FILL_SERVICE_SIGNER_ADDRESS = local.mark_config.fillServiceSignerAddress

    # Balance thresholds - KEEP as env vars (not in SSM, defaults to 0 if missing)
    WETH_1_THRESHOLD     = "800000000000000000"
    USDC_1_THRESHOLD     = "4000000000"
    USDT_1_THRESHOLD     = "2000000000"
    WETH_10_THRESHOLD    = "1600000000000000000"
    USDC_10_THRESHOLD    = "4000000000"
    USDT_10_THRESHOLD    = "400000000"
    USDC_56_THRESHOLD    = "2000000000000000000000"
    USDT_56_THRESHOLD    = "4000000000000000000000"
    WETH_8453_THRESHOLD  = "1600000000000000000"
    USDC_8453_THRESHOLD  = "4000000000"
    WETH_42161_THRESHOLD = "1600000000000000000"
    USDC_42161_THRESHOLD = "4000000000"
    USDT_42161_THRESHOLD = "1000000000"
    USDT_239_THRESHOLD   = "100000000"
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

  # Invoice handler environment variables (ECS service, not Lambda)
  handler_env_vars = [
    {
      name  = "DATABASE_URL"
      value = module.db.database_url
    },
    {
      name  = "SIGNER_URL"
      value = "http://${module.mark_web3signer.service_url}:9000"
    },
    {
      name  = "SIGNER_ADDRESS"
      value = local.mark_config.signerAddress
    },
    {
      name  = "REDIS_HOST"
      value = module.cache.redis_instance_address
    },
    {
      name  = "REDIS_PORT"
      value = module.cache.redis_instance_port
    },
    {
      name  = "SUPPORTED_SETTLEMENT_DOMAINS"
      value = var.supported_settlement_domains
    },
    {
      name  = "SUPPORTED_ASSET_SYMBOLS"
      value = var.supported_asset_symbols
    },
    {
      name  = "LOG_LEVEL"
      value = var.log_level
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
      name  = "CHAIN_IDS"
      value = var.chain_ids
    },
    {
      name  = "EVERCLEAR_API_URL"
      value = "https://api.staging.everclear.org"
    },
    {
      name  = "MARK_CONFIG_SSM_PARAMETER"
      value = "MASON_CONFIG_MAINNET"
    },
    {
      name  = "REBALANCE_CONFIG_S3_BUCKET"
      value = local.rebalanceConfig.bucket
    },
    {
      name  = "REBALANCE_CONFIG_S3_KEY"
      value = local.rebalanceConfig.key
    },
    {
      name  = "REBALANCE_CONFIG_S3_REGION"
      value = local.rebalanceConfig.region
    },
    {
      name  = "PUSH_GATEWAY_URL"
      value = "http://${var.bot_name}-pushgateway-${var.environment}-${var.stage}.mark.internal:9091"
    },
    {
      name  = "PROMETHEUS_URL"
      value = "http://${var.bot_name}-prometheus-${var.environment}-${var.stage}.mark.internal:9090"
    },
    {
      name  = "PROMETHEUS_ENABLED"
      value = "true"
    },
    {
      name  = "FILL_SERVICE_SIGNER_URL"
      value = local.mark_config.web3_fastfill_signer_private_key != "" ? "http://${var.bot_name}-fillservice-web3signer-${var.environment}-${var.stage}.mark.internal:9000" : ""
    },
    {
      name  = "FILL_SERVICE_SIGNER_ADDRESS"
      value = local.mark_config.fillServiceSignerAddress
    },
    {
      name  = "PORT"
      value = "3000"
    },
    {
      name  = "HOST"
      value = "0.0.0.0"
    },
    {
      name  = "POLLING_INTERVAL_MS"
      value = "60000"
    },
    {
      name  = "WETH_1_THRESHOLD"
      value = "800000000000000000"
    },
    {
      name  = "USDC_1_THRESHOLD"
      value = "4000000000"
    },
    {
      name  = "USDT_1_THRESHOLD"
      value = "2000000000"
    },
    {
      name  = "WETH_10_THRESHOLD"
      value = "1600000000000000000"
    },
    {
      name  = "USDC_10_THRESHOLD"
      value = "4000000000"
    },
    {
      name  = "USDT_10_THRESHOLD"
      value = "400000000"
    },
    {
      name  = "USDC_56_THRESHOLD"
      value = "2000000000000000000000"
    },
    {
      name  = "USDT_56_THRESHOLD"
      value = "4000000000000000000000"
    },
    {
      name  = "WETH_8453_THRESHOLD"
      value = "1600000000000000000"
    },
    {
      name  = "USDC_8453_THRESHOLD"
      value = "4000000000"
    },
    {
      name  = "WETH_42161_THRESHOLD"
      value = "1600000000000000000"
    },
    {
      name  = "USDC_42161_THRESHOLD"
      value = "4000000000"
    },
    {
      name  = "USDT_42161_THRESHOLD"
      value = "1000000000"
    },
    {
      name  = "USDT_239_THRESHOLD"
      value = "100000000"
    }
  ]
}
