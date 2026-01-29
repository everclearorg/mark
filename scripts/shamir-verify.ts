#!/usr/bin/env npx ts-node

/**
 * CLI Tool for verifying Shamir share reconstruction
 *
 * SECURITY WARNING: This tool handles sensitive cryptographic material.
 * - Never run in environments where terminal output is logged
 * - Clear terminal history after use
 *
 * Usage:
 *   npx ts-node scripts/shamir-verify.ts --help
 *
 * Examples:
 *   # Verify shares stored in AWS and GCP (recommended)
 *   npx ts-node scripts/shamir-verify.ts \
 *     --aws-param "/mark/web3_signer_pk_share1" \
 *     --gcp-project "everclear-prod" \
 *     --gcp-secret "mark-web3-signer-pk-share2"
 *
 *   # Verify raw share values directly
 *   npx ts-node scripts/shamir-verify.ts \
 *     --share1 "801abc..." \
 *     --share2 "802def..."
 */

async function main() {
  const { shamirReconstructPair, parseShare, isValidShare } = await import(
    '../packages/core/src/shard/shamir'
  );

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('🔐 Shamir Share Verification');
  console.log('============================\n');

  let share1: string;
  let share2: string;

  // Mode 1: Fetch from cloud providers
  if (args.awsParam && args.gcpProject && args.gcpSecret) {
    console.log('Fetching shares from cloud providers...\n');

    // Fetch Share 1 from AWS SSM
    console.log(`Fetching Share 1 from AWS SSM: ${args.awsParam}`);
    try {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const ssmClient = new SSMClient({ region: args.awsRegion || 'us-east-1' });

      const response = await ssmClient.send(
        new GetParameterCommand({
          Name: args.awsParam,
          WithDecryption: true,
        })
      );

      if (!response.Parameter?.Value) {
        console.error('❌ Share 1 not found in AWS SSM');
        process.exit(1);
      }

      share1 = response.Parameter.Value;
      console.log('✓ Retrieved Share 1 from AWS SSM');
    } catch (error) {
      console.error(`❌ Failed to fetch from AWS SSM: ${(error as Error).message}`);
      process.exit(1);
    }

    // Fetch Share 2 from GCP Secret Manager
    console.log(`Fetching Share 2 from GCP: ${args.gcpProject}/${args.gcpSecret}`);
    try {
      const { getGcpSecret } = await import('../packages/core/src/shard/gcp-secret-manager');
      share2 = await getGcpSecret(args.gcpProject, args.gcpSecret);
      console.log('✓ Retrieved Share 2 from GCP Secret Manager\n');
    } catch (error) {
      console.error(`❌ Failed to fetch from GCP: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  // Mode 2: Use raw share values
  else if (args.share1 && args.share2) {
    share1 = args.share1;
    share2 = args.share2;
    console.log('Using provided share values...\n');
  }
  // Invalid arguments
  else {
    console.error('Error: Must provide either:');
    console.error('  1. Cloud references: --aws-param, --gcp-project, --gcp-secret');
    console.error('  2. Raw shares: --share1, --share2');
    console.error('\nRun with --help for more information.');
    process.exit(1);
  }

  // Validate shares
  console.log('Validating shares...');

  if (!isValidShare(share1)) {
    console.error('❌ Share 1 is invalid or corrupted');
    process.exit(1);
  }
  const parsed1 = parseShare(share1);
  // SECURITY: Only log metadata, never share content
  console.log(`✓ Share 1: index=${parsed1.index}, length=${share1.length} hex chars`);

  if (!isValidShare(share2)) {
    console.error('❌ Share 2 is invalid or corrupted');
    process.exit(1);
  }
  const parsed2 = parseShare(share2);
  console.log(`✓ Share 2: index=${parsed2.index}, length=${share2.length} hex chars`);

  if (parsed1.index === parsed2.index) {
    console.error('❌ Error: Both shares have the same index. They must be different shares.');
    process.exit(1);
  }

  if (parsed1.data.length !== parsed2.data.length) {
    console.warn('⚠️  Warning: Shares have different data lengths. This may indicate corruption.');
  }

  // Reconstruct
  console.log('\nReconstructing secret...');
  try {
    const secret = shamirReconstructPair(share1, share2);
    console.log('✓ Successfully reconstructed secret!\n');

    // Basic validation
    console.log(`Secret length: ${secret.length} characters`);

    // Detect secret type
    if (secret.startsWith('0x') && /^0x[a-fA-F0-9]+$/.test(secret)) {
      console.log('Secret type: Hex-encoded (likely private key)');
    } else if (/^[a-zA-Z]+(\s+[a-zA-Z]+)+$/.test(secret)) {
      console.log('Secret type: Word list (likely mnemonic)');
    } else if (/^[A-Za-z0-9+/=]+$/.test(secret)) {
      console.log('Secret type: Base64-encoded');
    } else {
      console.log('Secret type: Unknown format');
    }

    // SECURITY: Only show secret if explicitly requested
    if (args.showSecret) {
      console.warn('\n⚠️  SECURITY WARNING: Displaying secret in terminal.');
      console.warn('   Ensure terminal output is not being logged.\n');
      console.log('=== Reconstructed Secret ===');
      console.log(secret);
      console.log('============================');
    } else {
      console.log('\n✓ Verification complete. Secret NOT displayed (use --show-secret if needed).');
    }

    console.log('\n🎉 Share verification successful!');
  } catch (error) {
    console.error('❌ Reconstruction failed:', (error as Error).message);
    console.error('\nPossible causes:');
    console.error('  - Shares are from different secrets');
    console.error('  - Shares are corrupted');
    console.error('  - Shares were generated with incompatible settings');
    process.exit(1);
  }
}

interface Args {
  // Cloud mode
  awsParam?: string;
  awsRegion?: string;
  gcpProject?: string;
  gcpSecret?: string;
  // Raw mode
  share1?: string;
  share2?: string;
  // Options
  showSecret?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      // Cloud mode
      case '--aws-param':
        args.awsParam = nextArg;
        i++;
        break;
      case '--aws-region':
        args.awsRegion = nextArg;
        i++;
        break;
      case '--gcp-project':
        args.gcpProject = nextArg;
        i++;
        break;
      case '--gcp-secret':
        args.gcpSecret = nextArg;
        i++;
        break;
      // Raw mode
      case '--share1':
      case '-1':
        args.share1 = nextArg;
        i++;
        break;
      case '--share2':
      case '-2':
        args.share2 = nextArg;
        i++;
        break;
      // Options
      case '--show-secret':
        args.showSecret = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Shamir Share Verification CLI

SECURITY: This tool handles sensitive cryptographic material.
          Never run where terminal output is logged.

Usage:
  npx ts-node scripts/shamir-verify.ts [options]

Cloud Mode (recommended):
  --aws-param <name>        AWS SSM parameter name containing Share 1
  --aws-region <region>     AWS region (default: us-east-1)
  --gcp-project <id>        GCP project ID containing Share 2
  --gcp-secret <id>         GCP secret ID containing Share 2

Raw Mode:
  -1, --share1 <value>      First Shamir share value
  -2, --share2 <value>      Second Shamir share value

Options:
  --show-secret             Display reconstructed secret (SECURITY RISK)
  -h, --help                Show this help message

Examples:
  # Verify shares from cloud providers (recommended)
  yarn shamir:verify \\
    --aws-param "/mark/config/web3_signer_private_key_share1" \\
    --gcp-project "everclear-prod" \\
    --gcp-secret "mark-web3-signer-pk-share2"

  # Verify raw share values
  yarn shamir:verify \\
    --share1 "801abc123..." \\
    --share2 "802def456..."

  # Show the reconstructed secret (use only in secure environment)
  yarn shamir:verify \\
    --aws-param "/mark/config/key_share1" \\
    --gcp-project "project" \\
    --gcp-secret "secret" \\
    --show-secret
`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
