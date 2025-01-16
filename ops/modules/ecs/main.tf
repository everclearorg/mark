resource "aws_ecs_cluster" "main" {
  name = "${var.ecs_cluster_name_prefix}-${var.environment}-${var.stage}"

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}