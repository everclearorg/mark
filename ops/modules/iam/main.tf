resource "aws_iam_role" "lambda_role" {
  name = "mark-lambda-role-${var.environment}-${var.stage}"

  assume_role_policy = <<EOF
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Action": "sts:AssumeRole",
        "Principal": {
          "Service": "lambda.amazonaws.com"
        },
        "Effect": "Allow",
        "Sid": ""
      }
    ]
  }
  EOF

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_iam_role_policy_attachment" "lambda_policy_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_role" "vpc_flow_logs" {
  name = "vpc_flow_logs_role"
}

data "aws_region" "current" {}

resource "aws_iam_role_policy" "lambda_ssm_policy" {
  name = "mark-lambda-ssm-policy-${var.environment}-${var.stage}"
  role = aws_iam_role.lambda_role.id

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeParameters",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": "*"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "lambda_s3_policy" {
  name = "mark-lambda-s3-policy-${var.environment}-${var.stage}"
  role = aws_iam_role.lambda_role.id

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::*-rebalance-config",
        "arn:aws:s3:::*-rebalance-config/*"
      ]
    }
  ]
}
EOF
}

# ECS Task Role - for application-level AWS API calls (SSM, S3, etc.)
resource "aws_iam_role" "ecs_task_role" {
  name = "mark-ecs-task-role-${var.environment}-${var.stage}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_iam_role_policy" "ecs_task_ssm_policy" {
  name = "mark-ecs-task-ssm-policy-${var.environment}-${var.stage}"
  role = aws_iam_role.ecs_task_role.id

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeParameters",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "ssm.${data.aws_region.current.name}.amazonaws.com"
        }
      }
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "ecs_task_s3_policy" {
  name = "mark-ecs-task-s3-policy-${var.environment}-${var.stage}"
  role = aws_iam_role.ecs_task_role.id

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::*-rebalance-config",
        "arn:aws:s3:::*-rebalance-config/*"
      ]
    }
  ]
}
EOF
}
