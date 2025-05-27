resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.container_family}-${var.environment}-${var.stage}"
  retention_in_days = 14

  tags = {
    Environment = var.environment
    Stage       = var.stage
  }
}

resource "aws_lambda_function" "function" {
  function_name = "${var.container_family}-${var.environment}-${var.stage}"
  role          = var.execution_role_arn
  
  package_type = "Image"
  image_uri    = var.image_uri
  
  memory_size = var.memory_size
  timeout     = var.timeout
  reserved_concurrent_executions = 1

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_id]
  }

  environment {
    variables = merge(var.container_env_vars, { DD_SERVICE = var.container_family })
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = "${var.container_family}-${var.environment}-${var.stage}-schedule"
  description         = "Schedule for Lambda Function"
  schedule_expression = var.schedule_expression
}

resource "aws_cloudwatch_event_target" "schedule_target" {
  rule      = aws_cloudwatch_event_rule.schedule.name
  target_id = "lambda"
  arn       = aws_lambda_function.function.arn
}

resource "aws_lambda_permission" "allow_events_bridge_to_run_lambda" {
  statement_id  = "AllowExecutionFromEventsBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}