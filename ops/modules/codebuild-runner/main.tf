resource "aws_codebuild_project" "github_runner" {
  name          = var.project_name
  description   = "CodeBuild project as GitHub Actions self-hosted runner for ${var.environment}"
  service_role  = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = var.compute_type
    image                      = var.build_image
    type                       = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode            = true

    environment_variable {
      name  = "RUNNER_LABEL"
      value = var.runner_label
    }

    environment_variable {
      name  = "DATABASE_URL"
      value = var.database_url
      type  = "PLAINTEXT"
    }
  }

  source {
    type            = "GITHUB"
    location        = var.github_repo
    git_clone_depth = 1
    # CodeBuild automatically handles GitHub Actions runner setup
    # when webhook is configured for WORKFLOW_JOB_QUEUED
  }

  # VPC Configuration for accessing RDS
  vpc_config {
    vpc_id = var.vpc_id
    subnets = var.private_subnet_ids
    security_group_ids = [aws_security_group.codebuild.id]
  }

  # Configure as GitHub Actions runner
  webhook {
    filter_group {
      filter {
        type    = "EVENT"
        pattern = "WORKFLOW_JOB_QUEUED"
      }
    }
  }

  tags = var.tags
}

# Security group for CodeBuild in VPC
resource "aws_security_group" "codebuild" {
  name        = "${var.project_name}-sg"
  description = "Security group for CodeBuild GitHub runner"
  vpc_id      = var.vpc_id

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.tags,
    {
      Name = "${var.project_name}-sg"
    }
  )
}

# Allow CodeBuild to access RDS
resource "aws_security_group_rule" "codebuild_to_rds" {
  type                     = "ingress"
  from_port                = var.rds_port
  to_port                  = var.rds_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.codebuild.id
  security_group_id        = var.rds_security_group_id
  description              = "Allow CodeBuild runner to access RDS"
}

# IAM role for CodeBuild
resource "aws_iam_role" "codebuild" {
  name = "${var.project_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "codebuild.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

# Attach VPC policy to CodeBuild role
resource "aws_iam_role_policy" "codebuild_vpc" {
  role = aws_iam_role.codebuild.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeDhcpOptions",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeVpcs"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterfacePermission"
        ]
        Resource = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:network-interface/*"
        Condition = {
          StringEquals = {
            "ec2:Subnet" = [
              for subnet in var.private_subnet_ids : "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:subnet/${subnet}"
            ]
            "ec2:AuthorizedService" = "codebuild.amazonaws.com"
          }
        }
      }
    ]
  })
}

# CloudWatch Logs policy
resource "aws_iam_role_policy" "codebuild_logs" {
  role = aws_iam_role.codebuild.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${var.project_name}*"
      }
    ]
  })
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
