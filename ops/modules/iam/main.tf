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
