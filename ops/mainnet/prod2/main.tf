terraform {
  backend "s3" {
    bucket = "mark-mainnet-prod-2"
    key    = "state"
    region = "us-east-1"
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
  name            = "MARK_2_CONFIG_MAINNET"
  with_decryption = true
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  repository_url_prefix = "${local.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/"
  
  mark_config_json = jsondecode(data.aws_ssm_parameter.mark_config_mainnet.value)
  mark_config = {
    dd_api_key = local.mark_config_json.dd_api_key
    web3_signer_private_key = local.mark_config_json.web3_signer_private_key
    signerAddress = local.mark_config_json.signerAddress
    chains = local.mark_config_json.chains
  }
}

module "network" {
  source               = "../../modules/networking"
  stage                = var.stage
  environment          = var.environment
  domain               = var.domain
  cidr_block           = var.cidr_block
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
  ecs_cluster_name_prefix = "mark-ecs"
}

module "sgs" {
  source         = "../../modules/sgs"
  environment    = var.environment
  stage          = var.stage
  domain         = var.domain
  vpc_cidr_block = module.network.vpc_cidr_block
  vpc_id         = module.network.vpc_id
}

module "cache" {
  source                        = "../../modules/redis"
  stage                         = var.stage
  environment                   = var.environment
  family                        = "mark"
  sg_id                         = module.sgs.lambda_sg_id
  vpc_id                        = module.network.vpc_id
  cache_subnet_group_subnet_ids = module.network.public_subnets
  node_type                     = "cache.t3.small"
  public_redis                  = true
}

module "mark_web3signer" {
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
  docker_image        = "ghcr.io/connext/web3signer:latest"
  container_family    = "mark2-web3signer"
  container_port      = 9000
  cpu                 = 256
  memory              = 512
  instance_count      = 1
  service_security_groups = [module.sgs.web3signer_sg_id]
  container_env_vars  = local.web3signer_env_vars
  zone_id             = var.zone_id
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on = [aws_service_discovery_private_dns_namespace.mark_internal]
}

module "mark_prometheus" {
  source                  = "../../modules/service"
  stage                   = var.stage
  environment             = var.environment
  domain                  = var.domain
  region                  = var.region
  dd_api_key              = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
  execution_role_arn      = data.aws_iam_role.ecr_admin_role.arn
  cluster_id              = module.ecs.ecs_cluster_id
  vpc_id                  = module.network.vpc_id
  lb_subnets              = module.network.public_subnets
  task_subnets            = module.network.private_subnets
  docker_image            = "prom/prometheus:latest"
  container_family        = "mark2-prometheus"
  container_port          = 9090
  cpu                     = 512
  memory                  = 1024
  instance_count          = 1
  service_security_groups = [module.sgs.prometheus_sg_id]
  container_env_vars      = concat(
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
    "mkdir -p /etc/prometheus && echo \"$PROMETHEUS_CONFIG\" > /etc/prometheus/prometheus.yml && chmod 644 /etc/prometheus/prometheus.yml && exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --web.enable-lifecycle"
  ]
  cert_arn                = var.cert_arn
  ingress_cdir_blocks     = ["0.0.0.0/0"]
  ingress_ipv6_cdir_blocks = []
  create_alb              = true
  zone_id                 = var.zone_id
  health_check_settings   = {
    path                = "/-/healthy"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on = [aws_service_discovery_private_dns_namespace.mark_internal]
}

module "mark_pushgateway" {
  source                  = "../../modules/service"
  stage                   = var.stage
  environment             = var.environment
  domain                  = var.domain
  region                  = var.region
  dd_api_key              = local.mark_config.dd_api_key
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
  execution_role_arn      = data.aws_iam_role.ecr_admin_role.arn
  cluster_id              = module.ecs.ecs_cluster_id
  vpc_id                  = module.network.vpc_id
  lb_subnets              = module.network.private_subnets
  task_subnets            = module.network.private_subnets
  docker_image            = "prom/pushgateway:latest"
  container_family        = "mark2-pushgateway"
  container_port          = 9091
  cpu                     = 256
  memory                  = 512
  instance_count          = 1
  service_security_groups = [module.sgs.prometheus_sg_id]
  container_env_vars      = local.pushgateway_env_vars
  zone_id                 = var.zone_id
  private_dns_namespace_id = aws_service_discovery_private_dns_namespace.mark_internal.id
  depends_on = [aws_service_discovery_private_dns_namespace.mark_internal]
}

module "mark_poller" {
  source              = "../../modules/lambda"
  stage               = var.stage
  environment         = var.environment
  container_family    = "mark2-poller"
  execution_role_arn  = module.iam.lambda_role_arn
  image_uri           = var.image_uri
  subnet_ids          = module.network.private_subnets
  security_group_id   = module.sgs.lambda_sg_id
  container_env_vars  = local.poller_env_vars
}

module "iam" {
  source = "../../modules/iam"
  environment = var.environment
  stage = var.stage
  domain = var.domain
}

module "ecr" {
  source = "../../modules/ecr"
}
