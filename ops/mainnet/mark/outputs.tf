output "vpc_id" {
  description = "ID of the VPC"
  value       = module.network.vpc_id
}

output "web3signer_service_url" {
  description = "URL of the web3signer service"
  value       = module.mark_web3signer.service_url
}

output "prometheus_service_url" {
  description = "URL of the Prometheus service"
  value       = module.mark_prometheus.service_url
}

output "pushgateway_service_url" {
  description = "URL of the Prometheus Pushgateway service"
  value       = module.mark_pushgateway.service_url
}

output "lambda_function_name" {
  description = "Name of the Lambda function"
  value       = module.mark_poller.function_name
}

output "lambda_meth_only_function_name" {
  description = "Name of the METH-only Lambda function"
  value       = module.mark_poller_meth_only.function_name
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs.ecs_cluster_name
}

output "prometheus_debug_info" {
  description = "Debug information for Prometheus service"
  value       = module.mark_prometheus.debug_info
}

output "admin_api_endpoint" {
  description = "API Gateway endpoint URL for the Admin API"
  value       = module.mark_admin_api.api_endpoint
}

output "admin_api_custom_domain" {
  description = "Stable custom domain URL for the Admin API"
  value       = module.mark_admin_api.custom_domain_url
}

output "admin_lambda_name" {
  description = "Name of the Admin API Lambda function"
  value       = module.mark_admin_api.admin_lambda_name
}

output "lambda_static_ips" {
  description = "Static IP addresses for Lambda outbound traffic (for API whitelisting)"
  value       = module.network.nat_gateway_ips
}

output "database_url" {
  description = "PostgreSQL connection URL"
  value       = module.db.database_url
  sensitive   = true
}