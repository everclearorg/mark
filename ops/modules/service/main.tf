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
  # security_groups            = concat([aws_security_group.lb[0].id], var.service_security_groups)
  security_groups            = var.service_security_groups
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
    path     = var.health_check_path
    matcher  = "200,302"
    interval = var.timeout + 10
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

  # Allow HTTPS ingress
  ingress {
    protocol         = "tcp"
    from_port        = 443
    to_port          = 443
    cidr_blocks      = var.ingress_cdir_blocks
    ipv6_cidr_blocks = var.ingress_ipv6_cdir_blocks
  }

  # Allow HTTP ingress
  ingress {
    protocol         = "tcp"
    from_port        = var.loadbalancer_port
    to_port          = var.container_port
    cidr_blocks      = var.ingress_cdir_blocks
    ipv6_cidr_blocks = var.ingress_ipv6_cdir_blocks
  }

  # Allow all egress
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.allow_all_cdir_blocks
  }

  tags = {
    Name        = "${var.container_family}-alb-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_route53_record" "prometheus" {
  count   = var.create_alb ? 1 : 0
  zone_id = var.zone_id
  name    = "mark-prometheus.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_alb.lb[0].dns_name
    zone_id               = aws_alb.lb[0].zone_id
    evaluate_target_health = true
  }
}

data "aws_service_discovery_dns_namespace" "namespace" {
  name = "mark.internal"
  type = "DNS_PRIVATE"
}

resource "aws_service_discovery_service" "service" {
  name = "${var.container_family}-${var.environment}-${var.stage}"

  dns_config {
    namespace_id = data.aws_service_discovery_dns_namespace.namespace.id

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
