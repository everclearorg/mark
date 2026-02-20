terraform {
  backend "s3" {
    bucket = "mark-mainnet-prod"
    key    = "state"
    region = "us-east-1"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.83"
    }
  }
}

provider "aws" {
  region = var.region
}

# Fetch AZs in the current region
data "aws_availability_zones" "available" {}

data "aws_iam_role" "ecr_admin_role" {
  name = "erc_admin_role"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Read the MARK_CONFIG_MAINNET parameter from SSM
data "aws_ssm_parameter" "mark_config_mainnet" {
  name            = "MARK_CONFIG_MAINNET"
  with_decryption = true
}

locals {
  account_id            = data.aws_caller_identity.current.account_id
  repository_url_prefix = "${local.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/"

  mark_config_json = jsondecode(data.aws_ssm_parameter.mark_config_mainnet.value)
  mark_config = {
    dd_api_key              = local.mark_config_json.dd_api_key
    web3_signer_private_key = local.mark_config_json.web3_signer_private_key
    signerAddress           = local.mark_config_json.signerAddress
    chains                  = local.mark_config_json.chains
    db_password             = local.mark_config_json.db_password
    admin_token             = local.mark_config_json.admin_token
    # Fill Service signer configuration (optional - for TAC FS rebalancing with separate sender)
    web3_fastfill_signer_private_key = try(local.mark_config_json.web3_fastfill_signer_private_key, "")
    fillServiceSignerAddress         = try(local.mark_config_json.fillServiceSignerAddress, "")
    # TAC/TON configuration (optional - for TAC USDT rebalancing)
    tonSignerAddress = try(local.mark_config_json.tonSignerAddress, "")
    # Full TON configuration including assets with jetton addresses
    ton = {
      mnemonic = try(local.mark_config_json.ton.mnemonic, "")
      rpcUrl   = try(local.mark_config_json.ton.rpcUrl, "")
      apiKey   = try(local.mark_config_json.ton.apiKey, "")
      assets   = try(local.mark_config_json.ton.assets, [])
    }
    # TAC Rebalance configuration
    tacRebalance = {
      enabled = try(local.mark_config_json.tacRebalance.enabled, false)
      marketMaker = {
        address           = try(local.mark_config_json.tacRebalance.marketMaker.address, "")
        onDemandEnabled   = try(local.mark_config_json.tacRebalance.marketMaker.onDemandEnabled, false)
        thresholdEnabled  = try(local.mark_config_json.tacRebalance.marketMaker.thresholdEnabled, false)
        threshold         = try(local.mark_config_json.tacRebalance.marketMaker.threshold, "")
        targetBalance     = try(local.mark_config_json.tacRebalance.marketMaker.targetBalance, "")
      }
      fillService = {
        address                     = try(local.mark_config_json.tacRebalance.fillService.address, "")
        senderAddress               = try(local.mark_config_json.tacRebalance.fillService.senderAddress, "") # Filler's ETH sender address
        thresholdEnabled            = try(local.mark_config_json.tacRebalance.fillService.thresholdEnabled, false)
        threshold                   = try(local.mark_config_json.tacRebalance.fillService.threshold, "")
        targetBalance               = try(local.mark_config_json.tacRebalance.fillService.targetBalance, "")
        allowCrossWalletRebalancing = try(local.mark_config_json.tacRebalance.fillService.allowCrossWalletRebalancing, false)
      }
      bridge = {
        slippageDbps       = try(local.mark_config_json.tacRebalance.bridge.slippageDbps, 500) # 5% default
        minRebalanceAmount = try(local.mark_config_json.tacRebalance.bridge.minRebalanceAmount, "")
        maxRebalanceAmount = try(local.mark_config_json.tacRebalance.bridge.maxRebalanceAmount, "")
      }
    }
    # METH Rebalance configuration
    methRebalance = {
      enabled = try(local.mark_config_json.methRebalance.enabled, false)
      marketMaker = {
        address           = try(local.mark_config_json.methRebalance.marketMaker.address, "")
        onDemandEnabled   = try(local.mark_config_json.methRebalance.marketMaker.onDemandEnabled, false)
        thresholdEnabled  = try(local.mark_config_json.methRebalance.marketMaker.thresholdEnabled, false)
        threshold         = try(local.mark_config_json.methRebalance.marketMaker.threshold, "")
        targetBalance     = try(local.mark_config_json.methRebalance.marketMaker.targetBalance, "")
      }
      fillService = {
        address                     = try(local.mark_config_json.methRebalance.fillService.address, "")
        senderAddress               = try(local.mark_config_json.methRebalance.fillService.senderAddress, "") # Filler's ETH sender address
        thresholdEnabled            = try(local.mark_config_json.methRebalance.fillService.thresholdEnabled, false)
        threshold                   = try(local.mark_config_json.methRebalance.fillService.threshold, "")
        targetBalance               = try(local.mark_config_json.methRebalance.fillService.targetBalance, "")
        allowCrossWalletRebalancing = try(local.mark_config_json.methRebalance.fillService.allowCrossWalletRebalancing, false)
      }
      bridge = {
        slippageDbps       = try(local.mark_config_json.methRebalance.bridge.slippageDbps, 500) # 5% default
        minRebalanceAmount = try(local.mark_config_json.methRebalance.bridge.minRebalanceAmount, "")
        maxRebalanceAmount = try(local.mark_config_json.methRebalance.bridge.maxRebalanceAmount, "")
      }
    }
    # Solana configuration for CCIP bridge operations
    solana = {
      privateKey = try(local.mark_config_json.solana.privateKey, "")
      rpcUrl     = try(local.mark_config_json.solana.rpcUrl, "https://api.mainnet-beta.solana.com")
      ptUsdeMint = try(local.mark_config_json.solana.ptUsdeMint, "PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA")
    }
    solanaSignerAddress = try(local.mark_config_json.solanaSignerAddress, "")
  }
}

module "network" {
  source                 = "../../modules/networking"
  stage                  = var.stage
  environment            = var.environment
  domain                 = var.domain
  cidr_block             = var.cidr_block
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
}

resource "aws_service_discovery_private_dns_namespace" "mark_internal" {
  name        = "mark.internal"
  description = "Mark internal DNS namespace for service discovery"
  vpc         = module.network.vpc_id
}

module "ecs" {
  source                  = "../../modules/ecs"
  stage                   = var.stage
  environment             = var.environment
  domain                  = var.domain
  ecs_cluster_name_prefix = "${var.bot_name}-ecs"
}

module "sgs" {
  source         = "../../modules/sgs"
  environment    = var.environment
  stage          = var.stage
  domain         = var.domain
  vpc_cidr_block = module.network.vpc_cidr_block
  vpc_id         = module.network.vpc_id
}

module "efs" {
  source                = "../../modules/efs"
  environment           = var.environment
  stage                 = var.stage
  domain                = var.domain
  subnet_ids            = module.network.private_subnets
  efs_security_group_id = module.sgs.efs_sg_id
}

module "cache" {
  source                        = "../../modules/redis"
  stage                         = var.stage
  environment                   = var.environment
  family                        = var.bot_name
  sg_id                         = module.sgs.lambda_sg_id
  vpc_id                        = module.network.vpc_id
  cache_subnet_group_subnet_ids = module.network.public_subnets
  node_type                     = "cache.t3.small"
  public_redis                  = true
}

# ACM certificate for this bot's domains (handler, admin API, prometheus)
module "acm" {
  source      = "../../modules/acm"
  bot_name    = var.bot_name
  domain      = var.domain
  zone_id     = var.zone_id
  environment = var.environment
  stage       = var.stage
}

module "mark_web3signer" {
  source                   = "../../modules/service"
  stage                    = var.stage
  environment              = var.environment
  domain                   = var.domain
  region                   = var.region
  dd_api_key               = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn   = module.iam.vpc_flow_logs_role_arn
  execution_role_arn       = data.aws_iam_role.ecr_admin_role.arn
  cluster_id               = module.ecs.ecs_cluster_id
  vpc_id                   = module.network.vpc_id
  lb_subnets               = module.network.private_subnets
  task_subnets             = module.network.private_subnets
  efs_id                   = module.efs.mark_efs_id
  docker_image             = "ghcr.io/connext/web3signer:latest"
  container_family         = "${var.bot_name}-web3signer"
  container_port           = 9000
  cpu                      = 256
  memory                   = 512
  instance_count           = 1
  service_security_groups  = [module.sgs.web3signer_sg_id]
  container_env_vars       = local.web3signer_env_vars
  zone_id                  = var.zone_id
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on               = [aws_service_discovery_private_dns_namespace.mark_internal]
}

# Fill Service Web3Signer - separate signer for FS sender on TAC rebalancing
# Uses a different private key (web3_fastfill_signer_private_key)
# Internal port is 9000 (same as MM signer), but they're separate services with different DNS names:
# - MM:  mark-web3signer-mainnet-production.mark.internal:9000
# - FS:  mark-fillservice-web3signer-mainnet-production.mark.internal:9000
module "mark_fillservice_web3signer" {
  count               = local.mark_config.web3_fastfill_signer_private_key != "" ? 1 : 0
  source              = "../../modules/service"
  stage               = var.stage
  environment         = var.environment
  domain              = var.domain
  region              = var.region
  dd_api_key          = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
  execution_role_arn  = data.aws_iam_role.ecr_admin_role.arn
  cluster_id          = module.ecs.ecs_cluster_id
  vpc_id              = module.network.vpc_id
  lb_subnets          = module.network.private_subnets
  task_subnets        = module.network.private_subnets
  efs_id              = module.efs.mark_efs_id
  docker_image        = "ghcr.io/connext/web3signer:latest"
  container_family    = "${var.bot_name}-fillservice-web3signer"
  container_port      = 9000 # Internal port is same, service discovery handles routing
  cpu                 = 256
  memory              = 512
  instance_count      = 1
  service_security_groups = [module.sgs.web3signer_sg_id]
  container_env_vars  = local.fillservice_web3signer_env_vars
  zone_id             = var.zone_id
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on = [aws_service_discovery_private_dns_namespace.mark_internal]
}

module "mark_prometheus" {
  source                 = "../../modules/service"
  stage                  = var.stage
  environment            = var.environment
  domain                 = var.domain
  region                 = var.region
  dd_api_key             = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
  execution_role_arn     = data.aws_iam_role.ecr_admin_role.arn
  cluster_id             = module.ecs.ecs_cluster_id
  vpc_id                 = module.network.vpc_id
  lb_subnets             = module.network.public_subnets
  task_subnets           = module.network.private_subnets
  efs_id                 = module.efs.mark_efs_id
  docker_image           = "679752396206.dkr.ecr.ap-northeast-1.amazonaws.com/prometheus:v2.53.5" # 429 errors
  container_family       = "${var.bot_name}-prometheus"
  volume_name            = "${var.bot_name}-prometheus-data"
  volume_container_path  = "/prometheus"
  volume_efs_path        = "/"
  container_port         = 9090
  cpu                    = 512
  memory                 = 1024
  instance_count         = 1
  deployment_configuration = {
    maximum_percent         = 100
    minimum_healthy_percent = 0
  }
  service_security_groups = [module.sgs.prometheus_sg_id]
  container_user          = "65534:65534"
  init_container_enabled  = true
  init_container_commands = ["sh", "-c", "rm -rf /prometheus/lock /prometheus/wal.tmp && mkdir -p /prometheus && chown -R 65534:65534 /prometheus && chmod -R 755 /prometheus"]
  container_env_vars = concat(
    local.prometheus_env_vars,
    [
      {
        name  = "PROMETHEUS_CONFIG"
        value = local.prometheus_config
      }
    ]
  )
  entrypoint = [
    "/bin/sh",
    "-c",
    "set -e; echo 'Setting up Prometheus...'; mkdir -p /etc/prometheus && echo 'Created config directory'; echo \"$PROMETHEUS_CONFIG\" > /etc/prometheus/prometheus.yml && echo 'Created config file'; chmod 644 /etc/prometheus/prometheus.yml && echo 'Set config permissions'; echo 'Starting Prometheus...'; exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --web.enable-lifecycle"
  ]
  cert_arn                 = module.acm.certificate_arn
  ingress_cdir_blocks      = ["0.0.0.0/0"]
  ingress_ipv6_cdir_blocks = []
  create_alb               = true
  zone_id                  = var.zone_id
  health_check_settings = {
    path                = "/-/healthy"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on               = [aws_service_discovery_private_dns_namespace.mark_internal]
}

module "mark_pushgateway" {
  source                  = "../../modules/service"
  stage                   = var.stage
  environment             = var.environment
  domain                  = var.domain
  region                  = var.region
  dd_api_key              = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn  = module.iam.vpc_flow_logs_role_arn
  execution_role_arn      = data.aws_iam_role.ecr_admin_role.arn
  cluster_id              = module.ecs.ecs_cluster_id
  vpc_id                  = module.network.vpc_id
  lb_subnets              = module.network.private_subnets
  task_subnets            = module.network.private_subnets
  efs_id                  = module.efs.mark_efs_id
  docker_image            = "679752396206.dkr.ecr.ap-northeast-1.amazonaws.com/pushgateway:v1.11.1"
  container_family        = "${var.bot_name}-pushgateway"
  volume_name             = "${var.bot_name}-pushgateway-data"
  volume_container_path   = "/pushgateway"
  volume_efs_path         = "/"
  container_user          = "65534:65534"
  init_container_enabled  = true
  init_container_commands = ["sh", "-c", "mkdir -p /pushgateway && chown -R 65534:65534 /pushgateway && chmod -R 755 /pushgateway"]
  entrypoint = [
    "/bin/sh",
    "-c",
    "exec /bin/pushgateway --persistence.file=/pushgateway/metrics.txt --persistence.interval=1m0s"
  ]
  container_port           = 9091
  cpu                      = 256
  memory                   = 512
  instance_count           = 1
  service_security_groups  = [module.sgs.prometheus_sg_id]
  container_env_vars       = local.pushgateway_env_vars
  zone_id                  = var.zone_id
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on               = [aws_service_discovery_private_dns_namespace.mark_internal]
}

# ============================================================================
# POLLER LAMBDA MODULE - REPLACED BY INVOICE HANDLER
# ============================================================================
# The mark_poller Lambda is replaced by the invoice handler ECS service to
# prevent duplicate intent creation. Only mark_poller is replaced - the other
# poller Lambdas (solana_usdc_poller, poller_meth_only) remain.
#
# TODO: Remove this commented module once migration is complete
# ============================================================================

# module "mark_poller" {
#   source             = "../../modules/lambda"
#   stage              = var.stage
#   environment        = var.environment
#   container_family   = "${var.bot_name}-poller"
#   execution_role_arn = module.iam.lambda_role_arn
#   image_uri          = var.image_uri
#   subnet_ids         = module.network.private_subnets
#   security_group_id  = module.sgs.lambda_sg_id
#   container_env_vars = local.poller_env_vars
# }

# Invoice Handler ECS Service - replaces poller Lambda functions
# Exposed via public ALB for Goldsky webhook access
module "mark_invoice_handler" {
  source                   = "../../modules/service"
  stage                    = var.stage
  environment              = var.environment
  domain                   = var.domain
  region                   = var.region
  dd_api_key               = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn   = module.iam.vpc_flow_logs_role_arn
  execution_role_arn       = data.aws_iam_role.ecr_admin_role.arn
  task_role_arn            = module.iam.ecs_task_role_arn
  cluster_id               = module.ecs.ecs_cluster_id
  vpc_id                   = module.network.vpc_id
  lb_subnets               = module.network.public_subnets
  task_subnets             = module.network.private_subnets
  efs_id                   = module.efs.mark_efs_id
  docker_image             = var.handler_image_uri
  container_family         = "${var.bot_name}-handler"
  container_port           = 3000
  cpu                      = 512
  memory                   = 1024
  instance_count           = 1
  service_security_groups  = [module.sgs.lambda_sg_id]
  container_env_vars       = local.handler_env_vars
  zone_id                  = var.zone_id
  cert_arn                 = module.acm.certificate_arn
  ingress_cdir_blocks      = ["0.0.0.0/0"]
  ingress_ipv6_cdir_blocks = []
  create_alb               = true
  internal_lb              = false
  health_check_settings = {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on               = [aws_service_discovery_private_dns_namespace.mark_internal]
}

# Solana USDC → ptUSDe rebalancing poller (multi-leg CCIP + Pendle)
# Schedule: 30 min interval since CCIP bridging takes ~20 min per leg
module "mark_solana_usdc_poller" {
  source              = "../../modules/lambda"
  stage               = var.stage
  environment         = var.environment
  container_family    = "${var.bot_name}-solana-usdc-poller"
  execution_role_arn  = module.iam.lambda_role_arn
  image_uri           = var.image_uri
  subnet_ids          = module.network.private_subnets
  security_group_id   = module.sgs.lambda_sg_id
  container_env_vars  = local.solana_usdc_poller_env_vars
  schedule_expression = "rate(30 minutes)"
  # Uses module defaults: timeout=900s, memory_size=1024MB
}

# METH-only Lambda - runs Mantle ETH rebalancing every 1 minute
module "mark_poller_meth_only" {
  source              = "../../modules/lambda"
  stage               = var.stage
  environment         = var.environment
  container_family    = "${var.bot_name}-poller-meth"
  execution_role_arn  = module.iam.lambda_role_arn
  image_uri           = var.image_uri
  subnet_ids          = module.network.private_subnets
  security_group_id   = module.sgs.lambda_sg_id
  schedule_expression = "rate(1 minute)"
  container_env_vars  = merge(local.poller_env_vars, {
    RUN_MODE = "methOnly"
  })
}

module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
  stage       = var.stage
  domain      = var.domain
}

module "ecr" {
  source = "../../modules/ecr"
}

module "mark_admin_api" {
  source              = "../../modules/api-gateway"
  stage               = var.stage
  environment         = var.environment
  domain              = var.domain
  certificate_arn     = module.acm.certificate_arn
  zone_id             = var.zone_id
  bot_name            = var.bot_name
  execution_role_arn  = module.iam.lambda_role_arn
  subnet_ids          = module.network.private_subnets
  security_group_id   = module.sgs.lambda_sg_id
  image_uri           = var.admin_image_uri
  container_env_vars  = {
    DD_SERVICE                      = "${var.bot_name}-admin"
    DD_LAMBDA_HANDLER               = "index.handler"
    DD_LOGS_ENABLED                 = "true"
    DD_TRACES_ENABLED               = "true"
    DD_RUNTIME_METRICS_ENABLED      = "true"
    DD_API_KEY                      = local.mark_config.dd_api_key
    LOG_LEVEL                       = "debug"
    REDIS_HOST                      = module.cache.redis_instance_address
    REDIS_PORT                      = module.cache.redis_instance_port
    ADMIN_TOKEN                     = local.mark_config.admin_token
    DATABASE_URL                    = module.db.database_url
    SIGNER_URL                      = "http://${module.mark_web3signer.service_url}:9000"
    SIGNER_ADDRESS                  = local.mark_config.signerAddress
    MARK_CONFIG_SSM_PARAMETER       = "MARK_CONFIG_MAINNET"
    SUPPORTED_SETTLEMENT_DOMAINS    = var.supported_settlement_domains
    SUPPORTED_ASSET_SYMBOLS         = var.supported_asset_symbols
    ENVIRONMENT                     = var.environment
    STAGE                           = var.stage
    CHAIN_IDS                       = var.chain_ids
    WHITELISTED_RECIPIENTS          = try(local.mark_config.whitelisted_recipients, "")
    PUSH_GATEWAY_URL                = "http://${var.bot_name}-pushgateway-${var.environment}-${var.stage}.mark.internal:9091"
    PROMETHEUS_URL                  = "http://${var.bot_name}-prometheus-${var.environment}-${var.stage}.mark.internal:9090"
  }
}

module "db" {
  source = "../../modules/db"

  identifier                 = "${var.stage}-${var.environment}-mark-db"
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  db_name                    = var.db_name
  username                   = var.db_username
  password                   = local.mark_config.db_password # Use password from MARK_CONFIG_MAINNET
  port                       = var.db_port
  vpc_security_group_ids     = [module.sgs.db_sg_id]
  db_subnet_group_subnet_ids = module.network.public_subnets
  publicly_accessible        = true
  maintenance_window         = "sun:06:30-sun:07:30"

  tags = {
    Stage       = var.stage
    Environment = var.environment
    Domain      = var.domain
  }
}
