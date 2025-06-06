resource "aws_api_gateway_rest_api" "admin_api" {
  name        = "mark-admin-api-${var.environment}-${var.stage}"
  description = "Mark Admin API"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# Create API resources
resource "aws_api_gateway_resource" "pause" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_rest_api.admin_api.root_resource_id
  path_part   = "pause"
}

resource "aws_api_gateway_resource" "unpause" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_rest_api.admin_api.root_resource_id
  path_part   = "unpause"
}

resource "aws_api_gateway_resource" "pause_purchase" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.pause.id
  path_part   = "purchase"
}

resource "aws_api_gateway_resource" "pause_rebalance" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.pause.id
  path_part   = "rebalance"
}

resource "aws_api_gateway_resource" "unpause_purchase" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.unpause.id
  path_part   = "purchase"
}

resource "aws_api_gateway_resource" "unpause_rebalance" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.unpause.id
  path_part   = "rebalance"
}

# Create POST methods for each endpoint
resource "aws_api_gateway_method" "pause_purchase_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.pause_purchase.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

resource "aws_api_gateway_method" "pause_rebalance_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.pause_rebalance.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

resource "aws_api_gateway_method" "unpause_purchase_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.unpause_purchase.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

resource "aws_api_gateway_method" "unpause_rebalance_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.unpause_rebalance.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

# Create Lambda function for admin API
resource "aws_lambda_function" "admin_api" {
  function_name = "mark-admin-api-${var.environment}-${var.stage}"
  role          = var.execution_role_arn
  
  package_type = "Image"
  image_uri    = var.image_uri
  
  memory_size = var.memory_size
  timeout     = var.timeout

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_id]
  }

  environment {
    variables = merge(var.container_env_vars, { DD_SERVICE = "mark-admin" })
  }
}

# Create CloudWatch log group for Lambda
resource "aws_cloudwatch_log_group" "admin_api" {
  name              = "/aws/lambda/mark-admin-api-${var.environment}-${var.stage}"
  retention_in_days = 14

  tags = {
    Environment = var.environment
    Stage       = var.stage
  }
}

# Link Lambda function to API Gateway endpoints
resource "aws_api_gateway_integration" "pause_purchase_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.pause_purchase.id
  http_method             = aws_api_gateway_method.pause_purchase_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "pause_rebalance_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.pause_rebalance.id
  http_method             = aws_api_gateway_method.pause_rebalance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "unpause_purchase_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.unpause_purchase.id
  http_method             = aws_api_gateway_method.unpause_purchase_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "unpause_rebalance_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.unpause_rebalance.id
  http_method             = aws_api_gateway_method.unpause_rebalance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

# Allow API Gateway to invoke Lambda
resource "aws_lambda_permission" "api_gateway_lambda" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.admin_api.execution_arn}/*/*/*"
}

# Deploy the API
resource "aws_api_gateway_deployment" "admin_api" {
  depends_on = [
    aws_api_gateway_integration.pause_purchase_integration,
    aws_api_gateway_integration.pause_rebalance_integration,
    aws_api_gateway_integration.unpause_purchase_integration,
    aws_api_gateway_integration.unpause_rebalance_integration
  ]

  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  stage_name  = var.stage

  lifecycle {
    create_before_destroy = true
  }
} 