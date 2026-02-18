/**
 * GCP Secret Manager module for Shamir Share 2 storage
 * 
 * This module creates:
 * 1. GCP secrets for storing Shamir Share 2 values
 * 2. Service account for AWS workloads to access secrets
 * 3. Workload Identity Federation for AWS → GCP authentication
 */

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# ============================================================================
# Local values
# ============================================================================
locals {
  secret_prefix = "${var.service_name}-${var.environment}"
  common_labels = {
    environment = var.environment
    stage       = var.stage
    service     = var.service_name
    purpose     = "shamir-share-2"
    method      = "shamir-2-of-2"
    managed-by  = "terraform"
  }
}

# ============================================================================
# GCP Secrets
# ============================================================================
resource "google_secret_manager_secret" "share2" {
  for_each = var.secrets

  project   = var.gcp_project_id
  secret_id = "${local.secret_prefix}-${each.key}-share2"

  replication {
    auto {}
  }

  labels = merge(local.common_labels, each.value.labels)

  lifecycle {
    prevent_destroy = true
  }
}

# ============================================================================
# Service Account for AWS access
# ============================================================================
resource "google_service_account" "shamir_reader" {
  project      = var.gcp_project_id
  account_id   = "${var.service_name}-shamir-reader"
  display_name = "${title(var.service_name)} Shamir Share Reader"
  description  = "Service account for AWS ${var.service_name} service to read Shamir Share 2 secrets"
}

# Grant secret accessor role to the service account
resource "google_secret_manager_secret_iam_member" "share2_access" {
  for_each = google_secret_manager_secret.share2

  project   = var.gcp_project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shamir_reader.email}"
}

# ============================================================================
# Workload Identity Federation for AWS
# ============================================================================
resource "google_iam_workload_identity_pool" "aws_pool" {
  project                   = var.gcp_project_id
  workload_identity_pool_id = "${var.service_name}-aws-pool"
  display_name              = "${title(var.service_name)} AWS Workload Pool"
  description               = "Identity pool for AWS ${var.service_name} workloads to access GCP resources"
}

resource "google_iam_workload_identity_pool_provider" "aws_provider" {
  project                            = var.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.aws_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "aws-${var.environment}"
  display_name                       = "AWS ${title(var.environment)} Provider"

  aws {
    account_id = var.aws_account_id
  }

  attribute_mapping = {
    "google.subject"        = "assertion.arn"
    "attribute.aws_role"    = "assertion.arn.extract('assumed-role/{role}/')"
    "attribute.aws_account" = "assertion.account"
  }

  attribute_condition = "attribute.aws_role == '${var.aws_role_name}'"
}

# Allow federated identity to impersonate the service account
resource "google_service_account_iam_member" "workload_identity_binding" {
  service_account_id = google_service_account.shamir_reader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.aws_pool.name}/attribute.aws_account/${var.aws_account_id}"
}

# ============================================================================
# IAM audit logging (for compliance)
# ============================================================================
resource "google_project_iam_audit_config" "secret_manager_audit" {
  project = var.gcp_project_id
  service = "secretmanager.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
