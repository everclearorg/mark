# Single security group for web3signer service
resource "aws_security_group" "web3signer" {
  name   = "mark-web3signer-${var.environment}-${var.stage}"
  description = "Security group for Web3Signer service - allows internal VPC access on port 9000"
  vpc_id = var.vpc_id

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow inbound traffic on port 9000 from within VPC
  ingress {
    from_port   = 9000
    to_port     = 9000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }

  tags = {
    Name        = "mark-web3signer-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Security group for Prometheus service
resource "aws_security_group" "prometheus" {
  name        = "mark-prometheus-${var.environment}-${var.stage}"
  description = "Security group for Prometheus service - allows internal VPC access on port 9090"
  vpc_id      = var.vpc_id

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow inbound traffic on port 9091 for Pushgateway metrics ingestion
  ingress {
    from_port   = 9091
    to_port     = 9091
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
    description = "Allow Pushgateway metrics ingestion"
  }

  # Allow inbound traffic on port 9090 for Prometheus UI/API
  ingress {
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
    description = "Allow Prometheus API access"
  }

  tags = {
    Name        = "mark-prometheus-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Single security group for lambda function
resource "aws_security_group" "lambda" {
  name   = "mark-lambda-${var.environment}-${var.stage}"
  description = "Security group for Lambda function - allows outbound access to Web3Signer and external APIs"
  vpc_id = var.vpc_id

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "mark-lambda-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Security group for EFS mount targets
resource "aws_security_group" "efs" {
  name        = "mark-efs-${var.environment}-${var.stage}"
  description = "Security group for EFS mount targets - allows NFS traffic from VPC"
  vpc_id      = var.vpc_id

  # Allow inbound NFS traffic from VPC
  ingress {
    from_port   = 2049
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
    description = "Allow NFS traffic for EFS"
  }

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "mark-efs-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}
