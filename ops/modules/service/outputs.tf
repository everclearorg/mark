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
  value       = var.create_alb ? "${var.container_family}.${var.domain}" : "${aws_service_discovery_service.service.name}.${data.aws_service_discovery_dns_namespace.namespace.name}"
}

output "alb_dns_name" {
  description = "DNS name of the ALB"
  value       = var.create_alb ? aws_alb.lb[0].dns_name : null
}

output "alb_zone_id" {
  description = "Zone ID of the ALB"
  value       = var.create_alb ? aws_alb.lb[0].zone_id : null
}

output "route53_debug" {
  description = "Debug information for Route53"
  value = {
    zone_id = var.zone_id
    domain = var.domain
    alb_dns_name = var.create_alb ? aws_alb.lb[0].dns_name : null
    alb_zone_id = var.create_alb ? aws_alb.lb[0].zone_id : null
    record_name = var.create_alb ? "${var.container_family}.${var.domain}" : null
  }
}

output "debug_info" {
  description = "Debug information"
  value = {
    alb_sg_id = var.create_alb ? aws_security_group.lb[0].id : null
    ecs_sg_id = var.service_security_groups[0]
  }
}