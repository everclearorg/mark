#!/bin/bash
# ============================================================================
# POLLER REMOVAL SCRIPT
# ============================================================================
# This script removes the main poller Lambda function (mark_poller) before
# deploying invoice handler. Other poller Lambdas (solana_usdc_poller,
# poller_tac_only, poller_meth_only) are NOT removed as they remain active.
# 
# IMPORTANT: This script is temporary and should be removed once the poller
# migration is complete.
# 
# To remove this script and its usage:
# 1. Search for "remove-poller-lambda.sh" in CI workflows and Terraform configs
# 2. Remove all references to this script
# 3. Delete this file
# ============================================================================

set -euo pipefail

BOT_NAME="${1:-mason}"
ENVIRONMENT="${2:-mainnet}"
STAGE="${3:-staging}"
AWS_REGION="${4:-sa-east-1}"

echo "============================================================================"
echo "REMOVING MAIN POLLER LAMBDA FUNCTION"
echo "============================================================================"
echo "Bot Name: ${BOT_NAME}"
echo "Environment: ${ENVIRONMENT}"
echo "Stage: ${STAGE}"
echo "Region: ${AWS_REGION}"
echo ""
echo "NOTE: Only removing ${BOT_NAME}-poller (main poller)"
echo "      Other pollers (tac, meth, solana) will remain active"
echo "============================================================================"

# Only remove the main poller Lambda function
# Other pollers (tac, meth, solana) remain active
POLLER_FUNCTIONS=(
  "${BOT_NAME}-poller-${ENVIRONMENT}-${STAGE}"
)

# Function to check if Lambda exists
lambda_exists() {
  local function_name="$1"
  aws lambda get-function \
    --function-name "${function_name}" \
    --region "${AWS_REGION}" \
    >/dev/null 2>&1
}

# Function to remove Lambda function
remove_lambda() {
  local function_name="$1"
  
  if lambda_exists "${function_name}"; then
    echo "Removing Lambda function: ${function_name}"
    
    # Remove EventBridge rule targets first
    echo "  Removing EventBridge rule targets..."
    local rules=$(aws events list-rules \
      --region "${AWS_REGION}" \
      --query "Rules[?contains(Targets[].Arn, '${function_name}')].Name" \
      --output text 2>/dev/null || echo "")
    
    if [ -n "${rules}" ]; then
      for rule in ${rules}; do
        echo "    Removing targets from rule: ${rule}"
        aws events remove-targets \
          --rule "${rule}" \
          --ids "lambda" \
          --region "${AWS_REGION}" \
          >/dev/null 2>&1 || true
      done
    fi
    
    # Remove Lambda function
    echo "  Deleting Lambda function..."
    aws lambda delete-function \
      --function-name "${function_name}" \
      --region "${AWS_REGION}" \
      >/dev/null 2>&1 || true
    
    echo "  ✓ Successfully removed: ${function_name}"
  else
    echo "  ⊘ Lambda function does not exist: ${function_name} (skipping)"
  fi
}

# Remove all poller Lambda functions
for function_name in "${POLLER_FUNCTIONS[@]}"; do
  remove_lambda "${function_name}"
done

echo ""
echo "============================================================================"
echo "POLLER REMOVAL COMPLETE"
echo "============================================================================"
