terraform {
  backend "s3" {
    bucket = "mark-mainnet-prod"
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

locals {
  account_id = data.aws_caller_identity.current.account_id
  repository_url_prefix = "${local.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/"
}

module "network" {
  source               = "../../modules/networking"
  stage                = var.stage
  environment          = var.environment
  domain               = var.domain
  cidr_block           = var.cidr_block
  vpc_flow_logs_role_arn = module.iam.vpc_flow_logs_role_arn
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
  dd_api_key          = var.dd_api_key
  execution_role_arn  = data.aws_iam_role.ecr_admin_role.arn
  cluster_id          = module.ecs.ecs_cluster_id
  vpc_id              = module.network.vpc_id
  lb_subnets          = module.network.private_subnets
  docker_image        = "ghcr.io/connext/web3signer:latest"
  container_family    = "mark-web3signer"
  container_port      = 9000
  cpu                 = 256
  memory              = 512
  instance_count      = 1
  service_security_groups = [module.sgs.web3signer_sg_id]
  container_env_vars  = local.web3signer_env_vars
}

module "mark_prometheus" {
  source              = "../../modules/service"
  stage               = var.stage
  environment         = var.environment
  domain              = var.domain
  region              = var.region
  dd_api_key          = var.dd_api_key
  execution_role_arn  = data.aws_iam_role.ecr_admin_role.arn
  cluster_id          = module.ecs.ecs_cluster_id
  vpc_id              = module.network.vpc_id
  lb_subnets          = module.network.private_subnets
  docker_image        = "prom/prometheus:latest"
  container_family    = "mark-prometheus"
  container_port      = 9090
  cpu                 = 512
  memory              = 1024
  instance_count      = 1
  service_security_groups = [module.sgs.prometheus_sg_id]
  container_env_vars  = local.prometheus_env_vars
}

module "mark_poller" {
  source              = "../../modules/lambda"
  stage               = var.stage
  environment         = var.environment
  container_family    = "mark-poller"
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