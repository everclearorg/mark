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
  value       = "${aws_service_discovery_service.service.name}.${data.aws_service_discovery_dns_namespace.namespace.name}"
}

output "alb_dns_name" {
  description = "DNS name of the ALB"
  value       = var.create_alb ? aws_alb.lb[0].dns_name : null
}

output "alb_zone_id" {
  description = "Zone ID of the ALB"
  value       = var.create_alb ? aws_alb.lb[0].zone_id : null
}