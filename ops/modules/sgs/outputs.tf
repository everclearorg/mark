output "web3signer_sg_id" {
  description = "ID of the web3signer security group"
  value       = aws_security_group.web3signer.id
}

output "lambda_sg_id" {
  description = "ID of the lambda security group"
  value       = aws_security_group.lambda.id
}