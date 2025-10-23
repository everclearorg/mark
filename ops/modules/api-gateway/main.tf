resource "aws_api_gateway_rest_api" "admin_api" {
  name        = "${var.bot_name}-admin-api-${var.environment}-${var.stage}"
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

resource "aws_api_gateway_resource" "pause_ondemand_rebalance" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.pause.id
  path_part   = "ondemand-rebalance"
}

resource "aws_api_gateway_resource" "unpause_ondemand_rebalance" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.unpause.id
  path_part   = "ondemand-rebalance"
}

resource "aws_api_gateway_resource" "rebalance" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_rest_api.admin_api.root_resource_id
  path_part   = "rebalance"
}

resource "aws_api_gateway_resource" "rebalance_earmarks" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance.id
  path_part   = "earmarks"
}

resource "aws_api_gateway_resource" "rebalance_operations" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance.id
  path_part   = "operations"
}

resource "aws_api_gateway_resource" "rebalance_earmark" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance.id
  path_part   = "earmark"
}

resource "aws_api_gateway_resource" "rebalance_earmark_id" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance_earmark.id
  path_part   = "{id}"
}

resource "aws_api_gateway_resource" "rebalance_cancel" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance.id
  path_part   = "cancel"
}

resource "aws_api_gateway_resource" "rebalance_operation" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance.id
  path_part   = "operation"
}

resource "aws_api_gateway_resource" "rebalance_operation_cancel" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance_operation.id
  path_part   = "cancel"
}

resource "aws_api_gateway_resource" "rebalance_operation_id" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.rebalance_operation.id
  path_part   = "{id}"
}

resource "aws_api_gateway_resource" "trigger" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_rest_api.admin_api.root_resource_id
  path_part   = "trigger"
}

resource "aws_api_gateway_resource" "trigger_send" {
  rest_api_id = aws_api_gateway_rest_api.admin_api.id
  parent_id   = aws_api_gateway_resource.trigger.id
  path_part   = "send"
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

resource "aws_api_gateway_method" "pause_ondemand_rebalance_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.pause_ondemand_rebalance.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

resource "aws_api_gateway_method" "unpause_ondemand_rebalance_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.unpause_ondemand_rebalance.id
  http_method   = "POST"
  authorization = "NONE" # Consider using AWS_IAM for authentication
}

resource "aws_api_gateway_method" "rebalance_earmarks_get" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_earmarks.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "rebalance_operations_get" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_operations.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "rebalance_earmark_id_get" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_earmark_id.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "rebalance_operation_id_get" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_operation_id.id
  http_method   = "GET"
  authorization = "NONE"
}

# POST method for cancel endpoint
resource "aws_api_gateway_method" "rebalance_cancel_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_cancel.id
  http_method   = "POST"
  authorization = "NONE"
}

# POST method for operation cancel endpoint
resource "aws_api_gateway_method" "rebalance_operation_cancel_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.rebalance_operation_cancel.id
  http_method   = "POST"
  authorization = "NONE"
}

# POST method for trigger send endpoint
resource "aws_api_gateway_method" "trigger_send_post" {
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  resource_id   = aws_api_gateway_resource.trigger_send.id
  http_method   = "POST"
  authorization = "NONE"
}

# Create Lambda function for admin API
resource "aws_lambda_function" "admin_api" {
  function_name = "${var.bot_name}-admin-api-${var.environment}-${var.stage}"
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
    variables = merge(var.container_env_vars, { DD_SERVICE = "${var.bot_name}-admin" })
  }
}

# Create CloudWatch log group for Lambda
resource "aws_cloudwatch_log_group" "admin_api" {
  name              = "/aws/lambda/${var.bot_name}-admin-api-${var.environment}-${var.stage}"
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

resource "aws_api_gateway_integration" "pause_ondemand_rebalance_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.pause_ondemand_rebalance.id
  http_method             = aws_api_gateway_method.pause_ondemand_rebalance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "unpause_ondemand_rebalance_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.unpause_ondemand_rebalance.id
  http_method             = aws_api_gateway_method.unpause_ondemand_rebalance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_earmarks_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_earmarks.id
  http_method             = aws_api_gateway_method.rebalance_earmarks_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_operations_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_operations.id
  http_method             = aws_api_gateway_method.rebalance_operations_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_earmark_id_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_earmark_id.id
  http_method             = aws_api_gateway_method.rebalance_earmark_id_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_operation_id_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_operation_id.id
  http_method             = aws_api_gateway_method.rebalance_operation_id_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_cancel_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_cancel.id
  http_method             = aws_api_gateway_method.rebalance_cancel_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "rebalance_operation_cancel_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.rebalance_operation_cancel.id
  http_method             = aws_api_gateway_method.rebalance_operation_cancel_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin_api.invoke_arn
}

resource "aws_api_gateway_integration" "trigger_send_integration" {
  rest_api_id             = aws_api_gateway_rest_api.admin_api.id
  resource_id             = aws_api_gateway_resource.trigger_send.id
  http_method             = aws_api_gateway_method.trigger_send_post.http_method
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
    aws_api_gateway_integration.pause_ondemand_rebalance_integration,
    aws_api_gateway_integration.unpause_purchase_integration,
    aws_api_gateway_integration.unpause_rebalance_integration,
    aws_api_gateway_integration.unpause_ondemand_rebalance_integration,
    aws_api_gateway_integration.rebalance_earmarks_integration,
    aws_api_gateway_integration.rebalance_operations_integration,
    aws_api_gateway_integration.rebalance_earmark_id_integration,
    aws_api_gateway_integration.rebalance_operation_id_integration,
    aws_api_gateway_integration.rebalance_cancel_integration,
    aws_api_gateway_integration.rebalance_operation_cancel_integration,
    aws_api_gateway_integration.trigger_send_integration
  ]

  rest_api_id = aws_api_gateway_rest_api.admin_api.id

  triggers = {
    # Redeploy when the Lambda function or its configuration changes
    redeployment = sha1(jsonencode([
      aws_lambda_function.admin_api.last_modified,
      aws_lambda_function.admin_api.source_code_hash,
      aws_lambda_function.admin_api.environment,
      # Auto-track all API configuration changes
      filemd5("${path.module}/main.tf")
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Custom domain configuration for stable endpoint
resource "aws_api_gateway_domain_name" "admin_api" {
  domain_name              = "admin-${var.bot_name}.${var.domain}"
  regional_certificate_arn = var.certificate_arn

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_stage" "admin_api" {
  deployment_id = aws_api_gateway_deployment.admin_api.id
  rest_api_id   = aws_api_gateway_rest_api.admin_api.id
  stage_name    = var.stage
}

# Map custom domain to API Gateway stage
resource "aws_api_gateway_base_path_mapping" "admin_api" {
  api_id      = aws_api_gateway_rest_api.admin_api.id
  stage_name  = aws_api_gateway_stage.admin_api.stage_name
  domain_name = aws_api_gateway_domain_name.admin_api.domain_name
}

# Create Route 53 record for custom domain
resource "aws_route53_record" "admin_api" {
  name    = aws_api_gateway_domain_name.admin_api.domain_name
  type    = "A"
  zone_id = var.zone_id

  alias {
    evaluate_target_health = true
    name                   = aws_api_gateway_domain_name.admin_api.regional_domain_name
    zone_id                = aws_api_gateway_domain_name.admin_api.regional_zone_id
  }
}
