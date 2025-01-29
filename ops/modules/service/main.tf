resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${var.container_family}-${var.environment}-${var.stage}"
  retention_in_days = 14

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_ecs_task_definition" "service" {
  family                   = "${var.container_family}-${var.environment}-${var.stage}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name         = var.container_family
      image        = var.docker_image
      essential    = true
      environment  = concat(var.container_env_vars, [{ name = "DD_SERVICE", value = var.container_family }])
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awsfirelens"
        options = {
          Name       = "datadog"
          apiKey     = var.dd_api_key
          dd_service = var.container_family
          dd_source  = "fargate-app"
          dd_tags    = "env:${var.environment}-${var.stage},domain:${var.domain},environment:${var.environment},stage:${var.stage},service:${var.container_family}"
          TLS        = "on"
          provider   = "ecs"
        }
      }
    },
    {
      name  = "datadog-agent-${var.environment}-${var.stage}-${var.container_family}"
      image = "public.ecr.aws/datadog/agent:7.40.1"
      environment = [
        { name = "DD_API_KEY", value = var.dd_api_key },
        { name = "ECS_FARGATE", value = "true" },
        { name = "DD_APM_ENABLED", value = "true" },
        { name = "DD_DOGSTATSD_NON_LOCAL_TRAFFIC", value = "true" },
        { name = "DD_APM_NON_LOCAL_TRAFFIC", value = "true" },
        { name = "DD_PROCESS_AGENT_ENABLED", value = "true" },
        { name = "DD_TRACE_ANALYTICS_ENABLED", value = "true" },
        { name = "DD_RUNTIME_METRICS_ENABLED", value = "true" },
        { name = "DD_LOGS_INJECTION", value = "true" }
      ]

      port_mappings = [
        {
          containerPort = 8126
          hostPort      = 8126
          protocol      = "tcp"
        },
        {
          containerPort = 8125
          hostPort      = 8125
          protocol      = "udp"
        }
      ]
    },
    {
      name  = "fluent-bit-agent-${var.environment}-${var.stage}-${var.container_family}"
      image = "public.ecr.aws/aws-observability/aws-for-fluent-bit:2.28.4"
      firelensConfiguration = {
        type = "fluentbit"
        options = {
          enable-ecs-log-metadata = "true"
          config-file-type        = "file"
          config-file-value       = "/fluent-bit/configs/parse-json.conf"
        }
      }
    }
  ])

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }

  depends_on = [aws_cloudwatch_log_group.service]
}

resource "aws_ecs_service" "service" {
  name            = "${var.container_family}-${var.environment}-${var.stage}"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.service.arn
  desired_count   = var.instance_count
  launch_type     = "FARGATE"

  network_configuration {
    security_groups = var.service_security_groups
    subnets         = var.lb_subnets
  }

  service_registries {
    registry_arn = aws_service_discovery_service.web3signer.arn
  }

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_service_discovery_private_dns_namespace" "namespace" {
  name        = "mark.internal"
  vpc         = var.vpc_id
  description = "Private DNS namespace for mark services"
}

resource "aws_service_discovery_service" "web3signer" {
  name = "${var.container_family}-${var.environment}-${var.stage}"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.namespace.id

    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}
