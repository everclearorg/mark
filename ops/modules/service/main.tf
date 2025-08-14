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

  container_definitions = jsonencode(concat(
    var.init_container_enabled ? [
      {
        name         = "${var.container_family}-init"
        image        = "busybox:latest"
        essential    = false
        command      = var.init_container_commands
        mountPoints = var.volume_name != "" ? [
          {
            sourceVolume  = var.volume_name
            containerPath = var.volume_container_path
          }
        ] : []
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.service.name
            awslogs-region        = var.region
            awslogs-stream-prefix = "init"
          }
        }
      }
    ] : [],
    [
      merge(
        {
          name         = var.container_family
          image        = var.docker_image
          essential    = true
          environment  = concat(var.container_env_vars, [{ name = "DD_SERVICE", value = var.container_family }])
          entrypoint   = var.entrypoint
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
          mountPoints = var.volume_name != "" ? [
            {
              sourceVolume  = var.volume_name
              containerPath = var.volume_container_path
            }
          ] : []
        },
        var.container_user != null ? { user = var.container_user } : {},
        var.init_container_enabled ? {
          dependsOn = [
            {
              containerName = "${var.container_family}-init"
              condition     = "SUCCESS"
            }
          ]
        } : {}
      )
    ],
    [
      {
        name  = "datadog-agent-${var.environment}-${var.stage}-${var.container_family}"
        image = "public.ecr.aws/datadog/agent:7.63.3"
        environment = [
          { name = "DD_API_KEY", value = var.dd_api_key },
          { name = "ECS_FARGATE", value = "true" },
          { name = "DD_APM_ENABLED", value = "true" },
          { name = "DD_TRACE_ENABLED", value = "true" },
          { name = "DD_PROFILING_ENABLED", value = "true" },
          { name = "DD_SITE", value = "datadoghq.com" },
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
    ]
  ))

  dynamic "volume" {
    for_each = var.volume_name != "" ? [1] : []
    content {
      name = var.volume_name
      efs_volume_configuration {
        root_directory = var.volume_efs_path
        file_system_id = var.efs_id
      }
    }
  }

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
    subnets         = var.task_subnets
  }

  dynamic "load_balancer" {
    for_each = var.create_alb ? [1] : []
    content {
      target_group_arn = aws_alb_target_group.front_end[0].arn
      container_name   = var.container_family
      container_port   = var.container_port
    }
  }

  service_registries {
    registry_arn = aws_service_discovery_service.service.arn
  }

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_cloudwatch_log_group.service,
    aws_alb.lb,
    aws_alb_target_group.front_end
  ]
}

resource "aws_alb" "lb" {
  count                      = var.create_alb ? 1 : 0
  name                       = "${var.container_family}-${var.environment}-${var.stage}"
  internal                   = var.internal_lb
  security_groups            = [aws_security_group.lb[0].id]
  subnets                    = var.lb_subnets
  enable_deletion_protection = false
  idle_timeout               = var.timeout
  
  tags = {
    Name        = "${var.container_family}-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_alb_target_group" "front_end" {
  count       = var.create_alb ? 1 : 0
  name        = "${var.container_family}-${var.environment}-${var.stage}"
  port        = var.loadbalancer_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_settings.path
    matcher             = var.health_check_settings.matcher
    interval            = var.health_check_settings.interval
    timeout             = var.health_check_settings.timeout
    healthy_threshold   = var.health_check_settings.healthy_threshold
    unhealthy_threshold = var.health_check_settings.unhealthy_threshold
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_alb.lb]
}

resource "aws_lb_listener" "https" {
  count             = var.create_alb ? 1 : 0
  load_balancer_arn = aws_alb.lb[0].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = var.cert_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.front_end[0].arn
  }

  depends_on = [aws_alb.lb, aws_alb_target_group.front_end]
}

resource "aws_security_group" "lb" {
  count       = var.create_alb ? 1 : 0
  name        = "${var.container_family}-alb-${var.environment}-${var.stage}"
  description = "Controls access to the ALB"
  vpc_id      = var.vpc_id

  # Allow all egress
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.container_family}-alb-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_route53_record" "alb" {
  count   = var.create_alb ? 1 : 0
  zone_id = var.zone_id
  name    = "${var.container_family}.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_alb.lb[0].dns_name
    zone_id               = aws_alb.lb[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_service_discovery_service" "service" {
  name = "${var.container_family}-${var.environment}-${var.stage}"

  dns_config {
    namespace_id = var.private_dns_namespace_id

    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "alb_https" {
  count             = var.create_alb ? 1 : 0
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = var.ingress_cdir_blocks
  security_group_id = aws_security_group.lb[0].id
  description       = "Allow HTTPS inbound traffic"
}

resource "aws_security_group_rule" "alb_to_container" {
  count                    = var.create_alb ? 1 : 0
  type                     = "egress"
  from_port                = var.container_port
  to_port                  = var.container_port
  protocol                 = "tcp"
  source_security_group_id = var.service_security_groups[0]
  security_group_id        = aws_security_group.lb[0].id
  description             = "Allow outbound traffic to container"
}

resource "aws_security_group_rule" "container_from_alb" {
  count                    = var.create_alb ? 1 : 0
  type                     = "ingress"
  from_port                = var.container_port
  to_port                  = var.container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.lb[0].id
  security_group_id        = var.service_security_groups[0]
  description             = "Allow inbound traffic from ALB"
}
