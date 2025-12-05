# Fetch password from SSM if parameter name is provided
data "aws_ssm_parameter" "db_password" {
  count           = var.password_ssm_parameter != "" ? 1 : 0
  name            = var.password_ssm_parameter
  with_decryption = true
}

# Use SSM password if available, otherwise use the provided password
locals {
  db_password = var.password_ssm_parameter != "" ? data.aws_ssm_parameter.db_password[0].value : var.password
}

resource "aws_db_instance" "db" {
  identifier = var.identifier

  engine            = "postgres"
  engine_version    = var.engine_version
  instance_class    = var.instance_class
  allocated_storage = var.allocated_storage

  db_name  = var.db_name
  username = var.username
  password = local.db_password
  port     = var.port

  vpc_security_group_ids = var.vpc_security_group_ids
  db_subnet_group_name   = aws_db_subnet_group.default.name

  allow_major_version_upgrade = false
  auto_minor_version_upgrade  = false
  apply_immediately           = true

  skip_final_snapshot     = true
  backup_retention_period = 5
  backup_window           = "03:00-06:00"
  maintenance_window      = var.maintenance_window

  publicly_accessible = var.publicly_accessible

  tags = merge(
    var.tags,
    {
      "Name" = format("%s", var.identifier)
    },
  )

  timeouts {
    create = "40m"
    update = "80m"
    delete = "40m"
  }
}

resource "aws_db_subnet_group" "default" {
  name       = "${var.identifier}-subnet-group"
  subnet_ids = var.db_subnet_group_subnet_ids

  tags = merge(
    var.tags,
    {
      "Name" = format("%s-subnet-group", var.identifier)
    },
  )
}
