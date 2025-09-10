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
    SIGNER_URL                    = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS                = local.mark_config.signerAddress
    REDIS_HOST                    = module.cache.redis_instance_address
    REDIS_PORT                    = module.cache.redis_instance_port
    DATABASE_URL                  = module.db.database_url
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
    DD_API_KEY                    = local.mark_config.dd_api_key
    DD_LAMBDA_HANDLER             = "index.handler"
    DD_TRACE_ENABLED              = true
    DD_PROFILING_ENABLED          = false
    DD_MERGE_XRAY_TRACES          = true
    DD_TRACE_OTEL_ENABLED         = false
    MARK_CONFIG_SSM_PARAMETER     = "MARK_CONFIG_MAINNET"

    REBALANCE_CONFIG_S3_BUCKET    = local.rebalanceConfig.bucket
    REBALANCE_CONFIG_S3_KEY       = local.rebalanceConfig.key
    REBALANCE_CONFIG_S3_REGION    = local.rebalanceConfig.region

    WETH_1_THRESHOLD              = "800000000000000000"
    USDC_1_THRESHOLD              = "4000000000"
    USDT_1_THRESHOLD              = "2000000000"

    WETH_10_THRESHOLD             = "1600000000000000000"
    USDC_10_THRESHOLD             = "4000000000"
    USDT_10_THRESHOLD             = "400000000"

    USDC_56_THRESHOLD             = "2000000000000000000000"
    USDT_56_THRESHOLD             = "4000000000000000000000"


    WETH_8453_THRESHOLD           = "1600000000000000000"
    USDC_8453_THRESHOLD           = "4000000000"

    WETH_42161_THRESHOLD          = "1600000000000000000"
    USDC_42161_THRESHOLD          = "4000000000"
    USDT_42161_THRESHOLD          = "1000000000"
  }

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
}
