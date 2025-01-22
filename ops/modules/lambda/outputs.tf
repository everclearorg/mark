output "function_name" {
  description = "Name of the Lambda function"
  value       = aws_lambda_function.function.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function"
  value       = aws_lambda_function.function.arn
}

output "cloudwatch_rule_name" {
  description = "Name of the CloudWatch Events rule"
  value       = aws_cloudwatch_event_rule.schedule.name
}