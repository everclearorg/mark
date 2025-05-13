resource "aws_efs_file_system" "mark" {
  creation_token = "mark-efs-${var.environment}-${var.stage}"
  performance_mode = "generalPurpose"
  throughput_mode = "elastic"

  tags = {
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}