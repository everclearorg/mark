output "db_instance_address" {
  description = "The address of the RDS instance"
  value       = aws_db_instance.db.address
}

output "db_instance_id" {
  description = "The ID of the RDS instance"
  value       = aws_db_instance.db.id
}

output "db_instance_identifier" {
  description = "The instance identifier of the RDS instance"
  value       = aws_db_instance.db.identifier
}

output "db_instance_endpoint" {
  description = "The connection endpoint"
  value       = aws_db_instance.db.endpoint
}

output "db_instance_name" {
  description = "The database name"
  value       = aws_db_instance.db.db_name
}

output "db_instance_username" {
  description = "The master username for the database"
  value       = aws_db_instance.db.username
  sensitive   = true
}

output "db_instance_port" {
  description = "The database port"
  value       = aws_db_instance.db.port
}

output "db_subnet_group_name" {
  description = "The name of the RDS instance's subnet group"
  value       = aws_db_instance.db.db_subnet_group_name
}

output "database_url" {
  description = "PostgreSQL connection URL"
  value       = "postgresql://${aws_db_instance.db.username}:${aws_db_instance.db.password}@${aws_db_instance.db.endpoint}/${aws_db_instance.db.db_name}?sslmode=require"
  sensitive   = true
}
