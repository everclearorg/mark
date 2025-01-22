output "vpc_id" {
  description = "ID of the VPC"
  value       = module.network.vpc_id
}

output "web3signer_service_url" {
  description = "URL of the web3signer service"
  value       = module.mark_web3signer.service_url
}

output "lambda_function_name" {
  description = "Name of the Lambda function"
  value       = module.mark_poller.function_name
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs.ecs_cluster_name
}