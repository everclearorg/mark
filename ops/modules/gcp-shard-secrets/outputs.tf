output "secret_ids" {
  description = "Map of secret names to their full GCP secret IDs"
  value = {
    for k, v in google_secret_manager_secret.share2 : k => v.secret_id
  }
}

output "secret_names" {
  description = "Map of secret names to their full GCP resource names"
  value = {
    for k, v in google_secret_manager_secret.share2 : k => v.name
  }
}

output "service_account_email" {
  description = "Email of the service account for accessing secrets"
  value       = google_service_account.shamir_reader.email
}

output "workload_identity_pool_id" {
  description = "ID of the workload identity pool for AWS federation"
  value       = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id
}

output "workload_identity_pool_provider_id" {
  description = "ID of the workload identity pool provider"
  value       = google_iam_workload_identity_pool_provider.aws_provider.workload_identity_pool_provider_id
}

output "workload_identity_pool_name" {
  description = "Full name of the workload identity pool"
  value       = google_iam_workload_identity_pool.aws_pool.name
}

output "gcp_project_id" {
  description = "GCP project ID where secrets are stored"
  value       = var.gcp_project_id
}

output "manifest_entries" {
  description = "Pre-formatted manifest entries for each secret"
  value = {
    for k, v in google_secret_manager_secret.share2 : k => {
      gcpSecretRef = {
        project  = var.gcp_project_id
        secretId = v.secret_id
      }
      method = "shamir"
    }
  }
}
