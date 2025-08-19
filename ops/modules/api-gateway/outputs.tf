output "api_endpoint" {
  description = "Base URL for the API Gateway"
  value       = aws_api_gateway_stage.admin_api.invoke_url
}

output "custom_domain_url" {
  description = "Stable custom domain URL for the Admin API"
  value       = "https://${aws_api_gateway_domain_name.admin_api.domain_name}"
}

output "admin_lambda_arn" {
  description = "ARN of the Admin API Lambda function"
  value       = aws_lambda_function.admin_api.arn
}

output "admin_lambda_name" {
  description = "Name of the Admin API Lambda function"
  value       = aws_lambda_function.admin_api.function_name
} 