output "lambda_role_arn" {
  description = "The ARN of the Lambda IAM role"
  value       = aws_iam_role.lambda_role.arn
}

output "vpc_flow_logs_role_arn" {
  description = "ARN of the VPC Flow Logs IAM role"
  value       = data.aws_iam_role.vpc_flow_logs.arn
}