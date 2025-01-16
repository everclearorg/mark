output "service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.service.name
}

output "task_definition_arn" {
  description = "ARN of the task definition"
  value       = aws_ecs_task_definition.service.arn
}

output "service_url" {
  description = "URL of the service"
  value       = "${aws_service_discovery_service.web3signer.name}.${aws_service_discovery_private_dns_namespace.namespace.name}"
}