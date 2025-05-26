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

# Create mount targets in each subnet
resource "aws_efs_mount_target" "mark" {
  count           = length(var.subnet_ids)
  file_system_id  = aws_efs_file_system.mark.id
  subnet_id       = var.subnet_ids[count.index]
  security_groups = [var.efs_security_group_id]
}