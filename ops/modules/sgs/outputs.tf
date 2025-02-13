output "web3signer_sg_id" {
  description = "ID of the web3signer security group"
  value       = aws_security_group.web3signer.id
}

output "prometheus_sg_id" {
  description = "ID of the prometheus security group"
  value       = aws_security_group.prometheus.id
}

output "lambda_sg_id" {
  description = "ID of the lambda security group"
  value       = aws_security_group.lambda.id
}