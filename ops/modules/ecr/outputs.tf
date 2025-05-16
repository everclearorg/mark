output "mark_poller_repository_url" {
  description = "URL of the Mark Poller ECR repository"
  value       = aws_ecr_repository.mark_poller.repository_url
}

output "mark_admin_repository_url" {
  description = "URL of the Mark Admin API ECR repository"
  value       = aws_ecr_repository.mark_admin.repository_url
}