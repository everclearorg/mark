# GCP Shard Secrets Module

This Terraform module creates GCP Secret Manager secrets for storing Shamir Share 2 values, along with the necessary IAM configuration for AWS → GCP cross-cloud authentication.

## Features

- Creates GCP secrets with proper labeling and lifecycle protection
- Sets up Workload Identity Federation for AWS IAM roles to access GCP secrets
- Configures audit logging for compliance
- Outputs pre-formatted manifest entries for easy integration

## Usage

```hcl
module "gcp_shard_secrets" {
  source = "../../modules/gcp-shard-secrets"

  gcp_project_id = "everclear-prod"
  environment    = "mainnet"
  stage          = "production"
  service_name   = "mark"
  aws_account_id = "123456789012"
  aws_role_name  = "mark-ecs-task-role"

  secrets = {
    web3-signer-pk = {
      description = "Web3 signer private key share 2"
    }
    solana-pk = {
      description = "Solana private key share 2"
    }
    ton-mnemonic = {
      description = "TON mnemonic share 2"
    }
  }
}

# Use the outputs to construct the shard manifest
output "shard_manifest" {
  value = {
    version = "1.0"
    shardedFields = [
      {
        path         = "web3_signer_private_key"
        gcpSecretRef = module.gcp_shard_secrets.manifest_entries["web3-signer-pk"].gcpSecretRef
        method       = "shamir"
      },
      {
        path         = "solana.privateKey"
        gcpSecretRef = module.gcp_shard_secrets.manifest_entries["solana-pk"].gcpSecretRef
        method       = "shamir"
      }
    ]
  }
}
```

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|----------|
| gcp_project_id | GCP project ID for storing secrets | string | - | yes |
| environment | Environment name (mainnet, testnet) | string | - | yes |
| stage | Deployment stage | string | "production" | no |
| service_name | Name of the service (mark, mandy) | string | - | yes |
| aws_account_id | AWS account ID for Workload Identity | string | - | yes |
| aws_role_name | AWS IAM role name | string | "ecs-task-role" | no |
| secrets | Map of secret configurations | map(object) | {} | no |

## Outputs

| Name | Description |
|------|-------------|
| secret_ids | Map of secret names to GCP secret IDs |
| service_account_email | Email of the reader service account |
| workload_identity_pool_id | ID of the workload identity pool |
| manifest_entries | Pre-formatted manifest entries for each secret |

## Authentication Flow

1. AWS ECS task assumes its IAM role
2. Task uses role credentials to get a federated token from GCP
3. GCP validates the AWS STS token via Workload Identity Federation
4. GCP issues a short-lived access token for the service account
5. Service account accesses Secret Manager

## Secret Rotation

After creating secrets with Terraform, populate them using the CLI:

```bash
# Generate and store shares
npx ts-node scripts/shamir-split-secret.ts \
  --secret "0xactual_private_key" \
  --aws-param "/mark/web3_signer_pk_share1" \
  --gcp-project "everclear-prod" \
  --gcp-secret "mark-mainnet-web3-signer-pk-share2"
```

## Security Considerations

- Secrets have `prevent_destroy = true` lifecycle rule
- Audit logging is enabled for all secret access
- Workload Identity Federation restricts access to specific AWS roles
- Service account has minimal permissions (secretAccessor only)
