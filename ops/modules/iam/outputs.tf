output "lambda_role_arn" {
  description = "The ARN of the Lambda IAM role"
  value       = aws_iam_role.lambda_role.arn
}