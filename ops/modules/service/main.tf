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
  network_mode            = "awsvpc"
  cpu                     = var.cpu
  memory                  = var.memory
  execution_role_arn      = var.execution_role_arn

  container_definitions = jsonencode([
    {
      name         = var.container_family
      image        = var.docker_image
      essential    = true
      environment  = var.container_env_vars
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = "/ecs/${var.container_family}-${var.environment}-${var.stage}"
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
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